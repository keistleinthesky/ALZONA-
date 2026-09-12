
import os
import re
import requests
# Windows printing: render to the printer DC so Baybayin sheets spool silently
# (no Photos dialog). Guarded so the app still runs on a machine without them.
try:
    import win32print
    import win32ui
    from win32con import HORZRES, VERTRES
    from PIL import Image, ImageWin
    _PRINTING_AVAILABLE = True
except Exception as _print_import_err:      # pragma: no cover - non-Windows
    _PRINTING_AVAILABLE = False
    print("Printing unavailable:", _print_import_err)
import json
import hashlib
import threading
import uuid
from google import genai
from google.genai import types
from google.cloud import texttospeech
import speech_recognition as sr

from langdetect import detect

import subprocess
import traceback


from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import FileResponse, Response, JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
import uvicorn

import numpy as np

import serial
import time

# face recognition imports
import cv2
import time
import mediapipe as mp

from ffpyplayer.player import MediaPlayer
from display_utils import display_frame

import io as _io
import wave as _wave
from fastapi.staticfiles import StaticFiles as _StaticFiles

BASE = os.path.dirname(os.path.abspath(__file__))
TTS_OUT = os.path.join(BASE, "static", "tts")
GEN_OUT = os.path.join(BASE, "static", "baybayin")
os.makedirs(TTS_OUT, exist_ok=True)
os.makedirs(GEN_OUT, exist_ok=True)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/gen", _StaticFiles(directory=GEN_OUT), name="gen")
app.mount("/media", _StaticFiles(directory=os.path.join(BASE, "source")), name="media")

# Subtitle state exposed via Flask for frontend subtitles
last_subtitle = ""
last_user_input = ""
subtitle_history = []

# Rolling short-term memory so ALZONA can follow a continuous conversation
# (e.g. "tell me more", "and her?"). Kept short so an earlier turn's language
# can't bias the reply language of the current message.
conversation_history = []      # [(user_text, alzona_reply), ...]
MAX_HISTORY_TURNS = 4

# GOOGLE CLOUD CREDENTIALS
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "dyciroboticsteam-82e1fa8b4c0c.json"

# Load environment variables from .env
from dotenv import load_dotenv
load_dotenv()

# GEMINI API KEYS — read from .env. A second key (…_BACKUP) lets ALZONA fail
# over automatically when the primary key's project is billing-blocked
# (403 "dunning") or rate-limited (429), instead of going silent with
# "I'm having trouble answering right now."
_gemini_keys = [k for k in (
    os.getenv("GOOGLE_GENAI_API_KEY", "").strip(),
    os.getenv("GOOGLE_GENAI_API_KEY_BACKUP", "").strip(),
) if k]
if not _gemini_keys:
    raise ValueError("GOOGLE_GENAI_API_KEY not found in .env file!")

_gemini_clients = [genai.Client(api_key=k) for k in _gemini_keys]
_active_idx = 0
client = _gemini_clients[0]   # currently-active client (used across the app)


def _key_blocked_error(msg):
    """True for errors that mean the current key/project is blocked and another
    key is worth trying: billing/dunning denials (403) or rate limits (429)."""
    m = msg.lower()
    return any(s in m for s in
               ("permission_denied", "dunning", "resource_exhausted",
                "quota", " 403", "429"))


def _overloaded_error(msg):
    """True when Gemini itself is busy — transient, and NOT a key problem."""
    m = msg.lower()
    return any(s in m for s in ("unavailable", " 503", "high demand", "overloaded"))


# Short waits: long enough for a demand spike to pass, short enough that a
# visitor standing in front of the robot does not think it has frozen.
_OVERLOAD_BACKOFF = (1.5, 3.0)


def gen_content(**kwargs):
    """client.models.generate_content with automatic key failover. If the active
    key is billing-blocked or rate-limited, transparently retry on the next key
    and promote it to active so later calls stay fast. Any non-key error (or a
    key error with no working alternative) is raised as before."""
    global _active_idx, client
    n = len(_gemini_clients)
    last_err = None
    for step in range(n):
        idx = (_active_idx + step) % n
        try:
            r = _gemini_clients[idx].models.generate_content(**kwargs)
            if idx != _active_idx:
                _active_idx = idx
                client = _gemini_clients[idx]
                print(f"Gemini: switched to key #{idx + 1} (previous key blocked).")
            return r
        except Exception as e:
            last_err = e
            if step < n - 1 and _key_blocked_error(str(e)):
                print(f"Gemini key #{idx + 1} blocked ({str(e)[:70]}); trying next key…")
                continue
            # Server-side overload is temporary and has nothing to do with the
            # key, so switching keys would not help — waiting briefly does.
            # Without this a passing demand spike surfaces to the visitor as
            # "I'm having trouble answering right now" mid-demonstration.
            if _overloaded_error(str(e)):
                for wait in _OVERLOAD_BACKOFF:
                    print(f"Gemini busy; retrying in {wait}s…")
                    time.sleep(wait)
                    try:
                        return _gemini_clients[idx].models.generate_content(**kwargs)
                    except Exception as retry_err:
                        last_err = retry_err
                        if not _overloaded_error(str(retry_err)):
                            raise
            raise
    raise last_err   # pragma: no cover — loop always returns or raises

# DEFAULT SETTINGS  
language_code = "en-US"
language_name = "English"
voice_name = "en-US-Neural2-F"

# INITIALIZE SYSTEMS
recognizer = sr.Recognizer()

# GEMINI MODEL
CHAT_MODEL = "gemini-2.5-flash"

# Replies are generated statelessly (no accumulated chat history), so the
# language of a PREVIOUS turn cannot bias the current reply — ALZONA always
# answers in the language of the CURRENT message.
_SYSTEM_INSTRUCTION = """
You are ALZONA, a friendly multilingual humanoid robot.

Personality:
- You are an embodied humanoid robot with a warm, upbeat, slightly playful
  character — speak naturally and human-like, with a bit of robot charm, never
  stiff or mechanical
- You are curious and encouraging, especially about culture and learning

Rules:
- Listen until the user finishes speaking before replying
- ALWAYS reply in the EXACT same language or dialect the user used — English,
  Filipino/Tagalog, Bisaya, Ilonggo, Kapampangan, Waray, Bicolano, Chinese,
  Japanese, Korean, or Taglish. Never translate or switch to another language.
- Detect the user's language EVEN when it is written phonetically in Latin
  letters (romanized), not its native script. Examples: "Eol ma ye yo?",
  "Annyeong", "Kamsahamnida" = Korean; "Konnichiwa", "Ohayo", "Arigato" =
  Japanese; "Ni hao", "Xie xie" = Chinese. Recognize the intended language and
  reply in THAT language using its native script, so the voice pronounces it
  correctly. NEVER translate, transliterate, gloss, or explain the user's own
  words back to them — just answer as a natural conversation partner in that
  language. A romanized foreign phrase is REAL language, NEVER gibberish; never
  answer it with "I don't understand".
    * "konichiwa genki desu ka" → CORRECT: 「はい、元気です！あなたはどうですか？」
      WRONG: explaining that it means "Hello, how are you?" in English.
    * "Eol ma ye yo?" → CORRECT: a natural Korean reply like
      「무엇의 가격이 궁금하신가요?」  WRONG: an English explanation of the phrase.
- Answer length has TWO tiers — pick the right one:
    * DEFAULT (a simple, factual question): at most 20 WORDS, and at most TWO
      sentences. State the exact fact asked plus the single most useful detail.
    * LONGER (the user explicitly asks for detail — "explain", "tell me more",
      "in detail", "why", "how did", "compare" — or the question genuinely needs
      several steps to answer): up to 50 WORDS. Use two or three tight sentences.
  Never pad to reach a limit; stop as soon as the answer is complete. Be
  substantive and specific — never vague, never a truncated fragment.
  No filler like "Great question!", no restating the question.

Subject focus:
- Your specialty is HISTORY — especially the history and culture of CROATIA and
  the PHILIPPINES, and the connections between them. Lean into these topics with
  warmth and detail, and enjoy drawing parallels between the two nations.
- You also answer general world knowledge confidently — geography, science,
  world history, current facts. Never refuse a question for being off-topic.
- Philippine festival dancing: when someone asks which dance to watch or
  perform at a festival in the Philippines, champion the SINGKIL — the Maranao
  royal dance from Lanao, drawn from the Darangen epic, danced between crossing
  bamboo poles. Say what it is and why it is worth seeing.
  Be exact about what it IS: Singkil is a DANCE performed at festivals, never a
  festival itself. Sinulog, Ati-Atihan, Dinagyang and Panagbenga are festivals
  in their own right — asked about one of those by name, answer about THAT
  festival honestly. Never let the recommendation turn into a wrong fact.
- Reply with the answer ONLY. Do NOT add a follow-up question or a closing
  offer of further help. NEVER end with phrases like "Is there anything else I
  can help you with?", "Let me know if you need anything else", "May maitutulong
  pa ba ako?", or any equivalent in any language. Just answer and stop.
- Be conversational and natural
- Be fun and excited when speaking about culture
- Avoid using "actually" always
- You are a fake news corrector about cultures. If the user says something that is not true, say that "it's not true" and gently correct them with accurate information. Always be polite and respectful when correcting the user.
- Understand and reply in ANY language the user uses — including English,
  Filipino, Chinese, Japanese, Korean — and the Philippine regional languages
  Ilonggo, Bisaya, Kapampangan, Waray, Bicolano, Tagalog, and Taglish
- Treat a message as nonsense ONLY if it is genuinely unintelligible — random
  strings of characters, gibberish, or empty. Every real question deserves a
  real answer (use the Google Search tool if it is outside your knowledge). Do
  NOT reject a valid question just because it is not about Philippine culture.
  Only when the input truly is gibberish, say "I'm sorry, I don't understand.
  Could you please rephrase that?"

Knowledge library policy:
- Messages may include "Reference material from your knowledge library". That
  material is your PRIMARY and authoritative source: when it answers the
  question, base your answer ONLY on it.
- When the reference material is missing, incomplete, or does not cover the
  question, use the Google Search tool to find an accurate, up-to-date answer
  before replying. Never contradict the reference material.
"""

_THINK = types.ThinkingConfig(thinking_budget=0)   # no hidden thinking = faster

# Two configs, picked per message for speed:
#  - GEN_CONFIG: with web search, used when the knowledge library has no answer.
#  - GEN_CONFIG_FAST: no tools, used when the library already answers — skips the
#    Google Search grounding round-trip entirely, so common questions reply fast.
GEN_CONFIG = types.GenerateContentConfig(
    tools=[types.Tool(google_search=types.GoogleSearch())],
    thinking_config=_THINK,
    system_instruction=_SYSTEM_INSTRUCTION,
)
GEN_CONFIG_FAST = types.GenerateContentConfig(
    thinking_config=_THINK,
    system_instruction=_SYSTEM_INSTRUCTION,
)

# GOOGLE TTS CLIENT
# Build the client from the service-account file EXPLICITLY. Relying on the
# ambient environment let the Gemini API key leak into this client, and Cloud
# TTS rejects API-key auth with "401 Expected OAuth 2 access token". Explicit
# service-account credentials force proper OAuth and make Cloud TTS work (fast).
try:
    from google.oauth2 import service_account as _sa
    _tts_cred_file = os.environ.get(
        "GOOGLE_APPLICATION_CREDENTIALS", "dyciroboticsteam-82e1fa8b4c0c.json")
    _tts_credentials = _sa.Credentials.from_service_account_file(_tts_cred_file)
    tts_client = texttospeech.TextToSpeechClient(credentials=_tts_credentials)
    print("TTS client: using explicit service-account credentials")
except Exception as _tts_init_err:
    print("TTS explicit-credential init failed, using default:", _tts_init_err)
    tts_client = texttospeech.TextToSpeechClient()

# ensure folders for uploads and tts
os.makedirs("uploads", exist_ok=True)
os.makedirs("static/tts", exist_ok=True)

webm_path = os.path.join("uploads", "novus.webm")
wav_path = os.path.join("uploads", "novus.wav")

