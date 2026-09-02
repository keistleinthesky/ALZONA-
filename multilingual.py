import os
import uuid
import google.generativeai as genai
from google.cloud import texttospeech
import pygame
import speech_recognition as sr

# =========================================================
# GOOGLE CLOUD CREDENTIALS
# =========================================================
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "dyciroboticsteam-82e1fa8b4c0c.json"

# =========================================================
# GEMINI API KEY
# =========================================================
# Read the key from the environment (set GOOGLE_GENAI_API_KEY in .env).
# This previously passed the key itself as the variable NAME to look up, so
# os.getenv always returned None and the key was hardcoded in the source.
genai.configure(api_key=os.getenv("GOOGLE_GENAI_API_KEY"))

# =========================================================
# DEFAULT SETTINGS
# =========================================================
language_code = "en-US"
language_name = "English"
voice_name = "en-US-Neural2-C"

# =========================================================
# INITIALIZE SYSTEMS
# =========================================================
pygame.mixer.init()
recognizer = sr.Recognizer()

# =========================================================
# GEMINI MODEL
# =========================================================
model = genai.GenerativeModel(
    model_name="gemini-3-flash-preview",
    system_instruction="""
You are NAVIS, a multilingual AI assistant.

Rules:
- Reply in the SAME language as the user
- Keep responses short (1–2 sentences)
- Be conversational and natural
- If the user says "speak in Cebuano". Greet in Cebuano and reply in Cebuano from then on.
- Use warm and friendly intonation.
"""
)

chat_session = model.start_chat(history=[])

# =========================================================
# GOOGLE TTS CLIENT
# =========================================================
tts_client = texttospeech.TextToSpeechClient()

# =========================================================
# GLOBAL RESET DETECTION
# =========================================================
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
    voice_name = "en-US-Neural2-C"

# =========================================================
# LANGUAGE COMMANDS
# =========================================================
def detect_language_command(text):

    global language_code
    global language_name
    global voice_name

    t = text.lower()

    if "speak in japanese" in t:

        language_code = "ja-JP"
        language_name = "Japanese"
        voice_name = "ja-JP-Neural2-B"

        return "Japanese mode activated."

    elif "speak in korean" in t:

        language_code = "ko-KR"
        language_name = "Korean"
        voice_name = "ko-KR-Neural2-B"

        return "Korean mode activated."

    elif "speak in filipino" in t or "speak in tagalog" in t:

        language_code = "fil-PH"
        language_name = "Filipino"
        voice_name = "fil-PH-Standard-A"

        return "Filipino mode activated."

    elif "speak in english" in t:

        language_code = "en-US"
        language_name = "English"
        voice_name = "en-US-Neural2-C"

        return "English mode activated."

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
def synthesize_speech(text, lang_code, voice):

    file_name = f"{uuid.uuid4()}.mp3"

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

    with open(file_name, "wb") as f:
        f.write(response.audio_content)

    return file_name

# =========================================================
# PLAY AUDIO
# =========================================================
def play_audio(file_path):

    pygame.mixer.music.load(file_path)
    pygame.mixer.music.play()

    while pygame.mixer.music.get_busy():
        pygame.time.Clock().tick(10)

    pygame.mixer.music.stop()
    pygame.mixer.music.unload()

    if os.path.exists(file_path):
        os.remove(file_path)

# =========================================================
# WAKE WORD DETECTION
# =========================================================
def wait_for_wake_word():

    with sr.Microphone() as source:

        recognizer.adjust_for_ambient_noise(source)

        print("\n[Waiting for wake word: 'robot']")

        while True:

            try:

                audio = recognizer.listen(source)

                text = recognizer.recognize_google(
                    audio,
                    language="en-US"
                ).lower()

                print(f"Heard: {text}")

                if "robot" in text:

                    print("\nNAVIS Activated!")

                    msg = "Yes? How can I help you?"

                    audio_file = synthesize_speech(
                        msg,
                        "en-US",
                        "en-US-Neural2-C"
                    )

                    play_audio(audio_file)

                    return

            except sr.UnknownValueError:
                pass

            except Exception as e:
                print(f"Wake word error: {e}")

