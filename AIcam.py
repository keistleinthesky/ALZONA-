import os
import cv2
import uuid
import pygame
from PIL import Image

import google.generativeai as genai
from google.cloud import texttospeech

# =====================================================
# GOOGLE CLOUD
# =====================================================
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "dyciroboticsteam-82e1fa8b4c0c.json"

# =====================================================
# GEMINI
# =====================================================
genai.configure(api_key="AIzaSyB-Y5rd-cNTc0ZA1R8R5vpkztE012l_yPw")

model = genai.GenerativeModel("gemini-3-flash-preview")

# =====================================================
# PYGAME AUDIO
# =====================================================
pygame.mixer.init()

# =====================================================
# TTS CLIENT
# =====================================================
tts_client = texttospeech.TextToSpeechClient()

# =====================================================
# DEFAULT LANGUAGE
# =====================================================
language_mode = "english"

LANGUAGES = {

    "english": {
        "code": "en-US",
        "voice": "en-US-Neural2-C",
        "instruction": "Reply in English."
    },

    "japanese": {
        "code": "ja-JP",
        "voice": "ja-JP-Neural2-B",
        "instruction": "Reply in Japanese."
    },

    "korean": {
        "code": "ko-KR",
        "voice": "ko-KR-Neural2-B",
        "instruction": "Reply in Korean."
    },

    "chinese": {
        "code": "cmn-CN",
        "voice": "cmn-CN-Wavenet-A",
        "instruction": "Reply in Simplified Chinese."
    }
}

# =====================================================
# TEXT TO SPEECH
# =====================================================
def speak(text):

    settings = LANGUAGES[language_mode]

    synthesis_input = texttospeech.SynthesisInput(
        text=text
    )

    voice = texttospeech.VoiceSelectionParams(
        language_code=settings["code"],
        name=settings["voice"]
    )

    audio_config = texttospeech.AudioConfig(
        audio_encoding=texttospeech.AudioEncoding.MP3
    )

    response = tts_client.synthesize_speech(
        input=synthesis_input,
        voice=voice,
        audio_config=audio_config
    )

    filename = f"{uuid.uuid4()}.mp3"

    with open(filename, "wb") as out:
        out.write(response.audio_content)

    pygame.mixer.music.load(filename)
    pygame.mixer.music.play()

    while pygame.mixer.music.get_busy():
        pygame.time.Clock().tick(10)

    pygame.mixer.music.unload()

    os.remove(filename)

# =====================================================
# ANALYZE IMAGE
# =====================================================
def analyze_image(frame):

    settings = LANGUAGES[language_mode]

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

    pil_image = Image.fromarray(rgb)

    prompt = f"""
You are a scientific vision AI.

IMPORTANT:
- {settings["instruction"]}
- Keep response short
- 1-2 sentences only
- Keep in mind that what you see is all about the culture and traditions of the Philippines. Mostly about festivals, dances, and others.
- Always start with "this is" like you are introducing the image. Not just describing. What is the name of the festival?What kind of festival or dance is it? What is the name of the festival or dance? Where in the Philippines is it from? What is the significance of the festival or dance? What are the people in the image doing? What are they wearing? What are they holding? 
"""
    response = model.generate_content([
        prompt,
        pil_image
    ])

    return response.text.strip()

# =====================================================
# CAMERA
# =====================================================
cap = cv2.VideoCapture(0)

if not cap.isOpened():
    print("Camera error")
    exit()

print("\n==============================")
print("MULTILINGUAL AI CAMERA")
print("==============================")
print("A = Analyze")
print("1 = English")
print("2 = Japanese")
print("3 = Korean")
print("4 = Chinese")
print("ESC = Quit")
print("==============================")

# =====================================================
# MAIN LOOP
# =====================================================
while True:

    ret, frame = cap.read()

    if not ret:
        break

    cv2.imshow("AI Camera", frame)

    key = cv2.waitKey(1) & 0xFF

    # =================================================
    # LANGUAGE SWITCH
    # =================================================
    if key == ord('1'):

        language_mode = "english"
        print("\nLanguage: English")
        speak("English mode activated")

    elif key == ord('2'):

        language_mode = "japanese"
        print("\nLanguage: Japanese")
        speak("日本語モードが有効になりました")

    elif key == ord('3'):

        language_mode = "korean"
        print("\nLanguage: Korean")
        speak("한국어 모드가 활성화되었습니다")

    elif key == ord('4'):

        language_mode = "chinese"
        print("\nLanguage: Chinese")
        speak("中文模式已启动")

    # =================================================
    # ANALYZE
    # =================================================
    elif key == ord('a'):

        print("\nAnalyzing image...")

        try:

            result = analyze_image(frame)

            print("\nAI:", result)

            speak(result)

        except Exception as e:

            print("AI Error:", e)

    # =================================================
    # EXIT
    # =================================================
    elif key == 27:
        break

# =====================================================
# CLEANUP
# =====================================================
cap.release()
cv2.destroyAllWindows()