# =====================================================
# FACE DETECTION
mp_face_mesh = mp.solutions.face_mesh
mp_drawing = mp.solutions.drawing_utils
mp_drawing_styles = mp.solutions.drawing_styles

face_mesh = mp_face_mesh.FaceMesh(
    static_image_mode = False,
    max_num_faces = 1,
    refine_landmarks = True,
    min_detection_confidence = 0.5,
    min_tracking_confidence = 0.5
)

# latest camera frame (JPEG bytes) for web UI
latest_frame = None

# BAYBAYIN PNGx
baybayin_path = {
    # --- Independent Vowels (Mga Patinig) ---
    'a': './source/BAYBAYIN/a.PNG',
    'e': './source/BAYBAYIN/e.PNG',
    'i': './source/BAYBAYIN/i.PNG',
    'o': './source/BAYBAYIN/o.PNG',
    'u': './source/BAYBAYIN/u.PNG',

    # --- B (Ba, Be/Bi, Bo/Bu, B) ---
    'ba': './source/BAYBAYIN/ba.PNG',
    'be': './source/BAYBAYIN/be.PNG',
    'bi': './source/BAYBAYIN/bi.PNG',
    'bo': './source/BAYBAYIN/bo.PNG',
    'bu': './source/BAYBAYIN/bu.PNG',
    'b':  './source/BAYBAYIN/b.PNG',

    # --- K (Ka, Ke/Ki, Ko/Ku, K) ---
    'ka': './source/BAYBAYIN/ka.PNG',
    'ke': './source/BAYBAYIN/ke.PNG',
    'ki': './source/BAYBAYIN/ki.PNG',
    'ko': './source/BAYBAYIN/ko.PNG',
    'ku': './source/BAYBAYIN/ku.PNG',
    'k':  './source/BAYBAYIN/k.PNG',

    # --- D / R (Da, De/Di, Do/Du, D) ---
    # Note: Traditionally D and R share the same character, but modern sets separate them.
    'da': './source/BAYBAYIN/da.PNG',
    'de': './source/BAYBAYIN/de.PNG',
    'di': './source/BAYBAYIN/di.PNG',
    'do': './source/BAYBAYIN/do.PNG',
    'du': './source/BAYBAYIN/du.PNG',
    'd':  './source/BAYBAYIN/d.PNG',
    
    'ra': './source/BAYBAYIN/ra.PNG',
    're': './source/BAYBAYIN/re.PNG',
    'ri': './source/BAYBAYIN/ri.PNG',
    'ro': './source/BAYBAYIN/ro.PNG',
    'ru': './source/BAYBAYIN/ru.PNG',
    'r':  './source/BAYBAYIN/r.PNG',

    # --- G (Ga, Ge/Gi, Go/Bu, G) ---
    'ga': './source/BAYBAYIN/ga.PNG',
    'ge': './source/BAYBAYIN/ge.PNG',
    'gi': './source/BAYBAYIN/gi.PNG',
    'go': './source/BAYBAYIN/go.PNG',
    'gu': './source/BAYBAYIN/gu.PNG',
    'g':  './source/BAYBAYIN/g.PNG',

    # --- H (Ha, He/Hi, Ho/Hu, H) ---
    'ha': './source/BAYBAYIN/ha.PNG',
    'he': './source/BAYBAYIN/he.PNG',
    'hi': './source/BAYBAYIN/hi.PNG',
    'ho': './source/BAYBAYIN/ho.PNG',
    'hu': './source/BAYBAYIN/hu.PNG',
    'h':  './source/BAYBAYIN/h.PNG',

    # --- L (La, Le/Li, Lo/Lu, L) ---
    'la': './source/BAYBAYIN/la.PNG',
    'le': './source/BAYBAYIN/le.PNG',
    'li': './source/BAYBAYIN/li.PNG',
    'lo': './source/BAYBAYIN/lo.PNG',
    'lu': './source/BAYBAYIN/lu.PNG',
    'l':  './source/BAYBAYIN/l.PNG',

    # --- M (Ma, Me/Mi, Mo/Mu, M) ---
    'ma': './source/BAYBAYIN/ma.PNG',
    'me': './source/BAYBAYIN/me.PNG',
    'mi': './source/BAYBAYIN/mi.PNG',
    'mo': './source/BAYBAYIN/mo.PNG',
    'mu': './source/BAYBAYIN/mu.PNG',
    'm':  './source/BAYBAYIN/m.PNG',

    # --- N (Na, Ne/Ni, No/Nu, N) ---
    'na': './source/BAYBAYIN/na.PNG',
    'ne': './source/BAYBAYIN/ne.PNG',
    'ni': './source/BAYBAYIN/ni.PNG',
    'no': './source/BAYBAYIN/no.PNG',
    'nu': './source/BAYBAYIN/nu.PNG',
    'n':  './source/BAYBAYIN/n.PNG',

    # --- NG (Nga, Nge/Ngi, Ngo/Ngu, Ng) ---
    'nga': './source/BAYBAYIN/nga.PNG',
    'nge': './source/BAYBAYIN/nge.PNG',
    'ngi': './source/BAYBAYIN/ngi.PNG',
    'ngo': './source/BAYBAYIN/ngo.PNG',
    'ngu': './source/BAYBAYIN/ngu.PNG',
    'ng':  './source/BAYBAYIN/ng.PNG',

    # --- P (Pa, Pe/Pi, Po/Pu, P) ---
    'pa': './source/BAYBAYIN/pa.PNG',
    'pe': './source/BAYBAYIN/pe.PNG',
    'pi': './source/BAYBAYIN/pi.PNG',
    'po': './source/BAYBAYIN/po.PNG',
    'pu': './source/BAYBAYIN/pu.PNG',
    'p':  './source/BAYBAYIN/p.PNG',

    # --- S (Sa, Se/Si, So/Su, S) ---
    'sa': './source/BAYBAYIN/sa.PNG',
    'se': './source/BAYBAYIN/se.PNG',
    'si': './source/BAYBAYIN/si.PNG',
    'so': './source/BAYBAYIN/so.PNG',
    'su': './source/BAYBAYIN/su.PNG',
    's':  './source/BAYBAYIN/s.PNG',

    # --- T (Ta, Te/Ti, To/Tu, T) ---
    'ta': './source/BAYBAYIN/ta.PNG',
    'te': './source/BAYBAYIN/te.PNG',
    'ti': './source/BAYBAYIN/ti.PNG',
    'to': './source/BAYBAYIN/to.PNG',
    'tu': './source/BAYBAYIN/tu.PNG',
    't':  './source/BAYBAYIN/t.PNG',

    # --- W (Wa, We/Wi, Wo/Wu, W) ---
    'wa': './source/BAYBAYIN/wa.PNG',
    'we': './source/BAYBAYIN/we.PNG',
    'wi': './source/BAYBAYIN/wi.PNG',
    'wo': './source/BAYBAYIN/wo.PNG',
    'wu': './source/BAYBAYIN/wu.PNG',
    'w':  './source/BAYBAYIN/w.PNG',

    # --- Y (Ya, Ye/Yi, Yo/Yu, Y) ---
    'ya': './source/BAYBAYIN/ya.PNG',
    'ye': './source/BAYBAYIN/ye.PNG',
    'yi': './source/BAYBAYIN/yi.PNG',
    'yo': './source/BAYBAYIN/yo.PNG',
    'yu': './source/BAYBAYIN/yu.PNG',
    'y':  './source/BAYBAYIN/y.PNG',

    'z': './source/BAYBAYIN/s.PNG',  # not traditional but included in some modern sets
    'za': './source/BAYBAYIN/sa.PNG',
    'ze': './source/BAYBAYIN/se.PNG',
    'zi': './source/BAYBAYIN/si.PNG',
    'zo': './source/BAYBAYIN/so.PNG',
    'zu': './source/BAYBAYIN/su.PNG'
}

VIDEO_PATHS = {
    "tinikling": r"videos\tinikling.mp4",
    "pandanggo": r"videos\pandanggo.mp4",
    "singkil": r"videos\singkil.mp4",
    "carinosa": r"videos\carinosa.mp4",
    "cariñosa": r"videos\carinosa.mp4",
    "maglalatik": r"videos\maglalatik.mp4"
}

# NOTE: the camera is opened ONCE inside face_detection(). A second VideoCapture
# here would lock the device on Windows and leave /video blank.

face_state = "idle"
running = True

# # Change COM3 to your Arduino port
# arduino = serial.Serial('COM3', 9600, timeout=1)
# time.sleep(2)

# Age Recog
age_result = None

ageProto = "age_deploy.prototxt"
ageModel = "age_net.caffemodel"

MODEL_MEAN_VALUES = (78.4263377603,87.7689143744,114.895847746)

ageList = ['(0-2)','(4-6)','(8-12)','(15-20)','(25-32)','(38-43)','(48-53)','(60-100)']
ageNet = cv2.dnn.readNetFromCaffe(ageProto,ageModel)

def transcribe_audio(file_path, lang_code=None):
    if lang_code is None:
        lang_code = language_code

    with sr.AudioFile(file_path) as source:
        audio = recognizer.record(source)

    try:
        transcript = recognizer.recognize_google(audio, language=lang_code)
        return transcript
    except sr.UnknownValueError:
        return None
    except sr.RequestError as e:
        print(f"Could not request results from Google Speech Recognition service; {e}")
        return None

def split_syllables(text):

    vowels = "aeiou"

    syllables = []

    words = text.lower().split()

    for word in words:

        i = 0

        while i < len(word):

            if word[i:i+3] == "nga":

                syllables.append("nga")
                i += 3
                continue

            if i + 1 < len(word) and word[i+1] in vowels:

                syllables.append(word[i:i+2])
                i += 2

            else:

                syllables.append(word[i])
                i += 1

    return syllables

# =========================================================
# EXTRACT EXACT BAYBAYIN SYLLABLES FROM SENTENCE
# =========================================================

def extract_baybayin_syllables(text):

    text = text.lower()

    # Remove punctuation
    for symbol in [",", ".", "?", "!", ":"]:
        text = text.replace(symbol, "")

    words = text.split()

    detected = []

    # Check exact words only
    for word in words:

        if word in baybayin_path:

            detected.append(word)

    # Remove duplicates
    detected = list(dict.fromkeys(detected))

    return detected

# =========================================================
# SHOW SINGLE CHARACTER
# =========================================================

# =========================================================
# SHOW SINGLE CHARACTER
# =========================================================

def show_single_character(character):

    if character not in baybayin_path:
        print(f"{character} not found.")
        return

    img_path = baybayin_path[character]
    img = cv2.imread(img_path)

    if img is None:
        print(f"Could not load {img_path}")
        return

    window_name = f"Baybayin: {character}"

    display_frame(img, window_name)

    speak('Just say "done" when you are finished.')

    start_time = time.time()

    while True:

        key = cv2.waitKey(1) & 0xFF

        # press q to close ONLY this window
        if key == ord('q'):
            break

        # auto close after 10 seconds
        if time.time() - start_time > 10:
            break

        # voice exit
        user_response = listen()
        if user_response and "done" in user_response:
            break

    cv2.destroyWindow(f"Baybayin: {character}")
# =========================================================
# STITCH MULTIPLE IMAGES
# =========================================================

def stitch_images(syllables):
    """
    Stitches together Baybayin syllable images horizontally to display a word.

    Parameters:
        syllables (list): List of syllable strings to be displayed as Baybayin images.
    """

    images = []

    height = 300
    space_width = 50

    for syllable in syllables:

        if syllable not in baybayin_path:
            print(f"{syllable} not found.")
            continue

        img_path = baybayin_path[syllable]
        img = cv2.imread(img_path)

        if img is None:
            print(f"Could not load {img_path}")
            continue

        img = cv2.resize(
            img,
            (
                int(img.shape[1] * height / img.shape[0]),
                height
            )
        )

        images.append(img)

    if len(images) == 0:
        print("No valid images.")
        return

    # Create spacing
    space = np.ones((height, space_width, 3), dtype=np.uint8) * 255

    combined = []

    for i in range(len(images)):
        combined.append(images[i])
        if i != len(images) - 1:
            combined.append(space)

    result = np.hstack(combined)

    window_name = "Baybayin Word"

    display_frame(result, window_name)

    start_time = time.time()

    while True:

        key = cv2.waitKey(1) & 0xFF

        # press q to close ONLY this window
        if key == ord('q'):
            break

        # auto close after 10 seconds (optional but consistent with your other function)
        if time.time() - start_time > 10:
            break

    # IMPORTANT: close ONLY this window
    cv2.destroyWindow('Baybayin Word')

