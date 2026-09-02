import cv2
import mediapipe as mp
import numpy as np
import joblib
import time
import os
import uuid
import google.generativeai as genai
from google.cloud import texttospeech
import pygame

from display_utils import display_frame

# =========================================================
# GOOGLE CLOUD CREDENTIALS
# =========================================================
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "dyciroboticsteam-82e1fa8b4c0c.json"

# =========================================================
# GEMINI API
# =========================================================
genai.configure(api_key="AIzaSyB-Y5rd-cNTc0ZA1R8R5vpkztE012l_yPw")

generation_config = {
    "temperature": 0.3,
    "top_p": 0.95,
    "top_k": 40,
    "max_output_tokens": 2000,
}

model = genai.GenerativeModel(
    model_name="gemini-3-flash-preview",
    generation_config=generation_config,
    system_instruction="""
You are RESSA.

Rules:
- Reply in 1-2 sentences. Summarize and be concise.
- Reply conversationally.
- Be accurate and direct.
- You are sign language AI assistant, aiming to help with the informations regarding the indigenous culture, history, beliefs, manner, arts, dance, costume, and celebrations of the Philippines.
- Avoid using asterisk. Explain it in a paragraph. Conversationally.
- When "Hello, RESSA!" is said, reply "Hi, how can I assist you today?".
"""
)

chat_session = model.start_chat(history=[])

# =========================================================
# GOOGLE TTS
# =========================================================
tts_client = texttospeech.TextToSpeechClient()

pygame.mixer.init()

# =========================================================
# LOAD TRAINED MODEL
# =========================================================
clf = joblib.load("hand_gesture_model.pkl")

# =========================================================
# MEDIAPIPE HANDS
# =========================================================
mp_hands = mp.solutions.hands

hands = mp_hands.Hands(
    static_image_mode=False,
    max_num_hands=2,
    min_detection_confidence=0.7,
    min_tracking_confidence=0.7
)

# =========================================================
# MEDIAPIPE FACE MESH
# =========================================================
mp_face_mesh = mp.solutions.face_mesh

face_mesh = mp_face_mesh.FaceMesh(
    static_image_mode=False,
    max_num_faces=1,
    refine_landmarks=True,
    min_detection_confidence=0.7,
    min_tracking_confidence=0.7
)

# =========================================================
# DRAWING
# =========================================================
mp_drawing = mp.solutions.drawing_utils

# =========================================================
# LABEL MAP
# =========================================================
label_map = {

    "A": "A",
    "B": "B",
    "C": "C",
    "D": "D",
    "E": "E",
    "F": "F",
    "G": "G",
    "H": "H",
    "I": "I",
    "K": "K",
    "L": "L",
    "M": "M",
    "N": "N",
    "O": "O",
    "P": "P",
    "Q": "Q",
    "R": "R",
    "S": "S",
    "T": "T",
    "U": "U",
    "V": "V",
    "W": "W",
    "X": "X",
    "Y": "Y",

    # SPECIAL SIGNS
    "Z": "CLEAR",
    "J": "RESSA",
    "c": "ENTER"
}

# =========================================================
# NORMALIZE LANDMARKS
# =========================================================
def normalize_landmarks(landmarks):

    landmarks = np.array(landmarks)

    wrist = landmarks[0]

    normalized = landmarks - wrist

    max_value = np.max(np.abs(normalized))

    if max_value != 0:
        normalized = normalized / max_value

    return normalized

# =========================================================
# FEATURE EXTRACTION
# =========================================================
def compute_features(landmarks, face_center=None):

    features = []

    # RAW LANDMARKS
    features.extend(landmarks.flatten())

    # DISTANCE FEATURES
    important_pairs = [

        (0,4),
        (0,8),
        (0,12),
        (0,16),
        (0,20),

        (4,8),
        (8,12),
        (12,16),
        (16,20)
    ]

    for p1, p2 in important_pairs:

        distance = np.linalg.norm(
            landmarks[p1] - landmarks[p2]
        )

        features.append(distance)

    # DIRECTION VECTORS
    finger_pairs = [

        (0,4),
        (0,8),
        (0,12),
        (0,16),
        (0,20)
    ]

    for p1, p2 in finger_pairs:

        vector = landmarks[p2] - landmarks[p1]

        features.extend(vector.tolist())

    # FACE DISTANCE FEATURES
    if face_center is not None:

        wrist = landmarks[0]

        face_distance = np.linalg.norm(
            wrist - face_center
        )

        features.append(face_distance)

        fingertips = [4, 8, 12, 16, 20]

        for tip in fingertips:

            tip_distance = np.linalg.norm(
                landmarks[tip] - face_center
            )

            features.append(tip_distance)

    else:

        features.extend([0] * 6)

    return np.array(features)

# =========================================================
# TEXT TO SPEECH
# =========================================================
def synthesize_speech(text):

    output_file = "ressa_speak.mp3"

    # remove existing single-file voice before creating new one
    if os.path.exists(output_file):
        os.remove(output_file)

    synthesis_input = texttospeech.SynthesisInput(
        text=text
    )

    voice = texttospeech.VoiceSelectionParams(
        language_code="en-US",
        name="en-US-Neural2-F"
    )

    audio_config = texttospeech.AudioConfig(
        audio_encoding=texttospeech.AudioEncoding.MP3
    )

    response = tts_client.synthesize_speech(
        input=synthesis_input,
        voice=voice,
        audio_config=audio_config
    )

    with open(output_file, "wb") as out:
        out.write(response.audio_content)

    return output_file

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
# ASK GEMINI
# =========================================================
def ask_gemini(prompt):

    try:

        response = chat_session.send_message(prompt)

        reply = response.text.strip()

        print("\nRESSA:", reply)

        audio = synthesize_speech(reply)

        play_audio(audio)

    except Exception as e:

        print("Gemini Error:", e)