# =========================================================
# LISTEN FOR USER INPUT
# =========================================================
def listen():

    with sr.Microphone() as source:

        recognizer.adjust_for_ambient_noise(source)

        print(f"\nListening in {language_name}...")

        try:

            audio = recognizer.listen(source, timeout=10)

            text = recognizer.recognize_google(
                audio,
                language=language_code
            )

            print(f"\nUSER: {text}")

            return text

        except sr.WaitTimeoutError:

            print("Listening timeout.")
            return None

        except sr.UnknownValueError:

            print("Could not understand.")
            return None

        except Exception as e:

            print(f"STT Error: {e}")
            return None

# =========================================================
# MAIN CHATBOT
# =========================================================
def chatbot():

    print("\n====================================")
    print("NAVIS MULTILINGUAL AI")
    print("Wake word: robot")
    print("Say 'goodbye' to end session")
    print("Say 'quit' to terminate NAVIS")
    print("====================================")

    # =====================================================
    # OUTER LOOP (PROGRAM LIFETIME)
    # =====================================================
    while True:

        # =================================================
        # WAIT FOR WAKE WORD
        # =================================================
        wait_for_wake_word()

        print("\n[Conversation Mode Active]")

        # =================================================
        # INNER LOOP (ACTIVE SESSION)
        # =================================================
        while True:

            user_input = listen()

            if not user_input:
                continue

            try:

                # =========================================
                # FULL PROGRAM TERMINATION
                # =========================================
                if user_input.lower() == "quit":

                    shutdown = "Shutting down NAVIS."

                    print(f"\nNAVIS: {shutdown}")

                    audio = synthesize_speech(
                        shutdown,
                        language_code,
                        voice_name
                    )

                    play_audio(audio)

                    print("\n[NAVIS TERMINATED]")

                    return

                # =========================================
                # END CURRENT SESSION ONLY
                # =========================================
                if user_input.lower() in [
                    "goodbye",
                    "bye",
                    "stop"
                ]:

                    goodbye = "Goodbye!"

                    print(f"\nNAVIS: {goodbye}")

                    audio = synthesize_speech(
                        goodbye,
                        language_code,
                        voice_name
                    )

                    play_audio(audio)

                    print("\n[Session Ended]")

                    break

                # =========================================
                # GLOBAL RESET
                # =========================================
                if detect_reset_command(user_input):

                    force_english()

                    msg = "Settings reset to English."

                    print(f"\nNAVIS: {msg}")

                    audio = synthesize_speech(
                        msg,
                        language_code,
                        voice_name
                    )

                    play_audio(audio)

                    continue

                # =========================================
                # LANGUAGE COMMANDS
                # =========================================
                command_response = detect_language_command(user_input)

                if command_response:

                    print(f"\nNAVIS: {command_response}")

                    audio = synthesize_speech(
                        command_response,
                        language_code,
                        voice_name
                    )

                    play_audio(audio)

                    continue

                # =========================================
                # DETECT SCRIPT LANGUAGE
                # =========================================
                script_lang, script_code, script_voice = detect_script_language(user_input)

                # =========================================
                # GEMINI PROMPT
                # =========================================
                prompt = f"""
You are NAVIS.

IMPORTANT:
- Reply in the SAME language as the user
- Keep response short (1–2 sentences)
- Be natural and conversational

User message:
{user_input}
"""

                try:

                    response = chat_session.send_message(prompt)

                    bot_reply = response.text.strip()

                except Exception as gemini_error:

                    print(f"Gemini Error: {gemini_error}")

                    if language_name == "Korean":
                        bot_reply = "현재 AI 연결에 문제가 있습니다."

                    elif language_name == "Japanese":
                        bot_reply = "現在AI接続に問題があります。"

                    else:
                        bot_reply = "I am having trouble connecting right now."

                print(f"\nNAVIS: {bot_reply}")

                # =========================================
                # SELECT TTS VOICE
                # =========================================
                if script_lang == "Japanese":

                    lang = "ja-JP"
                    voice = "ja-JP-Neural2-B"

                elif script_lang == "Korean":

                    lang = "ko-KR"
                    voice = "ko-KR-Neural2-B"

                else:

                    lang = language_code
                    voice = voice_name

                # =========================================
                # SPEAK RESPONSE
                # =========================================
                audio_file = synthesize_speech(
                    bot_reply,
                    lang,
                    voice
                )

                play_audio(audio_file)

            except Exception as e:

                print(f"Error: {e}")

# =========================================================
# RUN PROGRAM
# =========================================================
if __name__ == "__main__":
    chatbot()