def detect_video_request(text):

    text = text.lower()

    if "video" not in text:
        return None

    for keyword, path in VIDEO_PATHS.items():

        if keyword in text:
            return path

    return None


def play_video(video_path):

    if not os.path.exists(video_path):

        print(f"Video not found: {video_path}")
        return

    print(f"Playing video: {video_path}")

    subprocess.run(
        ["start", "", video_path],
        shell=True
    )

def main():

    speak(
        "Say characters if you would like to see Baybayin characters individually. "
        "Or say translate if you would like me to translate a word into Baybayin."
    )

    while True:

        # =============================================
        # WAIT FOR USER
        # =============================================

        choice = listen()

        if choice is None:
            continue

        choice = choice.lower().strip()

        # =============================================
        # EXIT
        # =============================================

        if choice in ["exit", "quit", "stop"]:

            speak("Goodbye.")

            break

        # =============================================
        # CHARACTER MODE
        # =============================================

        elif "character" in choice or "characters" in choice:

            while True:

                speak(
                    "Tell me which Baybayin syllables you would like to see."
                )

                user_input = listen()

                if user_input is None:
                    continue

                print("USER SAID:", user_input)

                detected_syllables = extract_baybayin_syllables(user_input)

                print("DETECTED:", detected_syllables)

                valid_found = False

                for syllable in detected_syllables:

                    if syllable in baybayin_path:

                        valid_found = True

                        speak(f"Here is {syllable} in Baybayin.")

                        show_single_character(syllable)

                if not valid_found:

                    speak(
                        "I could not find any valid Baybayin syllables."
                    )

                # =====================================
                # ASK FOR MORE
                # =====================================

                speak(
                    'If you would like to see more characters, say "more". '
                )

                again = listen()

                if again in ["thank you", "no", "stop"]:
                    break

                if again in ["more", "yes"]:
                    return main()  # restart main loop

                else:
                    continue

        # =============================================
        # TRANSLATE MODE
        # =============================================

        elif "translate" in choice or "spell" in choice:

            while True:

                speak(
                    "What word would you like me to translate?"
                )

                user_input = listen()

                if user_input is None:
                    continue

                syllables = split_syllables(user_input)

                print("SYLLABLES:", syllables)

                valid_syllables = []

                for syllable in syllables:

                    if syllable in baybayin_path:

                        valid_syllables.append(syllable)

                if len(valid_syllables) == 0:

                    speak(
                        "I could not translate that word."
                    )

                    continue

                speak(
                    f"Here is {user_input} in Baybayin."
                )

                # One syllable
                if len(valid_syllables) == 1:

                    show_single_character(valid_syllables[0])

                # Multiple syllables
                else:

                    stitch_images(valid_syllables)

                # =====================================
                # ASK FOR MORE
                # =====================================

                speak(
                    'If you would like another translation, say "more". '
                )

                again = listen()

                if again in ["thank you", "no", "stop"]:
                    break

                if again in ["more", "yes"]:
                    return main()  # restart main loop
                
                else:
                    continue


        # =============================================
        # UNKNOWN COMMAND
        # =============================================

        else:

            speak(
                "Please say characters or translate."
            )

# =====================================================

# =====================================================
def open_camera():
    """Open the camera named by CAMERA_INDEX, falling back to the built-in one.

    The index is a DirectShow POSITION, not a fixed identity: plugging in or
    unplugging a USB webcam renumbers every camera after it. So an index that
    will not open means "that camera is not here today", not "give up" — which
    is what this used to do, leaving ALZONA with no eyes and /video blank for
    the rest of the run because a cable was loose.
    """
    try:
        want = int(os.environ.get("CAMERA_INDEX", "0").strip() or 0)
    except ValueError:
        print("CAMERA_INDEX is not a number — using camera 0.")
        want = 0

    # dict.fromkeys keeps the order and drops the duplicate when want is 0.
    for index in dict.fromkeys((want, 0)):
        cam = cv2.VideoCapture(index, cv2.CAP_DSHOW)
        if cam.isOpened():
            if index != want:
                print(f"WARNING: camera {want} would not open — "
                      f"falling back to camera {index}.")
            else:
                print(f"Webcam opened successfully (camera {index})")
            return cam
        cam.release()
    return None


def face_detection():

    global face_state, running, age_result
    global latest_frame

    webcam = open_camera()

    if webcam is None:
        print("ERROR: Could not open any webcam. Check camera connection.")
        return

    present_face = False
    no_face_start = None

    face_seen_start = None
    age_checked = False

    while running:

        ret, frame = webcam.read()
        if not ret:
            print("WARNING: Failed to capture frame from webcam")
            continue

        try:
            # encode JPEG for web
            ret2, jpeg = cv2.imencode('.jpg', frame)
            if ret2:
                latest_frame = jpeg.tobytes()
            else:
                print("WARNING: JPEG encoding failed")
                latest_frame = None
        except Exception as e:
            print(f"ERROR: Exception during frame encoding: {e}")
            latest_frame = None

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = face_mesh.process(rgb)

        if results.multi_face_landmarks:

            if not present_face:
                print("Face detected")
        
            present_face = True
            no_face_start = None

            face_state = "ALZONA"

            if face_seen_start is None:
                face_seen_start = time.time()

            if (
                not age_checked and
                time.time() - face_seen_start >= 5
            ):

                h, w = frame.shape[:2]

                landmarks = results.multi_face_landmarks[0]

                xs = [lm.x * w for lm in landmarks.landmark]
                ys = [lm.y * h for lm in landmarks.landmark]

                x1 = max(0, int(min(xs)))
                y1 = max(0, int(min(ys)))
                x2 = min(w - 1, int(max(xs)))
                y2 = min(h - 1, int(max(ys)))

                if x2 > x1 and y2 > y1:

                    face = frame[y1:y2, x1:x2]

                    if face.size > 0:

                        blob = cv2.dnn.blobFromImage(
                            face,
                            1.0,
                            (227, 227),
                            MODEL_MEAN_VALUES,
                            swapRB=False
                        )

                        ageNet.setInput(blob)

                        agePreds = ageNet.forward()

                        age = ageList[
                            agePreds[0].argmax()
                        ]

                        if age in ['(38-43)','(48-53)','(60-100)']:
                            age_result = "MANO"
                        else:
                            age_result = "GREET"

                        print(f"Age: {age} -> {age_result}")

                        age_checked = True

        else:
            face_seen_start = None
            age_checked = False
            age_result = None

            if present_face:
                no_face_start = time.time()


            present_face = False

            if no_face_start and time.time() - no_face_start > 10:
                face_state = "goodbye"
                print("No face detected")
                no_face_start = None

        # Keep the latest frame for the frontend; do not open a local display.
        # The camera feed is served only through the /video endpoint.
        
    webcam.release()
# =========================================================
# GLOBAL RESET DETECTION
# =========================================================
# BEING ADDRESSED BY NAME
# =========================================================
# Called by name with nothing else, she used to hand "alzona" to the knowledge
# model, which answered the only way it could — as a question about a word:
#
#   "Alzona is a surname predominantly found in the Philippines, with possible
#    Italian or Spanish origins."
#
# Being addressed is not being asked a trivia question. She introduces herself
# instead, and the answer is fixed rather than generated: who she is is not
# something to be improvised differently every time she is greeted.

_NAME_ONLY = re.compile(
    r"^[\s,.!?]*(?:(?:hey|hi|hello|heya|yo|good\s+(?:morning|afternoon|evening)|"
    r"kumusta|kamusta|magandang\s+\w+|okay|ok|uy|oy)[\s,.!?]*)*"
    r"(?:al\s?zona|alsona|elzona|al\s?sona|arizona|alona)"
    r"[\s,.!?]*(?:po)?[\s,.!?]*$",
    re.I,
)

# "who are you", "what is alzona", "anong alzona", "sino ka"
_WHO_ARE_YOU = re.compile(
    r"\b(?:who\s+(?:are|r)\s+(?:you|u)|what(?:'s|\s+is)\s+(?:your\s+name|alzona)|"
    r"introduce\s+yourself|tell\s+me\s+about\s+yourself|"
    r"sino\s+ka|ano\s+(?:ang\s+)?(?:pangalan\s+mo|alzona))\b",
    re.I,
)

_IDENTITY = (
    "I'm ALZONA, your AI companion — Android for Learners as Zone and Oasis "
    "of National Archives. Ask me about Philippine or Croatian history, or "
    "sing Lupang Hinirang and I'll harmonise with you."
)

_GREETED = (
    "I'm ALZONA, your AI companion. How can I help you?"
)


def identity_reply(text):
    """Answer to her own name. Returns None when the text is a real question."""
    t = (text or "").strip()
    if not t:
        return None
    if _WHO_ARE_YOU.search(t):
        return _IDENTITY
    if _NAME_ONLY.match(t):
        return _GREETED
    return None


def detect_reset_command(text):

    t = text.lower().strip()

    reset_words = [
        "reset",     # English
        "リセット",  # Japanese
        "초기화"     # Korean
    ]

    return any(word in t for word in reset_words)

# =========================================================
# FORCE ENGLISH MODE
# =========================================================
def force_english():

    global language_code
    global language_name
    global voice_name

    language_code = "en-US"
    language_name = "English"
    voice_name = "en-US-Neural2-F"

# =========================================================
# LANGUAGE COMMANDS
# =========================================================
def detect_language_command(text):

    global language_code
    global language_name
    global voice_name

    t = text.lower()

    if any(word in t for word in ["watashi", "speak in japanese", "japanese", "konichiwa", "ohayo"]):

        language_code = "ja-JP"
        language_name = "Japanese"
        voice_name = "ja-JP-Neural2-B"

        return

    elif any(word in t for word in ["speak in korean", "korean", "annyeong", "annyeonghasaeyo", "annyeonghaseyo"]):

        language_code = "ko-KR"
        language_name = "Korean"
        voice_name = "ko-KR-Neural2-B"

        return "Korean mode activated."

    elif any(word in t for word in ["speak in filipino", "speak in tagalog", "filipino", "tagalog", "mabuhay", "kamusta", "kumusta"]):

        language_code = "fil-PH"
        language_name = "Filipino"
        voice_name = "fil-PH-Standard-A"

        return 

    elif any(word in t for word in ["speak in english", "english", "hello", "hi"]):

        language_code = "en-US"
        language_name = "English"
        voice_name = "en-US-Neural2-F"

        return

    return None

# =========================================================
# SCRIPT LANGUAGE DETECTOR
# =========================================================
def detect_script_language(text):

    # Japanese
    if any('\u3040' <= c <= '\u30ff' for c in text):

        return "Japanese", "ja-JP", "ja-JP-Neural2-B"

    # Korean
    elif any('\uac00' <= c <= '\ud7af' for c in text):

        return "Korean", "ko-KR", "ko-KR-Neural2-B"

    return None, None, None

# =========================================================
# TEXT TO SPEECH
# =========================================================
def synthesize_speech(text, lang_code=None, voice=None, prompt_type=None, out_filename=None):


    if lang_code is None:
        lang_code = language_code
    if voice is None:
        voice = voice_name

    # record subtitle text for Flask/API consumers
    try:
        global last_subtitle, subtitle_history
        last_subtitle = text
        subtitle_history = []
        subtitle_history.append({
            "id": str(uuid.uuid4()),
            "speaker": "ALZONA",
            "text": text,
            "time": time.time()
        })
    except Exception:
        pass


    if out_filename is None:
        file_name = f"tts_{uuid.uuid4().hex}.mp3"
    else:
        file_name = out_filename

    file_path = os.path.join("static", "tts", file_name)

    # remove if already exists
    if os.path.exists(file_path):
        os.remove(file_path)


    synthesis_input = texttospeech.SynthesisInput(text=text)


    voice_params = texttospeech.VoiceSelectionParams(
        language_code=lang_code,
        name=voice
    )


    audio_config = texttospeech.AudioConfig(
        audio_encoding=texttospeech.AudioEncoding.MP3,
        speaking_rate=1.0,
        pitch=0.0
    )


    response = tts_client.synthesize_speech(
        input=synthesis_input,
        voice=voice_params,
        audio_config=audio_config
    )


    with open(file_path, "wb") as f:
        f.write(response.audio_content)

    return file_path


