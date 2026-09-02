import os
import cv2
import uuid
import time
import glob
import threading
import requests
import pygame
import speech_recognition as sr

from google.cloud import texttospeech
import google.generativeai as genai

# =========================================================
# GOOGLE CLOUD CREDENTIALS
# =========================================================
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "dyciroboticsteam-82e1fa8b4c0c.json"

# =========================================================
# GEMINI API KEY
# =========================================================
genai.configure(api_key="AIzaSyB-Y5rd-cNTc0ZA1R8R5vpkztE012l_yPw")

# =========================================================
# PEXELS API KEY
# =========================================================
PEXELS_API_KEY = "USYY0MHrlraUcTmCAQASSdKf3GP6UL88VDboMnxkyYzhEOVyMQkE0yfn"

# =========================================================
# GEMINI MODEL
# =========================================================
model = genai.GenerativeModel("gemini-3-flash-preview")

# =========================================================
# INITIALIZE SYSTEMS
# =========================================================
pygame.mixer.init()

recognizer = sr.Recognizer()

tts_client = texttospeech.TextToSpeechClient()

# =========================================================
# DEFAULT LANGUAGE SETTINGS
# =========================================================
language_code = "en-US"
language_name = "English"
voice_name = "en-US-Neural2-C"

# =========================================================
# TEXT TO SPEECH
# =========================================================
def speak(text):

    global language_code
    global voice_name

    try:

        synthesis_input = texttospeech.SynthesisInput(
            text=text
        )

        voice = texttospeech.VoiceSelectionParams(
            language_code=language_code,
            name=voice_name
        )

        audio_config = texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.MP3,
            speaking_rate=1.0,
            pitch=0.0
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

        pygame.mixer.music.stop()
        pygame.mixer.music.unload()

        if os.path.exists(filename):
            os.remove(filename)

    except Exception as e:

        print("TTS Error:", e)

# =========================================================
# LISTEN FUNCTION
# =========================================================
def listen():

    with sr.Microphone() as source:

        recognizer.adjust_for_ambient_noise(source)

        print(f"\nListening in {language_name}...")

        try:

            audio = recognizer.listen(
                source,
                timeout=10
            )

            text = recognizer.recognize_google(
                audio,
                language=language_code
            )

            print(f"\nUSER: {text}")

            return text.lower()

        except sr.WaitTimeoutError:

            print("Listening timeout.")
            return None

        except sr.UnknownValueError:

            print("Could not understand.")
            return None

        except Exception as e:

            print("Speech Error:", e)
            return None

# =========================================================
# LANGUAGE COMMANDS
# =========================================================
def detect_language_command(text):

    global language_code
    global language_name
    global voice_name

    t = text.lower()

    # =====================================================
    # JAPANESE
    # =====================================================
    if "explain in japanese" in t or "speak in japanese" in t:

        language_code = "ja-JP"
        language_name = "Japanese"
        voice_name = "ja-JP-Neural2-B"

        return "Japanese mode activated."

    # =====================================================
    # KOREAN
    # =====================================================
    elif "explain in korean" in t or "speak in korean" in t:

        language_code = "ko-KR"
        language_name = "Korean"
        voice_name = "ko-KR-Neural2-B"

        return "Korean mode activated."

    # =====================================================
    # FILIPINO
    # =====================================================
    elif (
        "explain in filipino" in t
        or "explain in tagalog" in t
        or "speak in filipino" in t
        or "speak in tagalog" in t
    ):

        language_code = "fil-PH"
        language_name = "Filipino"
        voice_name = "fil-PH-Standard-A"

        return "Filipino mode activated."

    # =====================================================
    # CHINESE
    # =====================================================
    elif "explain in chinese" in t or "speak in chinese" in t:

        language_code = "cmn-CN"
        language_name = "Chinese"
        voice_name = "cmn-CN-Wavenet-A"

        return "Chinese mode activated."

    # =====================================================
    # ENGLISH
    # =====================================================
    elif "explain in english" in t or "speak in english" in t:

        language_code = "en-US"
        language_name = "English"
        voice_name = "en-US-Neural2-C"

        return "English mode activated."

    return None

# =========================================================
# WAKE WORD DETECTION
# =========================================================
def wait_for_wake_word():

    print("\n[Waiting for wake word: ROBOT]")

    while True:

        text = listen()

        if not text:
            continue

        if "robot" in text:

            greeting = "Yes? How can I help you?"

            print(f"\nAI: {greeting}")

            speak(greeting)

            return

# =========================================================
# SEARCH IMAGES
# =========================================================
def search_images(query, count=5):

    headers = {
        "Authorization": PEXELS_API_KEY
    }

    url = (
        f"https://api.pexels.com/v1/search"
        f"?query={query}&per_page={count}"
    )

    try:

        response = requests.get(
            url,
            headers=headers
        )

        # =================================================
        # CHECK RESPONSE
        # =================================================
        if response.status_code != 200:

            print(
                f"Pexels API Error: "
                f"{response.status_code}"
            )

            return []

        data = response.json()

        image_urls = []

        # =================================================
        # EXTRACT IMAGES
        # =================================================
        if "photos" in data:

            for photo in data["photos"]:

                image_urls.append(
                    photo["src"]["large"]
                )

        return image_urls

    except Exception as e:

        print("Search Image Error:", e)

        return []

