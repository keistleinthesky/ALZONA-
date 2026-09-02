from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from fastapi import HTTPException

from display_utils import display_frame

import threading

import cv2
import time
import serial
import mediapipe as mp

from google.cloud import speech
from google.cloud import texttospeech
from google import genai

import uuid
import os
import io
import uvicorn

from google.oauth2 import service_account

# =====================================================
# CONFIG
# =====================================================

GEMINI_API_KEY = "AIzaSyB-Y5rd-cNTc0ZA1R8R5vpkztE012l_yPw"
FASTAPI_PORT = int(os.getenv("FASTAPI_PORT", "8001"))

os.makedirs("audio", exist_ok=True)

# Open webcam
webcam = cv2.VideoCapture(0, cv2.CAP_DSHOW)

face_state = "idle"
running = True

chat = False

# Change COM3 to your Arduino port
# arduino = serial.Serial('COM3', 9600, timeout=1)
# time.sleep(2)

# Age Recog
age_result = None

ageProto = "age_deploy.prototxt"
ageModel = "age_net.caffemodel"

MODEL_MEAN_VALUES = (78.4263377603,87.7689143744,114.895847746)

ageList = ['(0-2)','(4-6)','(8-12)','(15-20)','(25-32)','(38-43)','(48-53)','(60-100)']
ageNet = cv2.dnn.readNetFromCaffe(ageProto,ageModel)

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

# =====================================================
# CLIENTS
# =====================================================


credentials = service_account.Credentials.from_service_account_file(
    "dyciroboticsteam-82e1fa8b4c0c.json"
)

speech_client = speech.SpeechClient(
    credentials=credentials
)

tts_client = texttospeech.TextToSpeechClient(
    credentials=credentials
)

gemini_client = genai.Client(
    api_key=GEMINI_API_KEY
)

# =====================================================
# FASTAPI
# =====================================================

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount(
    "/audio",
    StaticFiles(directory="audio"),
    name="audio"
)

state_lock = threading.Lock()
frame_lock = threading.Lock()
latest_frame_bytes = None
latest_camera_frame_bytes = None


def get_runtime_state():

    with state_lock:
        return {
            "face_state": face_state,
            "age_result": age_result,
            "chat": chat,
            "running": running,
        }


@app.post("/frame")
async def upload_frame(frame: UploadFile = File(...)):
    frame_bytes = await frame.read()

    if not frame_bytes:
        raise HTTPException(status_code=400, detail="Empty frame upload")

    global latest_frame_bytes

    with frame_lock:
        latest_frame_bytes = frame_bytes

    return {
        "success": True,
        "bytes": len(frame_bytes),
    }


@app.get("/frame")
def get_latest_frame():
    with frame_lock:
        if latest_frame_bytes is None:
            raise HTTPException(status_code=404, detail="No frame uploaded yet")

        return StreamingResponse(
            io.BytesIO(latest_frame_bytes),
            media_type="image/jpeg",
        )


def generate_frames():
    while True:
        with frame_lock:
            frame_bytes = latest_camera_frame_bytes

        if frame_bytes is None:
            time.sleep(0.05)
            continue

        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n\r\n" + frame_bytes + b"\r\n"
        )

        time.sleep(0.05)

# =====================================================
# STT
# =====================================================

def transcribe_audio(audio_bytes):

    audio = speech.RecognitionAudio(
        content=audio_bytes
    )

    config = speech.RecognitionConfig(
        encoding=speech.RecognitionConfig.AudioEncoding.WEBM_OPUS,
        sample_rate_hertz=48000,
        language_code="en-US"
    )

    response = speech_client.recognize(
        config=config,
        audio=audio
    )

    if not response.results:
        return ""

    return response.results[0].alternatives[0].transcript

# =====================================================
# GEMINI
# =====================================================

def ask_gemini(prompt):

    response = gemini_client.models.generate_content(
        model="gemini-3-flash",
        contents=prompt
    )

    return response.text

# =====================================================
# TTS
# =====================================================