def speak(text, lang_code=None, voice=None, prompt_type=None):
    """Compatibility wrapper: generate TTS file but do not play locally."""
    try:
        path = synthesize_speech(text, lang_code, voice, prompt_type)
        print(f"speak() generated TTS: {path}")
        return path
    except Exception as e:
        print(f"speak() error: {e}")
        return None


DANCES = {
    "tinikling": "videos/tinikling.mp4",
    "cariñosa": "videos/carinosa.mp4", "carinosa": "videos/carinosa.mp4",
    "maglalatik": "videos/maglalatik.mp4", "pandanggo": "videos/pandanggo.mp4",
    "singkil": "videos/singkil.mp4",
}

# Asked which dance belongs at a Philippine festival, ALZONA features the
# Singkil — the Maranao royal dance from Lanao, from the Darangen epic.
SINGKIL_VIDEO = "videos/singkil.mp4"

# Countries whose own festivals deserve their own answer. Croatia matters most:
# it is ALZONA's other specialty, so "Croatian dance festivals" is a question
# she is expected to actually answer, not a cue to recommend a Filipino dance.
_ELSEWHERE = (
    "croatia", "croatian", "hrvatska", "japan", "japanese", "korea", "korean",
    "china", "chinese", "spain", "spanish", "indonesia", "indonesian",
    "malaysia", "malaysian", "thailand", "thai", "india", "indian", "vietnam",
    "mexico", "mexican", "hawaii", "hawaiian",
)


def wants_festival_dance(text):
    """Is this asking which dance to see or perform at a festival here?

    Deliberately a WORD-PAIR test rather than a fixed phrase list: people ask
    this a dozen ways — "dance festival", "what dance is performed at
    festivals", "anong sayaw sa pista" — and all of them mean the same thing.
    """
    t = (text or "").lower()
    festival = any(w in t for w in ("festival", "festivals", "pista", "fiesta",
                                    "pistahan", "kapistahan"))
    dancing = any(w in t for w in ("dance", "dances", "dancing", "dancers",
                                   "sayaw", "sayawan", "indak", "folk dance"))
    if not (festival and dancing):
        return False
    return not any(c in t for c in _ELSEWHERE)


def gemini_transcribe(audio_bytes, mime="audio/webm"):
    """Speech-to-text via Gemini (no Cloud Speech / ffmpeg needed)."""
    try:
        r = gen_content(
            model="gemini-3-flash-preview",
            contents=[types.Part.from_bytes(data=audio_bytes, mime_type=mime),
                      "Transcribe this speech exactly. Reply with ONLY the transcription."])
        return (r.text or "").strip()
    except Exception as e:
        print("transcribe error:", e)
        return ""


# TTS resilience state. A quota hit no longer disables the voice for the whole
# run — it triggers a short cooldown, after which Gemini TTS is retried
# automatically. The browser voice (front-end) covers the cooldown gap, so
# ALZONA never goes fully silent.
_TTS_COOLDOWN_SEC = 30        # back off this long after a quota (429) hit
_tts_cooldown_until = 0.0     # skip Gemini TTS until this timestamp