# =========================================================
# DOWNLOAD IMAGES
# =========================================================
def download_images(image_urls):

    os.makedirs("slides", exist_ok=True)

    old_files = glob.glob("slides/*")

    for f in old_files:
        os.remove(f)

    downloaded_files = []

    for i, url in enumerate(image_urls):

        try:

            img_data = requests.get(url).content

            filename = f"slides/slide_{i}.jpg"

            with open(filename, "wb") as f:
                f.write(img_data)

            downloaded_files.append(filename)

        except Exception as e:

            print("Download Error:", e)

    return downloaded_files

# =========================================================
# GENERATE NARRATION
# =========================================================
def generate_narration(topic):

    prompt = f"""
You are an educational AI teacher.

Explain this topic:

{topic}

IMPORTANT:
- Reply ONLY in {language_name}
- Keep response to ONLY 1-3 sentences
- Conversational and engaging
- Easy to understand
- No bullet points
- No numbering
- One paragraph only
"""

    try:

        response = model.generate_content(prompt)

        return response.text.strip()

    except Exception as e:

        print("Gemini Error:", e)

        return "I am having trouble generating a response."

# =========================================================
# SLIDESHOW
# =========================================================
def slideshow(images, narration):

    cv2.namedWindow(
        "AI Presentation",
        cv2.WINDOW_NORMAL
    )

    cv2.setWindowProperty(
        "AI Presentation",
        cv2.WND_PROP_FULLSCREEN,
        cv2.WINDOW_FULLSCREEN
    )

    print(f"\nAI: {narration}")

    speech_thread = threading.Thread(
        target=speak,
        args=(narration,)
    )

    speech_thread.start()

    image_index = 0

    while speech_thread.is_alive():

        img = cv2.imread(images[image_index])

        if img is not None:

            img = cv2.resize(
                img,
                (1920, 1080)
            )

            cv2.imshow(
                "AI Presentation",
                img
            )

        key = cv2.waitKey(2000)

        if key == 27:
            break

        image_index = (
            image_index + 1
        ) % len(images)

    speech_thread.join()

    cv2.destroyAllWindows()

# =========================================================
# PRESENT TOPIC
# =========================================================
def present_topic(topic):

    print("\nSearching images...")

    image_urls = search_images(topic)

    if not image_urls:

        msg = "I could not find images."

        print(f"\nAI: {msg}")

        speak(msg)

        return

    print("Downloading images...")

    images = download_images(image_urls)

    print("Generating narration...")

    narration = generate_narration(topic)

    intro = f"Now presenting {topic}"

    print(f"\nAI: {intro}")

    speak(intro)

    slideshow(images, narration)

# =========================================================
# CONVERSATION SESSION
# =========================================================
def conversation_session():

    print("\n[Conversation Started]")

    while True:

        user_input = listen()

        if not user_input:
            continue

        # =================================================
        # LANGUAGE COMMANDS
        # =================================================
        command_response = detect_language_command(
            user_input
        )

        if command_response:

            print(f"\nAI: {command_response}")

            speak(command_response)

            continue

        # =================================================
        # QUIT PROGRAM
        # =================================================
        if "quit" in user_input:

            shutdown = "Shutting down."

            print(f"\nAI: {shutdown}")

            speak(shutdown)

            return False

        # =================================================
        # END SESSION
        # =================================================
        if (
            "goodbye" in user_input
            or "bye" in user_input
            or "stop" in user_input
        ):

            goodbye = "Goodbye."

            print(f"\nAI: {goodbye}")

            speak(goodbye)

            return True

        # =================================================
        # CLEAN TOPIC
        # =================================================
        topic = user_input

        replacements = [
            "tell me about",
            "teach me about",
            "explain",
            "what is"
        ]

        for r in replacements:

            topic = topic.replace(r, "")

        topic = topic.strip()

        if len(topic) < 2:

            msg = "Please give a topic."

            print(f"\nAI: {msg}")

            speak(msg)

            continue

        # =================================================
        # START PRESENTATION
        # =================================================
        present_topic(topic)

# =========================================================
# MAIN PROGRAM
# =========================================================
def main():

    print("\n====================================")
    print("MULTILINGUAL AI PRESENTATION SYSTEM")
    print("====================================")
    print("Wake word : robot")
    print("Say goodbye = end session")
    print("Say quit = terminate program")
    print("")
    print("Language commands:")
    print("- Explain in Korean")
    print("- Explain in Japanese")
    print("- Explain in Filipino")
    print("- Explain in Chinese")
    print("- Explain in English")
    print("====================================")

    while True:

        wait_for_wake_word()

        continue_program = conversation_session()

        if not continue_program:
            break

# =========================================================
# START PROGRAM
# =========================================================
if __name__ == "__main__":
    main()