# =========================================================
# SENTENCE VARIABLES
# =========================================================
sentence = []

last_prediction = ""
last_added_time = time.time()

prediction_delay = 1.2
confidence_threshold = 0.60

wake_active = False

# =========================================================
# CAMERA
# =========================================================
cap = cv2.VideoCapture(0)

print("=================================================")
print("RESSA SIGN LANGUAGE AI")
print("=================================================")
print("RESSA -> Wake RESSA")
print("CLEAR -> Clear sentence")
print("ENTER -> Send to Gemini")
print("ESC -> Quit")
print("=================================================")

# =========================================================
# MAIN LOOP
# =========================================================
while cap.isOpened():

    ret, frame = cap.read()

    if not ret:
        break

    frame = cv2.flip(frame, 1)

    rgb_frame = cv2.cvtColor(
        frame,
        cv2.COLOR_BGR2RGB
    )

    # =====================================================
    # FACE DETECTION
    # =====================================================
    face_result = face_mesh.process(rgb_frame)

    face_center = None

    if face_result.multi_face_landmarks:

        for face_landmarks in face_result.multi_face_landmarks:

            nose = face_landmarks.landmark[1]

            face_center = np.array([
                nose.x,
                nose.y,
                nose.z
            ])

    # =====================================================
    # HAND DETECTION
    # =====================================================
    hand_result = hands.process(rgb_frame)

    if hand_result.multi_hand_landmarks:

        for hand_landmarks in hand_result.multi_hand_landmarks:

            landmarks = []

            for lm in hand_landmarks.landmark:

                landmarks.append([
                    lm.x,
                    lm.y,
                    lm.z
                ])

            landmarks = np.array(landmarks)

            # =================================================
            # NORMALIZE
            # =================================================
            normalized_landmarks = normalize_landmarks(
                landmarks
            )

            # =================================================
            # FEATURES
            # =================================================
            features = compute_features(
                normalized_landmarks,
                face_center
            )

            # =================================================
            # PREDICTION
            # =================================================
            try:

                probabilities = clf.predict_proba([features])[0]

                confidence = np.max(probabilities)

                prediction = clf.predict([features])[0]

                # =================================================
                # CONFIDENCE FILTER
                # =================================================
                if confidence >= confidence_threshold:

                    gesture = label_map.get(
                        prediction,
                        "Unknown"
                    )

                else:

                    gesture = "..."

                # =================================================
                # DISPLAY CURRENT PREDICTION
                # =================================================
                cv2.putText(
                    frame,
                    f"Current: {gesture} ({confidence:.2f})",
                    (10, 50),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    1,
                    (255, 0, 0),
                    2
                )

                current_time = time.time()

                # =================================================
                # WAKE SIGN
                # =================================================
                if (
                    gesture == "RESSA"
                    and current_time - last_added_time > prediction_delay
                ):

                    wake_active = True

                    ask_gemini("Hello RESSA!")

                    sentence = []

                    last_added_time = current_time

                    print("\nWAKE SIGN DETECTED")
                    print("RESSA LISTENING...")

                # =================================================
                # CLEAR SENTENCE
                # =================================================
                elif (
                    gesture == "CLEAR"
                    and current_time - last_added_time > prediction_delay
                ):

                    sentence = []

                    last_added_time = current_time

                    print("Sentence Cleared")

                # =================================================
                # ENTER -> SEND TO GEMINI
                # =================================================
                elif (
                    gesture == "ENTER"
                    and wake_active
                    and len(sentence) > 0
                    and current_time - last_added_time > prediction_delay
                ):

                    final_text = "".join(sentence)

                    print("\nUSER:", final_text)

                    ask_gemini(final_text)

                    sentence = []

                    wake_active = False

                    last_added_time = current_time

                    print("RESSA SLEEPING...")

                # =================================================
                # BUILD SENTENCE
                # =================================================
                elif (
                    wake_active
                    and confidence >= confidence_threshold
                    and gesture not in [
                        "...",
                        "RESSA",
                        "CLEAR",
                        "ENTER"
                    ]
                    and gesture != last_prediction
                    and current_time - last_added_time > prediction_delay
                ):

                    sentence.append(gesture)

                    last_prediction = gesture

                    last_added_time = current_time

                    print(
                        "Sentence:",
                        "".join(sentence)
                    )

            except Exception as e:

                print("Prediction Error:", e)

            # =================================================
            # DRAW HAND DOTS ONLY
            # =================================================
            mp_drawing.draw_landmarks(
                frame,
                hand_landmarks,
                None,

                mp_drawing.DrawingSpec(
                    color=(255, 0, 0),
                    thickness=1,
                    circle_radius=3
                )
            )

    # =====================================================
    # DISPLAY SENTENCE
    # =====================================================
    sentence_text = "".join(sentence)

    cv2.putText(
        frame,
        f"Input: {sentence_text}",
        (10, 100),
        cv2.FONT_HERSHEY_SIMPLEX,
        2.0,
        (0, 0, 0),
        2
    )

    # =====================================================
    # STATUS DISPLAY
    # =====================================================
    status = "LISTENING" if wake_active else "SLEEPING"

    cv2.putText(
        frame,
        f"RESSA: {status}",
        (10, 150),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.5,
        (0, 0, 0),
        2
    )

    # =====================================================
    # SHOW WINDOW
    # =====================================================
    display_frame(frame, "RESSA Sign Language AI")

    # =====================================================
    # EXIT
    # =====================================================
    key = cv2.waitKey(1) & 0xFF

    if key == 27:
        break

# =========================================================
# CLEANUP
# =========================================================
cap.release()
cv2.destroyAllWindows()