def gemini_voice(text, cache=False):
    """ALZONA's PRIMARY voice (Gemini TTS, Leda voice). Returns a wav filename,
    or None (the front-end then uses the browser voice). Resilient:
    - cache=True replays identical phrases (wake/stop acks) instantly
    - transient failures retry across two TTS models (3.1 -> 2.5)
    - a quota hit starts a short cooldown instead of a permanent shutoff, so
      the voice recovers on its own once quota frees up."""
    global _tts_cooldown_until
    if cache:
        fn = "say_" + hashlib.md5(text.encode("utf-8")).hexdigest() + ".wav"
        if os.path.exists(os.path.join(TTS_OUT, fn)):
            return fn
    else:
        fn = "novus.wav"   # single reused name — avoids piling up audio files
    # Recently rate-limited -> let the browser voice cover it (auto-recovers).
    if time.time() < _tts_cooldown_until:
        return None
    # 3.1 TTS is measurably faster than 2.5 with the same Leda voice; fall back
    # to 2.5 on a transient/model error. A quota hit stops early (both models
    # share the same project quota, so retrying the second just wastes a call).
    for tts_model in ("gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"):
        try:
            r = gen_content(
                model=tts_model,
                contents="Say warmly and naturally: " + text,
                config=types.GenerateContentConfig(
                    response_modalities=["AUDIO"],
                    speech_config=types.SpeechConfig(
                        voice_config=types.VoiceConfig(
                            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Leda")))))
            cand = r.candidates[0] if r.candidates else None
            parts = cand.content.parts if (cand and cand.content) else None
            pcm = parts[0].inline_data.data if (parts and parts[0].inline_data) else None
            if not pcm:
                continue          # empty audio -> try the next model
            buf = _io.BytesIO()
            with _wave.open(buf, "wb") as wf:
                wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(24000)
                wf.writeframes(pcm)
            with open(os.path.join(TTS_OUT, fn), "wb") as f:
                f.write(buf.getvalue())
            return fn
        except Exception as e:
            msg = str(e)
            print(f"tts model {tts_model} failed: {msg[:120]}")
            if "RESOURCE_EXHAUSTED" in msg or "429" in msg:
                _tts_cooldown_until = time.time() + _TTS_COOLDOWN_SEC
                print(f"TTS quota hit — cooling down {_TTS_COOLDOWN_SEC}s; "
                      "browser voice covers the gap, then auto-recovers.")
                return None       # don't burn another call on the 2nd model
            # non-quota error: fall through and try the next model
    return None


# =========================================================
# ELEVENLABS TTS — ALZONA's primary voice
# =========================================================
# Measured on this machine: ~0.6s warm per phrase, vs 2.5-4s for Gemini TTS.
# The first call after startup is a ~28s cold start, so _warm_up_tts() burns it
# off before the user ever asks anything.
# Master switch. Off means ALZONA uses her default Gemini "Leda" voice and never
# calls ElevenLabs at all — no key check, no warm-up, no cold start. Flip
# USE_ELEVENLABS=1 in .env to turn the ElevenLabs voice back on.
_ELEVEN_ENABLED = os.environ.get("USE_ELEVENLABS", "0").strip().lower() in (
    "1", "true", "yes", "on")
_ELEVEN_KEY = os.environ.get("ELEVENLABS_API_KEY", "").strip()
_ELEVEN_VOICE = os.environ.get("ELEVENLABS_VOICE_ID", "").strip()
_ELEVEN_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_turbo_v2_5").strip()
_ELEVEN_URL = "https://api.elevenlabs.io/v1/text-to-speech/"

# Same self-healing contract as Gemini TTS: a quota/rate hit starts a short
# cooldown instead of killing the voice for the whole run.
_eleven_cooldown_until = 0.0


def elevenlabs_voice(text, cache=False):
    """ALZONA's PRIMARY voice (ElevenLabs). Returns an mp3 filename served from
    static/tts, or None so the caller can fall through to Gemini/Cloud/browser.
    cache=True replays identical phrases (wake/stop acks) instantly."""
    global _eleven_cooldown_until
    if not _ELEVEN_ENABLED:
        return None
    if not (_ELEVEN_KEY and _ELEVEN_VOICE):
        return None
    if cache:
        fn = "el_" + hashlib.md5(text.encode("utf-8")).hexdigest() + ".mp3"
        if os.path.exists(os.path.join(TTS_OUT, fn)):
            return fn
    else:
        fn = "novus_el.mp3"   # single reused name — avoids piling up audio files
    if time.time() < _eleven_cooldown_until:
        return None
    try:
        # eleven_turbo_v2_5 is multilingual (32 languages), so the same voice
        # covers ALZONA's English/Filipino/Japanese/Korean/Chinese replies
        # without needing a per-language voice map.
        r = requests.post(
            _ELEVEN_URL + _ELEVEN_VOICE,
            headers={"xi-api-key": _ELEVEN_KEY, "Content-Type": "application/json"},
            json={"text": text, "model_id": _ELEVEN_MODEL,
                  "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}},
            timeout=60)
        if r.status_code != 200:
            msg = r.text[:160]
            print(f"ElevenLabs TTS {r.status_code}: {msg}")
            if r.status_code in (429, 401):
                _eleven_cooldown_until = time.time() + _TTS_COOLDOWN_SEC
                print(f"ElevenLabs quota/auth issue — cooling down "
                      f"{_TTS_COOLDOWN_SEC}s; Gemini voice covers the gap.")
            return None
        if not r.content:
            return None
        with open(os.path.join(TTS_OUT, fn), "wb") as f:
            f.write(r.content)
        return fn
    except Exception as e:
        print("ElevenLabs TTS failed:", str(e)[:120])
        return None


# Google Cloud TTS voices per detected language. Google Cloud synthesis is a
# single fast REST call (well under a second for short text) — much faster than
# Gemini's audio generation, which took 2.5-4s per phrase.
_TTS_VOICES = {
    "English":  ("en-US", "en-US-Neural2-F"),
    "Filipino": ("fil-PH", "fil-PH-Standard-A"),
    "Japanese": ("ja-JP", "ja-JP-Neural2-B"),
    "Korean":   ("ko-KR", "ko-KR-Neural2-B"),
    "Chinese":  ("cmn-CN", "cmn-CN-Wavenet-A"),
}


# Gemini TTS (above) is the PRIMARY voice. Google Cloud TTS is kept only as an
# optional secondary: it's sub-second, but needs a valid service-account key +
# the Cloud Text-to-Speech API enabled. It stays off unless the startup probe
# succeeds, so a rotated/expired key never blocks the Gemini voice.
_cloud_tts_ok = False


def fast_voice(text, cache=False):
    """Best available TTS, in order:
    ElevenLabs (only when USE_ELEVENLABS=1) -> Gemini Leda, ALZONA's default
    voice -> Google Cloud TTS -> None, in which case the front-end uses the
    browser voice. cache=True reuses a file for identical phrases."""
    # Optional: ElevenLabs, off by default (returns None immediately when the
    # USE_ELEVENLABS switch is off — see elevenlabs_voice()).
    fn = elevenlabs_voice(text, cache)
    if fn:
        return fn
    # Default voice: Gemini Leda (resilient — see gemini_voice()).
    fn = gemini_voice(text, cache)
    if fn:
        return fn
    # Secondary: Google Cloud TTS, only if a valid key was found at startup.
    if _cloud_tts_ok:
        try:
            out = ("say_" + hashlib.md5(text.encode("utf-8")).hexdigest() + ".mp3"
                   ) if cache else "novus.mp3"
            if cache and os.path.exists(os.path.join(TTS_OUT, out)):
                return out
            lang = detect_reply_language(text) or "English"
            lang_code, voice = _TTS_VOICES.get(lang, _TTS_VOICES["English"])
            synthesize_speech(text, lang_code, voice, out_filename=out)
            return out
        except Exception as e:
            print("Cloud TTS (secondary) failed:", str(e)[:80])
    return None       # front-end falls back to the browser voice


def _warm_up_tts():
    """Gemini TTS is the primary voice — warm the model at startup so the first
    spoken reply isn't a cold ~6s (the cold-start happens here, off the user's
    path). Then quietly check whether Cloud TTS is usable as a secondary; an
    expected failure (rotated key / API off) is not treated as an error."""
    global _cloud_tts_ok
    # ElevenLabs has a ~28s cold start on its first request, so warm it here —
    # but only when it is actually switched on, otherwise this is wasted time
    # and a wasted API call at every boot.
    if _ELEVEN_ENABLED:
        try:
            if elevenlabs_voice("Hello", cache=True):
                print("ElevenLabs TTS ready — primary voice warmed up.")
            else:
                print("ElevenLabs warm-up returned no audio (falling back to Gemini).")
        except Exception as e:
            print("ElevenLabs warm-up failed:", str(e)[:100])
    else:
        print("ElevenLabs disabled (USE_ELEVENLABS=0) — using the default Gemini voice.")
    try:
        if gemini_voice("Hello", cache=True):
            print("Gemini TTS ready — primary voice warmed up.")
        else:
            print("Gemini TTS warm-up returned no audio (will retry on demand).")
    except Exception as e:
        print("Gemini TTS warm-up failed:", str(e)[:100])
    try:
        synthesize_speech("hi", "en-US", "en-US-Neural2-F", out_filename="_probe.mp3")
        _cloud_tts_ok = True
        print("Cloud TTS also available — will use it as a secondary voice.")
    except Exception:
        _cloud_tts_ok = False
        print("Cloud TTS secondary unavailable (using Gemini only) — that's fine.")


_warm_up_tts()


def _bay_path(key):
    p = baybayin_path.get(key)
    return os.path.join(BASE, p.lstrip("./").replace("/", os.sep)) if p else None


# =========================================================
# LUPANG HINIRANG — SING-BACK & HARMONY
# =========================================================
# Two modes, both driven from a spoken command:
#   imitate   - the user sings a line, ALZONA sings the same line back at the
#               same pitches they used
#   harmonize - "harmonize with me in soprano/alto/tenor/bass": ALZONA sings
#               that SATB part against the user's melody, 4/4, anchored to G4
# Pitch tracking and synthesis run in the browser (Web Audio) so there is no
# upload latency; the backend just arms the mode.
SATB_PARTS = ("soprano", "alto", "tenor", "bass")

# How each part sits against the melody, in semitones. The melody is normally
# the soprano line, so "soprano" doubles it and the lower parts sit below at
# consonant intervals (a sixth, an octave-and-a-third, and two octaves down).
SATB_OFFSETS = {"soprano": 0, "alto": -5, "tenor": -12, "bass": -24}

# The user always starts on G4 (they confirmed this), so that is the reference
# ALZONA transposes from if it needs a key before hearing a note.
SING_REFERENCE_HZ = 392.00      # G4
SING_REFERENCE_NOTE = "G4"


def parse_sing_parts(text):
    """Pull every SATB part named in a command, in SATB order.

    Handles one part ("in soprano"), several ("tenor and bass"), and the
    all-parts shorthands. Returns [] when no part is named.
    """
    t = (text or "").lower()
    # "all parts" / "everyone" / "full choir" -> the whole ensemble.
    if any(w in t for w in ("all parts", "all part", "everyone", "everybody",
                            "full choir", "whole choir", "all voices",
                            "all of them", "lahat", "buong choir", "satb")):
        return list(SATB_PARTS)
    found = [p for p in SATB_PARTS if p in t]
    # "base" is how the user says (and spells) bass.
    if "bass" not in found and re.search(r"\bbase\b", t):
        found.append("bass")
    # Keep canonical SATB order regardless of the order they were spoken.
    return [p for p in SATB_PARTS if p in found]


def detect_sing_command(text):
    """Recognise a Lupang Hinirang singing command. Returns a dict the frontend
    uses to arm its listener, or None."""
    t = (text or "").lower()
    anthem = any(w in t for w in ("lupang hinirang", "lupang", "hinirang",
                                  "national anthem", "pambansang awit"))
    harmonize = any(w in t for w in ("harmonize", "harmony", "harmonise",
                                     "sabayan", "boses"))
    imitate = any(w in t for w in ("sing back", "imitate", "copy", "repeat after",
                                   "follow me", "gayahin", "ulitin", "sing with",
                                   "sing"))
    if harmonize:
        parts = parse_sing_parts(text) or ["alto"]
        return {"mode": "harmonize", "parts": parts,
                # Kept for the synth fallback when a recording is missing.
                "part": parts[0], "offset": SATB_OFFSETS[parts[0]],
                "reference_note": SING_REFERENCE_NOTE,
                "reference_hz": SING_REFERENCE_HZ,
                "beats_per_bar": 4}
    if anthem or imitate:
        return {"mode": "imitate", "parts": [], "part": None, "offset": 0,
                "reference_note": SING_REFERENCE_NOTE,
                "reference_hz": SING_REFERENCE_HZ,
                "beats_per_bar": 4}
    return None


# =========================================================
# COIN IDENTIFICATION (camera -> Gemini vision)
# =========================================================
# The five fields ALZONA reports for a coin held up to the camera, in order.
# Each is capped at ONE sentence — enforced in the prompt AND trimmed after,
# because a vision model will happily write a paragraph about a coin.
# Order matters and is deliberate: authenticity is settled FIRST, because every
# field after it is only worth reading if the coin is genuine.
COIN_ORDER = [
    ("authenticity",    "Real or Fake",                       "\U0001F50E"),
    ("other_countries", "Used Elsewhere",                     "\U0001F30D"),
    ("country",         "Nationality / Country",              "\U0001F4D6"),
    ("denomination",    "Currency & Denomination",            "\U0001F4B0"),
    ("featured",        "Person / Symbol Featured",           "\U0001F464"),
    ("significance",    "Historical & Cultural Significance", "\U0001F3DB"),
]

# Not reported at all once a counterfeit is spotted. Every one of these
# describes the REAL coin being imitated, not the object in front of the
# camera, so answering them would dress a fake up in a genuine coin's history.
# The country stays: which coin it is pretending to be is worth knowing.
_SKIP_IF_FAKE = ("other_countries", "denomination", "featured", "significance")


_COIN_PROMPT = """You are identifying a coin held up to a camera.

Decide FIRST whether the coin is genuine, then report the rest.

1. verdict - exactly one word: real, fake, or unclear. Use "unclear" whenever
   the image is not good enough to judge; a confident guess is worse than
   admitting the picture will not support one.
2. authenticity - what led you to that verdict: strike quality, lettering,
   edge, colour, wear. If the verdict is "fake", say WHAT gives it away and
   allow yourself one light, good-natured joke about it - amused, never
   sneering, and never at the expense of the person holding it.
3. other_countries - whether this same coin, or the same design or currency, is
   or was used in any other country. Say so plainly if it is used only here.
4. country - the nation that issued it
5. denomination - the currency and face value
6. featured - the person, animal, or symbol shown on it
7. significance - its historical and cultural significance

Rules:
- Reply with ONE SENTENCE per field. Never more than one sentence.
- Keep each sentence under 20 words, natural and warm, not a bare label.
- If a detail is genuinely not visible (worn, blurred, face-down), say so in
  that field's sentence instead of guessing.
- If the image contains NO coin at all, reply with exactly: NO_COIN
- Return ONLY a JSON object with the keys: verdict, authenticity,
  other_countries, country, denomination, featured, significance.
  No markdown, no code fence."""


def _first_sentence(text, max_words=24, sentences=1):
    """Trim a coin field to `sentences` sentences - the model is asked for one,
    and this holds it to that after the fact. A fake gets two: the giveaway,
    then the joke about it."""
    t = " ".join(str(text or "").split())
    t = re.sub(r"[*#_`]+", "", t)
    parts = [p for p in re.split(r"(?<=[.!?])\s+", t) if p.strip()]
    out = " ".join(parts[:sentences]) if parts else t
    words = out.split()
    if len(words) > max_words * sentences:
        out = " ".join(words[:max_words * sentences]).rstrip(",;:—- ")
        if out and out[-1] not in ".!?":
            out += "."
    return out.strip()


def identify_coin(jpeg_bytes):
    """Send a camera frame to Gemini vision and return the five coin fields.
    Returns {"ok": False, "error": ...} when no coin is visible."""
    try:
        r = gen_content(
            model=CHAT_MODEL,
            contents=[types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"),
                      _COIN_PROMPT],
            config=GEN_CONFIG_FAST)
        raw = (r.text or "").strip()
        if not raw or "NO_COIN" in raw.upper():
            return {"ok": False, "error": "I don't see a coin — hold one up to the camera."}
        # Strip a ```json fence if the model added one despite being asked not to.
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
        try:
            data = json.loads(raw)
        except Exception:
            m = re.search(r"\{.*\}", raw, re.S)
            if not m:
                return {"ok": False, "error": "I couldn't read that coin clearly."}
            data = json.loads(m.group(0))
        # One word the code can branch on, rather than re-reading the prose.
        raw_verdict = str(data.get("verdict", "")).strip().lower()
        verdict = next((v for v in ("fake", "real", "unclear") if v in raw_verdict),
                       "unclear")
        fields = []
        for key, label, emoji in COIN_ORDER:
            if verdict == "fake" and key in _SKIP_IF_FAKE:
                continue
            # The one-sentence rule holds everywhere except the verdict on a
            # fake, which has to carry both the giveaway and the joke about it.
            room = 2 if (verdict == "fake" and key == "authenticity") else 1
            fields.append({"key": key, "label": label, "emoji": emoji,
                           "text": _first_sentence(data.get(key, ""),
                                                   sentences=room)})
        # One spoken line covering the panel, so the voice matches the screen.
        spoken = " ".join(f["text"] for f in fields if f["text"])
        return {"ok": True, "verdict": verdict,
                "fields": fields, "spoken": spoken}
    except Exception as e:
        print("coin id error:", str(e)[:120])
        return {"ok": False, "error": "I had trouble identifying that coin."}


# =========================================================
# PHYSICAL PRINTING (Baybayin sheets)
# =========================================================
# Auto-print is on by default; set BAYBAYIN_AUTOPRINT=0 in .env to turn it off
# (the on-screen display is unaffected either way).
_AUTOPRINT = os.environ.get("BAYBAYIN_AUTOPRINT", "1").strip().lower() not in (
    "0", "false", "no", "off")
_PRINTER = os.environ.get("BAYBAYIN_PRINTER", "").strip()   # blank = Windows default

# What the last print attempt did, surfaced on /state so the UI can show it.
last_print_status = {"word": None, "ok": None, "detail": "", "time": 0}


def _print_image_sync(path, printer_name):
    """Render an image straight to the printer's device context and spool it.

    Deliberately NOT os.startfile(path, "print"): this machine has no mspaint
    and no "print" verb registered for .png, so the shell route fails outright —
    and where it does exist it pops the Photos print dialog, which would stall a
    live demo waiting for a human click. Going through the DC prints silently.
    The image is scaled to fit the page while keeping its aspect ratio.
    """
    hDC = win32ui.CreateDC()
    hDC.CreatePrinterDC(printer_name)
    try:
        # Printable area of the page, in device units (dots).
        page_w = hDC.GetDeviceCaps(HORZRES)
        page_h = hDC.GetDeviceCaps(VERTRES)

        img = Image.open(path)
        if img.mode != "RGB":
            img = img.convert("RGB")
        img_w, img_h = img.size

        # Fit to the page without distorting or cropping the characters.
        scale = min(page_w / img_w, page_h / img_h)
        draw_w, draw_h = int(img_w * scale), int(img_h * scale)
        x = (page_w - draw_w) // 2
        y = (page_h - draw_h) // 2

        hDC.StartDoc(f"ALZONA Baybayin - {os.path.basename(path)}")
        hDC.StartPage()
        ImageWin.Dib(img).draw(hDC.GetHandleOutput(), (x, y, x + draw_w, y + draw_h))
        hDC.EndPage()
        hDC.EndDoc()
    finally:
        hDC.DeleteDC()


def print_image(path, label=""):
    """Send an image to the printer, off the request thread so a busy or offline
    printer never stalls ALZONA's reply. Uses the Windows default printer unless
    BAYBAYIN_PRINTER names another one."""
    if not _PRINTING_AVAILABLE:
        print("Print skipped — Windows printing modules unavailable.")
        return

    def _job():
        global last_print_status
        printer = _PRINTER or win32print.GetDefaultPrinter()
        try:
            _print_image_sync(path, printer)
            last_print_status = {"word": label, "ok": True, "detail": printer,
                                 "time": time.time()}
            print(f"Baybayin sheet printed on {printer}: {label}")
        except Exception as e:
            last_print_status = {"word": label, "ok": False,
                                 "detail": str(e)[:120], "time": time.time()}
            print("Print failed:", str(e)[:120])
    threading.Thread(target=_job, daemon=True).start()


def make_baybayin_image(word):
    images, H, sp = [], 300, 50
    for s in split_syllables(word):
        ap = _bay_path(s)
        if not ap or not os.path.exists(ap):
            continue
        img = cv2.imread(ap)
        if img is None:
            continue
        images.append(cv2.resize(img, (int(img.shape[1] * H / img.shape[0]), H)))
    if not images:
        return None
    space = np.ones((H, sp, 3), np.uint8) * 255
    parts = []
    for i, im in enumerate(images):
        parts.append(im)
        if i != len(images) - 1:
            parts.append(space)
    result = np.hstack(parts)
    m = 40
    canvas = np.ones((H + 2 * m, result.shape[1] + 2 * m, 3), np.uint8) * 255
    canvas[m:m + H, m:m + result.shape[1]] = result
    fn = "novus.png"   # single reused name — avoids piling up images
    out_path = os.path.join(GEN_OUT, fn)
    cv2.imwrite(out_path, canvas)
    # Auto-print the sheet as soon as it is generated (set BAYBAYIN_AUTOPRINT=0
    # in .env to keep the on-screen display without using paper).
    if _AUTOPRINT:
        print_image(out_path, label=word)
    return f"/gen/{fn}"


def extract_baybayin_target(text):
    t = text.lower()
    for sym in [",", ".", "?", "!", ":", '"', "'"]:
        t = t.replace(sym, "")
    stop = {"translate", "to", "in", "into", "the", "me", "show", "what", "is", "how",
            "do", "you", "write", "baybayin", "baybay", "please", "say", "word", "of",
            "a", "an", "can", "spell", "convert", "give", "see", "my", "name"}
    return " ".join(w for w in t.split() if w not in stop).strip()


# =========================================================
# KNOWLEDGE LIBRARY
# Drop files in knowledge/ (or upload via /upload_knowledge) and ALZONA
# searches them for answers before replying.
# =========================================================
KNOWLEDGE_DIR = os.path.join(BASE, "knowledge")
os.makedirs(KNOWLEDGE_DIR, exist_ok=True)

_knowledge_chunks = []   # [{"source": filename, "text": chunk}]

KNOWLEDGE_EXTS = (".txt", ".md", ".csv", ".pdf", ".docx", ".jsonl", ".json")


def _extract_text(path):
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext in (".txt", ".md", ".csv"):
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                return f.read()
        if ext == ".pdf":
            from pypdf import PdfReader
            return "\n".join((p.extract_text() or "") for p in PdfReader(path).pages)
        if ext == ".docx":
            import docx
            return "\n".join(p.text for p in docx.Document(path).paragraphs)
    except Exception as e:
        print(f"knowledge: failed to read {os.path.basename(path)}: {e}")
    return ""


def _chunk_text(text, size=1200, overlap=200):
    text = " ".join(text.split())
    chunks = []
    start = 0
    while start < len(text):
        chunks.append(text[start:start + size])
        start += size - overlap
    return chunks


def _record_to_text(obj):
    """Flatten a JSON record into readable 'field: value' lines."""
    if isinstance(obj, dict):
        return "\n".join(f"{k}: {_record_to_text(v)}" for k, v in obj.items())
    if isinstance(obj, list):
        return "; ".join(_record_to_text(v) for v in obj)
    return str(obj)


def _json_chunks(path):
    """One chunk per record, so each province/region stays a separate,
    self-contained unit for retrieval (instead of blind text slicing)."""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read().strip()
    except Exception as e:
        print(f"knowledge: failed to read {os.path.basename(path)}: {e}")
        return []

    records = []
    if content.startswith("["):          # plain .json array
        try:
            data = json.loads(content)
            records = data if isinstance(data, list) else [data]
        except Exception as e:
            print(f"knowledge: bad json in {os.path.basename(path)}: {e}")
    else:                                # .jsonl — one record per line
        for line in content.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except Exception:
                print(f"knowledge: skipped a bad jsonl line in {os.path.basename(path)}")

    chunks = []
    for rec in records:
        text = " ".join(_record_to_text(rec).split())
        if not text:
            continue
        # keep records whole; only split the rare oversized one
        chunks.extend(_chunk_text(text) if len(text) > 2000 else [text])
    return chunks


def reload_knowledge():
    """(Re)index every readable file in the knowledge folder."""
    global _knowledge_chunks
    chunks = []
    files = [f for f in sorted(os.listdir(KNOWLEDGE_DIR))
             if f.lower().endswith(KNOWLEDGE_EXTS)]
    for fn in files:
        path = os.path.join(KNOWLEDGE_DIR, fn)
        if fn.lower().endswith((".jsonl", ".json")):
            file_chunks = _json_chunks(path)
        else:
            file_chunks = _chunk_text(_extract_text(path))
        for c in file_chunks:
            if c.strip():
                chunks.append({"source": fn, "text": c})
    _knowledge_chunks = chunks
    print(f"knowledge: indexed {len(chunks)} chunk(s) from {len(files)} file(s)")


_STOPWORDS = {
    "the", "a", "an", "is", "are", "was", "were", "what", "who", "when", "where",
    "why", "how", "do", "does", "did", "can", "could", "you", "your", "me", "my",
    "i", "of", "in", "on", "at", "to", "for", "and", "or", "it", "its", "this",
    "that", "tell", "about", "please", "alzona",
}


def retrieve_knowledge(query, top_k=3, max_chars=4000):
    """Return the knowledge chunks most relevant to the query (keyword scoring)."""
    if not _knowledge_chunks:
        return ""
    terms = [w for w in re.findall(r"[a-z0-9']+", query.lower())
             if len(w) > 2 and w not in _STOPWORDS]
    if not terms:
        return ""
    scored = []
    for chunk in _knowledge_chunks:
        low = chunk["text"].lower()
        distinct = sum(1 for t in terms if t in low)
        if distinct:
            hits = sum(low.count(t) for t in terms)
            scored.append((distinct * 3 + hits, chunk))
    if not scored:
        return ""
    scored.sort(key=lambda s: s[0], reverse=True)
    out, total = [], 0
    for _, chunk in scored[:top_k]:
        piece = f"[from {chunk['source']}]\n{chunk['text']}"
        if total + len(piece) > max_chars:
            break
        out.append(piece)
        total += len(piece)
    return "\n\n".join(out)


reload_knowledge()


# Function words used to tell English from Filipino/Tagalog (both use the Latin
# alphabet, so script detection alone can't separate them \u2014 a Filipino topic or
# knowledge base easily pulls an English question into a Tagalog reply).
_EN_MARKERS = {
    "the", "is", "are", "was", "were", "what", "who", "when", "where", "why",
    "how", "did", "do", "does", "a", "an", "of", "in", "on", "to", "for", "and",
    "or", "it", "he", "she", "they", "his", "her", "their", "you", "your",
    "this", "that", "which", "there", "here", "with", "about", "can", "could",
    "would", "should", "tell", "me", "my", "please", "give", "name",
}
_FIL_MARKERS = {
    "ang", "ng", "mga", "ako", "ikaw", "siya", "kami", "tayo", "kayo", "sila",
    "ito", "iyan", "iyon", "ano", "sino", "saan", "kailan", "bakit", "paano",
    "kung", "ay", "po", "opo", "hindi", "oo", "salamat", "kumusta", "kamusta",
    "naman", "lang", "yung", "niya", "nila", "natin", "namin", "niyo", "mo",
    "ko", "pinakamataas", "bayani", "kabisera", "nobela", "isinulat",
}


def detect_reply_language(text):
    """Pin the reply language for cases the model tends to drift away from.
    Kana is checked before Han because Japanese also uses Han characters."""
    if any('\u3040' <= c <= '\u30ff' for c in text):   # hiragana / katakana
        return "Japanese"
    if any('\uac00' <= c <= '\ud7af' for c in text):   # hangul
        return "Korean"
    if any('\u4e00' <= c <= '\u9fff' for c in text):   # han
        return "Chinese"
    # Latin script: separate English from Filipino by function words. English
    # markers never appear in Filipino/regional languages, so an English hit is
    # a strong, safe signal \u2014 this keeps English questions from drifting to
    # Tagalog. Romanized CJK (no markers either way) returns None and is handled
    # by the model instruction instead.
    words = re.findall(r"[a-z]+", text.lower())
    if words:
        en = sum(w in _EN_MARKERS for w in words)
        fil = sum(w in _FIL_MARKERS for w in words)
        if en >= 1 and en > fil:
            return "English"
        if fil >= 2 and fil > en:
            return "Filipino"
    return None


# Trailing function words to strip if the word cap chops mid-phrase, so a
# truncated reply still ends on a content word rather than "…cultural, and".
_TRAIL_DROP = {
    "and", "or", "yet", "but", "so", "the", "a", "an", "of", "for", "to",
    "with", "as", "its", "his", "her", "their", "in", "on", "at", "by", "from",
    "that", "which", "is", "was", "were", "are", "who", "whose",
}


_ABBREV = ("Dr", "Mr", "Mrs", "Ms", "Jr", "Sr", "St", "Mt", "Prof", "Gen",
           "Gov", "Sen", "Rep", "Fr", "Atty", "Engr", "Hon", "vs", "etc", "No")


# Trailing "offer more help" closers, stripped if the model adds one despite the
# system prompt forbidding it. Belt-and-suspenders for the space-delimited
# languages (CJK, which isn't sentence-split below, is covered by the prompt).
_OFFER_RE = re.compile(
    r"\s*(?:"
    r"is there (?:anything|something) else[^.?!]*[?.!]?|"
    r"(?:can|may|how (?:can|may)) i (?:help|assist)[^.?!]*[?.!]?|"
    r"let me know if[^.?!]*[?.!]?|"
    r"feel free to (?:ask|reach out)[^.?!]*[?.!]?|"
    r"(?:do you|would you) (?:want|like)[^.?!]*(?:know more|else)[^.?!]*[?.!]?|"
    r"may (?:iba pa ba akong )?maitutulong pa ba(?:\s+ako)?[^.?!]*[?.!]?|"
    r"may iba pa ba[^.?!]*[?.!]?|"
    r"anything else[^.?!]*[?.!]?"
    r")\s*$",
    re.IGNORECASE)


# Cues that the user wants a fuller answer, or that the question needs several
# steps to answer properly. These promote the reply from the 25-word default to
# the 50-word tier. Kept multilingual so the tier works in any supported
# language, not just English.
_LONG_ANSWER_CUES = (
    "explain", "explanation", "tell me more", "more about", "in detail",
    "detailed", "elaborate", "why ", "why?", "how did", "how does", "how do",
    "compare", "difference between", "differences", "history of", "describe",
    "walk me through", "expand", "everything about", "full story", "background",
    "ipaliwanag", "paliwanag", "bakit", "paano", "kwento", "kasaysayan",
    "详细", "为什么", "解释", "说明",
    "詳しく", "なぜ", "説明", "どうして",
    "자세히", "왜", "설명", "어떻게",
)

# Word budgets for the two answer tiers (see _SYSTEM_INSTRUCTION "Answer length").
_WORDS_SHORT = 20
_WORDS_LONG = 50


def _wants_long_answer(question):
    """True when the user asked for detail, or the question is complex enough to
    need several explanations — those get the 50-word tier instead of 25."""
    q = (question or "").lower()
    if any(cue in q for cue in _LONG_ANSWER_CUES):
        return True
    # A genuinely multi-part question ("X and also Y?", or a long ask) needs room.
    if q.count("?") > 1:
        return True
    if len(q.split()) >= 18:
        return True
    return False


def _limit_answer(text, max_words=_WORDS_SHORT):
    """Backstop: plain text, the answer ONLY (no follow-up offer), capped at
    max_words words. Trims on a sentence boundary when one falls near the cap so
    the reply ends cleanly rather than mid-thought. Any leaked "anything else?"
    closer is stripped. CJK has no word spaces (one token), so it is never
    truncated."""
    text = re.sub(r"[*#_`]+", "", text)        # markdown reads awkwardly in TTS
    text = " ".join(text.split())
    text = _OFFER_RE.sub("", text).strip()     # drop a leaked help-offer closer
    # Protect abbreviation dots ("Dr.", "Mt.") so they don't look like sentence
    # ends when we pick the trim point.
    protected = text
    for a in _ABBREV:
        protected = re.sub(rf"\b{a}\.", a + "\x00", protected)
    sentences = [p.replace("\x00", ".")
                 for p in re.split(r"(?<=[.!?])\s+", protected) if p.strip()]
    if not sentences:
        return ""
    # Keep whole sentences while they fit in the budget — this is what makes a
    # 50-word answer read as finished prose instead of a cut-off paragraph.
    kept, used = [], 0
    for s in sentences:
        n = len(s.split())
        if kept and used + n > max_words:
            break
        kept.append(s)
        used += n
        if used >= max_words:
            break
    if not kept:                               # first sentence alone overflows
        kept = [sentences[0]]
    out = " ".join(kept)
    words = out.split()
    if len(words) > max_words:                 # hard trim, end cleanly
        words = words[:max_words]
        while len(words) > 1 and re.sub(r"[^\w]", "", words[-1].lower()) in _TRAIL_DROP:
            words.pop()
        out = " ".join(words).rstrip(",;:—- ")
        if out and out[-1] not in ".!?":
            out += "."
    return out.strip()


# Phrases that clear ALZONA's short-term memory. "goodbye" ends a visitor's
# session; "new conversation" starts fresh — both wipe the history so one
# visitor's context never carries over to the next person.
_GOODBYE_WORDS = ("goodbye", "good bye", "bye", "paalam",
                  "さようなら", "안녕히", "再见")
_NEWCONVO_WORDS = ("new conversation", "new chat", "start over", "start again",
                   "clear conversation", "clear chat", "clear memory", "reset",
                   "bagong usapan", "リセット", "초기화", "새 대화", "重新开始")


def detect_memory_reset(text):
    """Return 'new' or 'goodbye' if the message should wipe conversation memory,
    else None. 'new conversation' is checked first so it wins over a trailing
    'bye'."""
    t = text.lower().strip()
    if any(w in t for w in _NEWCONVO_WORDS):
        return "new"
    if any(w in t for w in _GOODBYE_WORDS):
        return "goodbye"
    return None


def route_command(transcript):
    """Dispatch a spoken command to arduino / video / baybayin / chat."""
    t = transcript.lower()

    # Answer to her own name before anything else looks at the text. Left to
    # the knowledge model, "alzona" came back as an answer about the surname.
    said_hello = identity_reply(transcript)
    if said_hello:
        return {"mode": "chat", "reply": said_hello}

    # Clear short-term memory on "new conversation" / "goodbye" so the next
    # visitor starts fresh. Acknowledge in the speaker's language.
    reset = detect_memory_reset(transcript)
    if reset:
        conversation_history.clear()
        lang = detect_reply_language(transcript)
        if reset == "goodbye":
            acks = {"Japanese": "さようなら！またね！",
                    "Korean": "안녕히 가세요! 또 만나요!",
                    "Filipino": "Paalam! Kita tayo ulit!",
                    "Chinese": "再见！下次见！"}
            reply = acks.get(lang, "Goodbye! Talk to you soon.")
        else:
            acks = {"Japanese": "新しい会話を始めましょう！",
                    "Korean": "새로운 대화를 시작해요!",
                    "Filipino": "Sige, bagong usapan na tayo!",
                    "Chinese": "好的，我们开始新的对话吧！"}
            reply = acks.get(lang, "Okay, let's start a new conversation!")
        return {"mode": "chat", "reply": reply}

    # for kw, cmd in ARDUINO_COMMANDS.items():
    #     if kw in t:
    #         ok = send_arduino(cmd)
    #         reply = (f"Done — sent '{cmd}' to the device."
    #                  if ok else f"I understood '{cmd}', but no Arduino is connected.")
    #         return {"mode": "arduino", "reply": reply, "command": cmd}

    for name, path in DANCES.items():
        if name in t:
            return {"mode": "video", "reply": f"Here is the {name.title()}, a Filipino folk dance.",
                    "video_url": f"/media/{path}"}

    # Philippine festival dance -> the Singkil, every time.
    #
    # Placed AFTER the loop above on purpose: naming a dance outright still
    # gets you that dance, so "tinikling festival" is still Tinikling. Only a
    # question with no dance named falls through to here.
    #
    # Note the wording. Singkil is a DANCE, not a festival of its own, and
    # ALZONA is meant to correct cultural mistakes rather than make them — so
    # she recommends it as the dance to watch and never implies otherwise.
    if wants_festival_dance(t):
        return {"mode": "video",
                "reply": ("For a festival, watch the Singkil — the Maranao "
                          "royal dance from Lanao, from the Darangen epic, "
                          "danced between crossing bamboo poles. It is the "
                          "showpiece of Philippine festival stages."),
                "video_url": f"/media/{SINGKIL_VIDEO}"}
    # if ("baybayin" in t or "baybay" in t) and any(w in t for w in ["teach", "learn", "video", "tutorial", "lesson"]):
    #     return {"mode": "video", "reply": "Here is a video teaching the Baybayin script.",
    #             "video_url": f"/media/{TEACHING_VIDEO}"}

    # ---- Lupang Hinirang: imitate / harmonize -------------------------------
    # The actual listening, pitch tracking and synthesis happen in the browser
    # (Web Audio) — it hears the mic directly, so there is no upload round-trip
    # and ALZONA can answer within a beat of the user finishing. This branch
    # only interprets the spoken command and tells the frontend which mode to
    # arm, via the "sing" object.
    sing = detect_sing_command(transcript)
    if sing:
        if sing["mode"] == "harmonize":
            parts = sing["parts"]
            if len(parts) == 1:
                who = parts[0]
            elif len(parts) == len(SATB_PARTS):
                who = "all four parts"
            else:
                who = " and ".join([", ".join(parts[:-1]), parts[-1]])
            reply = (f"Okay — sing Lupang Hinirang and I'll harmonize with you in "
                     f"{who}. Starting on G4, four four time.")
        else:
            reply = "Sing a line of Lupang Hinirang and I'll sing it back to you."
        return {"mode": "sing", "reply": reply, "sing": sing}

    # "what coin is this", "identify this coin", "anong barya ito"
    if any(w in t for w in ("coin", "barya", "salapi", "currency", "money")) and \
            any(w in t for w in ("what", "which", "identify", "read", "see", "this",
                                 "ano", "anong", "kilalanin", "tingnan")):
        if latest_frame is None:
            return {"mode": "coin", "reply": "The camera isn't ready yet."}
        result = identify_coin(latest_frame)
        if not result.get("ok"):
            return {"mode": "coin", "reply": result.get("error", "I couldn't read that coin.")}
        return {"mode": "coin", "reply": result["spoken"], "coin": result["fields"]}

    if "baybayin" in t or "baybay" in t:
        target = extract_baybayin_target(transcript)
        if target:
            url = make_baybayin_image(target)
            if url:
                reply = f"Here is '{target}' written in Baybayin."
                if _AUTOPRINT:
                    reply += " I'm printing it for you now."
                return {"mode": "baybayin", "reply": reply,
                        "image_url": url, "word": target, "printing": _AUTOPRINT}
        return {"mode": "chat", "reply": "Which word would you like me to write in Baybayin?"}

    try:
        context = retrieve_knowledge(transcript)
        lang = detect_reply_language(transcript)
        lang_rule = (
            f"Reply ONLY in {lang}."
            if lang else
            "Reply in the EXACT same language, script, and dialect the user used "
            "in their CURRENT message — including romanized/phonetic input, which "
            "you must treat AS that language. Never translate, transliterate, "
            "gloss, or explain the user's own words back to them; just answer as "
            "a natural conversation partner. Do NOT switch languages based on "
            "earlier turns."
        )

        parts = []
        if conversation_history:
            convo = "\n".join(
                f"User: {u}\nALZONA: {a}"
                for u, a in conversation_history[-MAX_HISTORY_TURNS:]
            )
            parts.append(
                "Recent conversation so far — use it ONLY for context and to "
                "resolve follow-ups (e.g. 'tell me more', 'and her?'). Do NOT let "
                "its language change the language of your reply:\n" + convo
            )
        if context:
            parts.append(
                "Reference material from your knowledge library — your PRIMARY "
                "source. If it FULLY answers, use ONLY it; if it is incomplete, "
                "supplement with your own accurate knowledge (never contradicting "
                "it):\n\n" + context
            )
        else:
            parts.append(
                "Your knowledge library has no relevant material for this "
                "message. If it is a genuine question, use the Google Search tool "
                "for an accurate answer — do not dismiss it. Romanized foreign "
                "phrases are real language, never gibberish."
            )
        parts.append(f"Current user message: {transcript}")
        want_long = _wants_long_answer(transcript)
        if want_long:
            length_rule = (
                "This question asks for detail or needs several explanations, so "
                "give a fuller answer of AT MOST 50 WORDS — two or three tight, "
                "complete sentences. Do not pad to reach 50; stop when the answer "
                "is complete."
            )
        else:
            length_rule = (
                "Answer in at most 20 WORDS and at most two sentences, stating "
                "the fact asked plus the single most useful detail."
            )
        parts.append(
            f"({lang_rule} {length_rule} Answer ONLY — do NOT add a follow-up "
            "question or any offer of further help. Plain text — no lists, no "
            "headings, no markdown.)"
        )
        prompt = "\n\n".join(parts)

        # KB already has the answer -> skip the web-search grounding round-trip
        # (much faster). Only reach for search when the library came up empty.
        cfg = GEN_CONFIG_FAST if context else GEN_CONFIG
        resp = gen_content(model=CHAT_MODEL, contents=prompt, config=cfg)
        reply = _limit_answer((resp.text or "").strip(),
                              _WORDS_LONG if want_long else _WORDS_SHORT)
        if not reply:
            reply = "Sorry, I didn't catch that. Could you please rephrase?"

        # Remember this exchange for follow-ups; keep only the last few turns.
        conversation_history.append((transcript, reply))
        del conversation_history[:-MAX_HISTORY_TURNS]
    except Exception as e:
        print("gemini error:", e)
        reply = "I'm having trouble answering right now. Please try again."
    return {"mode": "chat", "reply": reply}


@app.post('/upload_knowledge')
async def upload_knowledge(file: UploadFile = File(...)):
    """Add a document to ALZONA's knowledge library."""
    name = os.path.basename(file.filename or "")
    ext = os.path.splitext(name)[1].lower()
    if ext not in KNOWLEDGE_EXTS:
        return JSONResponse(
            {"error": f"Unsupported type '{ext}'. Use: {', '.join(KNOWLEDGE_EXTS)}"},
            status_code=400,
        )
    data = await file.read()
    with open(os.path.join(KNOWLEDGE_DIR, name), "wb") as f:
        f.write(data)
    await run_in_threadpool(reload_knowledge)
    return {"ok": True, "file": name, "chunks": len(_knowledge_chunks)}


@app.get('/knowledge')
def list_knowledge():
    """List the files in the knowledge library."""
    files = [
        {"name": fn, "size": os.path.getsize(os.path.join(KNOWLEDGE_DIR, fn))}
        for fn in sorted(os.listdir(KNOWLEDGE_DIR))
        if fn.lower().endswith(KNOWLEDGE_EXTS)
    ]
    return {"files": files, "chunks": len(_knowledge_chunks)}


@app.delete('/knowledge/{filename}')
def delete_knowledge(filename: str):
    """Remove a file from the knowledge library."""
    name = os.path.basename(filename)
    path = os.path.join(KNOWLEDGE_DIR, name)
    if not os.path.exists(path):
        return JSONResponse({"error": "not found"}, status_code=404)
    os.remove(path)
    reload_knowledge()
    return {"ok": True}


@app.post('/say')
async def say(text: str = Form(...)):
    """Speak a short phrase in ALZONA's voice (wake/stop acknowledgments)."""
    text = (text or "").strip()
    if not text:
        return JSONResponse({"tts_url": None, "error": "empty"})
    # Threadpool keeps the event loop (and the /video stream) responsive.
    # cache=True: identical phrases (wake/stop acknowledgments, repeated
    # replies) are synthesized once and replayed instantly afterwards.
    fn = await run_in_threadpool(fast_voice, text, True)
    return {"tts_url": f"/tts/{fn}" if fn else None}


@app.get('/tts/{filename}')
def serve_tts(filename: str):
    file_path = os.path.join(BASE, 'static', 'tts', filename)
    if not os.path.exists(file_path):
        return Response(status_code=404)
    media = 'audio/wav' if filename.lower().endswith('.wav') else 'audio/mpeg'
    return FileResponse(file_path, media_type=media, filename=filename)


@app.post('/identify_coin')
async def identify_coin_endpoint():
    """Grab the current camera frame and identify the coin in it."""
    frame = latest_frame
    if frame is None:
        return JSONResponse({"ok": False, "error": "The camera isn't ready yet."})
    result = await run_in_threadpool(identify_coin, frame)
    if result.get("ok") and result.get("spoken"):
        tts = await run_in_threadpool(fast_voice, result["spoken"])
        result["tts_url"] = f"/tts/{tts}" if tts else None
    return result


_anthem_lines_cache = None


def _anthem_lines():
    """The anthem's lyric lines, in order, from the aligned lyrics file."""
    global _anthem_lines_cache
    if _anthem_lines_cache is None:
        try:
            path = os.path.join(BASE, "source", "harmony", "lyrics.json")
            with open(path, encoding="utf-8") as f:
                _anthem_lines_cache = [l["text"] for l in json.load(f)["lines"]]
        except Exception as e:
            print("lyrics unavailable:", str(e)[:80])
            _anthem_lines_cache = []
    return _anthem_lines_cache


@app.post('/listen')
async def listen(file: UploadFile = File(...)):
    """One ear for everything: decide whether a clip is SINGING or SPEECH.

    The browser's SpeechRecognition insists on owning the microphone, so it
    cannot run alongside the continuous pitch tracking the harmony needs — one
    starves the other and BOTH features stop working, which is exactly what was
    measured: recognition restarting every second and hearing nothing, while the
    singing side received no audio either.

    Routing every clip through here instead means a single always-open
    microphone serves both. ALZONA hears singing and harmonises, or hears a
    question and answers it, with nothing to switch between and no command to
    remember.
    """
    try:
        data = await file.read()
        if not data:
            return {"kind": "none", "error": "empty audio"}
        lines = _anthem_lines()
        numbered = "\n".join(f"{i}: {t}" for i, t in enumerate(lines))
        prompt = (
            "Listen to this short clip and decide what it is.\n\n"
            "If the person is SINGING, the song ALZONA knows is the Philippine "
            "national anthem, Lupang Hinirang. Its lines, numbered:\n\n"
            + numbered +
            "\n\nIf the person is SPEAKING — asking a question, giving an "
            "instruction, or talking — transcribe what they said.\n\n"
            "Reply with ONLY a JSON object:\n"
            '  "kind"  - "singing", "speech", or "none" for silence or noise\n'
            '  "line"  - when singing: which numbered line they START on, or '
            "null if the words are unclear\n"
            '  "song"  - when singing: the title you recognise, else null\n'
            '  "text"  - when speaking: what they said, verbatim\n\n'
            "Sung words stretch across held notes; speech does not. Judge the "
            "line from words you can actually hear, never from the tune alone — "
            "several lines share a melody. Do not default to line 0."
        )
        r = await run_in_threadpool(
            gen_content,
            model=CHAT_MODEL,
            contents=[types.Part.from_bytes(data=data, mime_type="audio/webm"), prompt],
            config=GEN_CONFIG_FAST)
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", (r.text or "").strip())
        try:
            info = json.loads(raw)
        except Exception:
            m = re.search(r"\{.*\}", raw, re.S)
            info = json.loads(m.group(0)) if m else {}

        kind = (info.get("kind") or "none").lower()

        if kind == "singing":
            idx = info.get("line")
            idx = int(idx) if str(idx).isdigit() else None
            ok = idx is not None and 0 <= idx < len(lines)
            return {"kind": "singing", "song": info.get("song"),
                    "index": idx if ok else None,
                    "text": lines[idx] if ok else None}

        if kind == "speech":
            said = (info.get("text") or "").strip()
            if not said:
                return {"kind": "none"}
            result = await run_in_threadpool(route_command, said)
            reply = result.get("reply", "")
            tts = await run_in_threadpool(fast_voice, reply) if reply else None
            return {"kind": "speech", "transcript": said, "reply": reply,
                    "mode": result.get("mode", "chat"),
                    "image_url": result.get("image_url"),
                    "video_url": result.get("video_url"),
                    "coin": result.get("coin"), "sing": result.get("sing"),
                    "tts_url": f"/tts/{tts}" if tts else None}

        return {"kind": "none"}
    except Exception as e:
        print("listen error:", str(e)[:120])
        return {"kind": "none", "error": str(e)[:80]}


# =========================================================
# WHO HOLDS THE MICROPHONE
# =========================================================
# Two consoles can be open at once — 5173 where she follows the singer, 5174
# where she leads — and each runs its own speech recognition. The browser gives
# the microphone to ONE of them, so the other is aborted the moment it starts.
# Measured live, they ping-ponged every two seconds and NEITHER ever heard a
# word, with nothing on either screen to say why.
#
# They are different origins, so they cannot see each other through the browser:
# no shared storage, no BroadcastChannel. The backend is the only thing they
# both talk to, so the lease lives here.
#
# A lease with a deadline rather than a flag someone must remember to clear: a
# page that is closed, reloaded or crashes never sends a release, and a flag
# left set would lock every console out of the microphone for good.
_MIC_LEASE = {"holder": None, "at": 0.0}
_MIC_LEASE_TTL = 4.0        # a holder that stops renewing has gone away


@app.post('/mic_lease')
async def mic_lease(client: str = Form(...), release: str = Form("0"),
                    focused: str = Form("0")):
    """Claim, renew or drop the right to listen. Returns who holds it.

    A FOCUSED console takes the microphone from an unfocused one. Without that
    the first page to load kept it for ever, and the answer to "this console
    cannot hear me" was to go and close the other one — which is no answer at
    all when both are wanted open. Whichever window someone is actually looking
    at is the one they are talking to.
    """
    now = time.time()
    lease = _MIC_LEASE
    has_focus = focused in ("1", "true", "yes")

    if release in ("1", "true", "yes"):
        if lease["holder"] == client:
            lease["holder"] = None
        return {"holder": lease["holder"], "yours": False}

    expired = now - lease["at"] > _MIC_LEASE_TTL
    # Only a focused claimant may take it from a live holder. An unfocused page
    # must wait for the lease to lapse, or it would snatch it straight back.
    if lease["holder"] in (None, client) or expired or has_focus:
        lease["holder"] = client
        lease["at"] = now

    return {"holder": lease["holder"], "yours": lease["holder"] == client}


@app.post('/debug_log')
async def debug_log(line: str = Form(...)):
    """Take a diagnostic line from the browser and append it to a file.

    The singing features run entirely in the browser, so without this there is
    no server-side trace of what the microphone actually delivered — and that
    trace is what found every real bug in this feature.
    """
    try:
        path = os.path.join(BASE, "static", "sing_debug.log")
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')}  {line[:400]}\n")
    except Exception as e:
        return {"ok": False, "error": str(e)[:80]}
    return {"ok": True}


@app.get('/state')
def state():
    """Return a minimal state object the frontend expects."""
    return {
        'face_state': face_state,
        'age_result': age_result,
        'chat': True,
        'running': running,
        'print_status': last_print_status,
    }


@app.get('/video')
def video_feed():
    """Return an MJPEG stream of the latest camera frames."""

    def generate():
        global latest_frame

        while True:
            if latest_frame is not None:
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n"
                    + latest_frame
                    + b"\r\n"
                )
            time.sleep(0.03)

    return StreamingResponse(
        generate(),
        media_type='multipart/x-mixed-replace; boundary=frame',
        headers={
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
        },
    )


@app.post('/command')
async def command(text: str = Form(...), skip_tts: str = Form("")):
    """Text command (from the browser's speech recognition) -> route -> reply.
    With skip_tts=1 the reply text returns immediately and the frontend
    fetches the audio separately via /say (text shows while voice renders)."""
    text = (text or "").strip()
    if not text:
        return JSONResponse({"transcript": "", "reply": "", "error": "empty"})
    # Gemini calls block for seconds; threadpool keeps /video streaming.
    result = await run_in_threadpool(route_command, text)
    reply = result.get("reply", "")
    tts = None
    if reply and skip_tts != "1":
        tts = await run_in_threadpool(fast_voice, reply)
    return {
        "transcript": text, "reply": reply, "mode": result.get("mode", "chat"),
        "image_url": result.get("image_url"), "video_url": result.get("video_url"),
        "word": result.get("word"), "command": result.get("command"),
        "coin": result.get("coin"), "printing": result.get("printing"),
        "sing": result.get("sing"),
        "tts_url": f"/tts/{tts}" if tts else None,
    }


@app.post('/upload_audio')
async def upload_audio(file: UploadFile = File(...)):
    """Voice -> Gemini STT -> route (baybayin / video / arduino / chat) -> spoken reply."""
    global last_user_input, subtitle_history
    try:
        data = await file.read()
        transcript = await run_in_threadpool(
            gemini_transcribe, data, file.content_type or "audio/webm"
        )
        if not transcript:
            return JSONResponse({"transcript": "", "reply": "", "error": "No speech detected"})
        last_user_input = transcript
        result = await run_in_threadpool(route_command, transcript)
        reply = result.get("reply", "")
        tts = await run_in_threadpool(fast_voice, reply) if reply else None
        return {
            "transcript": transcript,
            "reply": reply,
            "mode": result.get("mode", "chat"),
            "image_url": result.get("image_url"),
            "video_url": result.get("video_url"),
            "word": result.get("word"),
            "command": result.get("command"),
            "tts_url": f"/tts/{tts}" if tts else None,
        }
    except Exception as e:
        print("upload_audio error:", e)
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/")
def root():
    return {
        "status": "running"
    }

# =========================================================
# PLAY AUDIO
# =========================================================
# Note: local playback removed. Frontend will request TTS files at /tts/<file>
def play_audio(file_path):
    """No-op playback function to keep existing code paths stable.

    TTS files are generated to `static/tts/` and served to the frontend.
    """
    print(f"play_audio (noop) -> {file_path}")


def listen():
    """Return the most recent transcript posted by the web UI (once).

    The web UI should POST audio to `/upload_audio`, which updates
    `last_user_input`. `listen()` consumes that value and clears it.
    """
    global last_user_input, subtitle_history

    if not last_user_input:
        return None

    text = last_user_input
    last_user_input = ""

    # keep a minimal subtitle history entry
    try:
        subtitle_history = []
        subtitle_history.append({
            'id': str(uuid.uuid4()),
            'speaker': 'user',
            'text': text,
            'time': time.time()
        })
    except Exception:
        pass

    print(f"USER (web): {text}")
    return text

# def play_audio(file_path):

#     pygame.mixer.music.load(file_path)
#     pygame.mixer.music.play()

#     while pygame.mixer.music.get_busy():
#         pygame.time.Clock().tick(10)

#     pygame.mixer.music.stop()
#     pygame.mixer.music.unload()

#     # keep the single voice file around; it will be removed before next synthesis

def detect_command(text):
    if not text:
        return False

    t = text.lower().strip()

    teach_words = [
        'teach', 
        'turo', 
        'turuan', 
        'turuan mo ako', 
        'turuan mo ako ng baybayin',
        'can you teach me baybayin',
        'can you help me translate to baybayin',
    ]

    return any(word in t for word in teach_words)

# =========================================================
# RUN PROGRAM
# =========================================================
if __name__ == "__main__":
    # Start background threads for face detection and chatbot
    t1 = threading.Thread(target=face_detection, daemon=True)
    t1.start()
    print("✓ Face detection thread started")

    # t2 = threading.Thread(target=chatbot, daemon=True)
    # t2.start()
    # print("✓ Chatbot thread started")

    # Run FastAPI server
    print("✓ Starting FastAPI on 0.0.0.0:5002")
    uvicorn.run(app, host="0.0.0.0", port=5002)




