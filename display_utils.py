import os

import cv2
import numpy as np
import requests

# =========================================================
# DISPLAY CONFIGURATION
# =========================================================
DISPLAY_WIDTH = 480
DISPLAY_HEIGHT = 270
DISPLAY_SIZE = (DISPLAY_WIDTH, DISPLAY_HEIGHT)
FASTAPI_FRAME_UPLOAD_URL = os.getenv(
    "FASTAPI_FRAME_UPLOAD_URL",
    "http://127.0.0.1:8000/frame"
)
FASTAPI_FRAME_UPLOAD_TIMEOUT = float(os.getenv("FASTAPI_FRAME_UPLOAD_TIMEOUT", "0.25"))


def display_frame(frame, window_name="Display"):
    """Display a frame locally and mirror it to FastAPI if configured."""
    resized_frame = resize_to_standard(frame)
    upload_frame_to_fastapi(resized_frame)

    cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(window_name, DISPLAY_WIDTH, DISPLAY_HEIGHT)
    cv2.imshow(window_name, resized_frame)


def upload_frame_to_fastapi(frame):
    if not FASTAPI_FRAME_UPLOAD_URL:
        return

    success, encoded = cv2.imencode(".jpg", frame)
    if not success:
        return

    try:
        requests.post(
            FASTAPI_FRAME_UPLOAD_URL,
            files={"frame": ("frame.jpg", encoded.tobytes(), "image/jpeg")},
            timeout=FASTAPI_FRAME_UPLOAD_TIMEOUT,
        )
    except requests.RequestException:
        return


def resize_to_standard(frame):
    """Resize an image/frame to the configured display size with letterboxing."""
    if frame is None:
        return np.zeros((DISPLAY_HEIGHT, DISPLAY_WIDTH, 3), dtype=np.uint8)

    h, w = frame.shape[:2]
    scale = min(DISPLAY_WIDTH / w, DISPLAY_HEIGHT / h)

    new_w = int(w * scale)
    new_h = int(h * scale)

    resized = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_AREA)
    canvas = np.ones((DISPLAY_HEIGHT, DISPLAY_WIDTH, 3), dtype=np.uint8) * 255

    y_offset = (DISPLAY_HEIGHT - new_h) // 2
    x_offset = (DISPLAY_WIDTH - new_w) // 2

    canvas[y_offset:y_offset + new_h, x_offset:x_offset + new_w] = resized
    return canvas