def text_to_speech(text):

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

    filename = f"{uuid.uuid4()}.mp3"

    filepath = os.path.join(
        "audio",
        filename
    )

    with open(filepath, "wb") as f:
        f.write(response.audio_content)

    return filename

def face_detection_loop():

    global face_state, running, age_result, latest_camera_frame_bytes

    webcam = cv2.VideoCapture(0, cv2.CAP_DSHOW)

    present_face = False
    no_face_start = None

    face_seen_start = None
    age_checked = False

    while running:

        ret, frame = webcam.read()
        if not ret:
            continue

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = face_mesh.process(rgb)

        if results.multi_face_landmarks:

            landmarks = results.multi_face_landmarks[0]
            h, w = frame.shape[:2]

            xs = [lm.x * w for lm in landmarks.landmark]
            ys = [lm.y * h for lm in landmarks.landmark]

            x1 = max(0, int(min(xs)))
            y1 = max(0, int(min(ys)))
            x2 = min(w - 1, int(max(xs)))
            y2 = min(h - 1, int(max(ys)))

            if x2 > x1 and y2 > y1:
                cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
                cv2.putText(
                    frame,
                    "Face detected",
                    (x1, max(30, y1 - 10)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.8,
                    (0, 255, 0),
                    2,
                    cv2.LINE_AA,
                )

            mp_drawing.draw_landmarks(
                frame,
                landmarks,
                mp_face_mesh.FACEMESH_CONTOURS,
                landmark_drawing_spec=None,
                connection_drawing_spec=mp_drawing_styles.get_default_face_mesh_contours_style(),
            )

            if not present_face:
                print("Face detected")
        
            present_face = True
            no_face_start = None

            face_state = "ressa"

            if face_seen_start is None:
                face_seen_start = time.time()

            if (
                not age_checked and
                time.time() - face_seen_start >= 5
            ):

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

        display_frame(frame, "AI Camera")

        if cv2.waitKey(1) & 0xFF == 27:
            running = False
            break

        success, encoded_frame = cv2.imencode(".jpg", frame)
        if success:
            with frame_lock:
                latest_camera_frame_bytes = encoded_frame.tobytes()

    webcam.release()
    cv2.destroyAllWindows()

def command():
    global face_state, chat

    if face_state == "ressa":
        chat = True

    elif face_state == "goodbye":
        chat = False 

    else:
        return

# =====================================================
# MAIN ENDPOINT
# =====================================================

@app.post("/chat")
async def chat(
    audio: UploadFile = File(...)
):

    try:

        audio_bytes = await audio.read()

        # 1. Speech -> Text
        user_text = transcribe_audio(
            audio_bytes
        )

        if not user_text:
            return {
                "success": False,
                "message": "No speech detected"
            }

        print("USER:", user_text)

        # 2. Gemini
        ai_response = ask_gemini(
            user_text
        )

        print("AI:", ai_response)

        # 3. Text -> Speech
        filename = text_to_speech(
            ai_response
        )

        audio_url = (
            f"http://localhost:{FASTAPI_PORT}/audio/{filename}"
        )

        return {
            "success": True,
            "user_text": user_text,
            "response_text": ai_response,
            "audio_url": audio_url
        }

    except Exception as e:

        return {
            "success": False,
            "error": str(e)
        }

@app.get("/command")
def get_command_status():
    state = get_runtime_state()
    return {
        "status": state["face_state"],
        **state,
    }


@app.get("/state")
def get_state():
    return get_runtime_state()

# =====================================================
# HEALTH CHECK
# =====================================================

@app.get("/")
def root():
    return {
        "status": "running"
    }

@app.get("/video")
def video_feed():  
    return StreamingResponse(
        generate_frames(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )


# =====================================================
# RUN
# =====================================================


@app.on_event("startup")
async def startup_event():

    threading.Thread(
        target=face_detection_loop,
        daemon=True
    ).start()

    print("Face detection started")


if __name__ == "__main__":
    uvicorn.run(
        "website:app",
        host="127.0.0.1",
        port=FASTAPI_PORT,
        reload=True,
    )

