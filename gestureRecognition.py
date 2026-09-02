import cv2
import mediapipe as mp
import numpy as np
import joblib
import time

# =========================================================
# LOAD MODEL
# =========================================================
clf = joblib.load("hand_gesture_model.pkl")

# =========================================================
# MEDIAPIPE SETUP
# =========================================================
mp_hands = mp.solutions.hands

hands = mp_hands.Hands(
    static_image_mode=False,
    max_num_hands=2,
    min_detection_confidence=0.7,
    min_tracking_confidence=0.7
)

mp_drawing = mp.solutions.drawing_utils

# =========================================================
# LABEL MAP
# =========================================================
label_map = {
    "q": "who",
    "w": "how",
    "e": "is",
    "r": "what",
    "t": "when",
    "y": "where",
    "u": "history",
    "i": "national",
    "o": "costume",
    "p": "colonized",
    "a": "dance",
    "s": "song",
    "d": "celebration",
    "f": "arts",
    "g": "culture",
    "h": "manner",
    "j": "beliefs",
    "k": "indigenous",
    "l": "true",
    "z": "exist",
    "x": "discover",
    "c": "ressa"
}

# =========================================================
# NORMALIZATION
# =========================================================
def normalize_landmarks(landmarks):

    landmarks = np.array(landmarks)

    # Wrist as origin
    wrist = landmarks[0]

    normalized = landmarks - wrist

    # Scale normalization
    max_value = np.max(np.abs(normalized))

    if max_value != 0:
        normalized = normalized / max_value

    return normalized

# =========================================================
# FEATURE EXTRACTION
# =========================================================
def compute_features(landmarks):

    features = []

    # Raw landmarks
    features.extend(landmarks.flatten())

    # Distance features
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

    # Direction vectors
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

    return np.array(features)

# =========================================================
# SENTENCE VARIABLES
# =========================================================
sentence = []

last_prediction = ""
last_added_time = time.time()

prediction_delay = 1.5
confidence_threshold = 0.55

# =========================================================
# CAMERA
# =========================================================
cap = cv2.VideoCapture(0)

print("Press Q to quit")
print("Press C to clear sentence")

# =========================================================
# MAIN LOOP
# =========================================================
while cap.isOpened():

    ret, frame = cap.read()

    if not ret:
        break

    # Flip frame
    frame = cv2.flip(frame, 1)

    # Convert to RGB
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

    # Process hands
    result = hands.process(rgb_frame)

    # =====================================================
    # HAND DETECTION
    # =====================================================
    if result.multi_hand_landmarks:

        for hand_landmarks in result.multi_hand_landmarks:

            # Extract landmarks
            landmarks = []

            for lm in hand_landmarks.landmark:
                landmarks.append([lm.x, lm.y, lm.z])

            landmarks = np.array(landmarks)

            # Normalize
            normalized_landmarks = normalize_landmarks(
                landmarks
            )

            # Features
            features = compute_features(
                normalized_landmarks
            )

            # =================================================
            # PREDICTION
            # =================================================
            try:

                probabilities = clf.predict_proba([features])[0]

                confidence = np.max(probabilities)

                prediction = clf.predict([features])[0]

                gesture = label_map.get(
                    prediction,
                    "Unknown"
                )

                # Display prediction
                cv2.putText(
                    frame,
                    f"Gesture: {gesture} ({confidence:.2f})",
                    (10, 50),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    1,
                    (255, 0, 0),
                    2
                )

                # =============================================
                # BUILD SENTENCE
                # =============================================
                current_time = time.time()

                if (
                    confidence > confidence_threshold
                    and gesture != last_prediction
                    and current_time - last_added_time > prediction_delay
                ):

                    sentence.append(gesture)

                    last_prediction = gesture
                    last_added_time = current_time

                    print("Sentence:", " ".join(sentence))

            except Exception as e:
                print("Prediction Error:", e)

            # =================================================
            # DRAW HAND LANDMARKS
            # =================================================
            mp_drawing.draw_landmarks(
                frame,
                hand_landmarks,
                mp_hands.HAND_CONNECTIONS,

                mp_drawing.DrawingSpec(
                    color=(255, 0, 0),   # Blue dots
                    thickness=1,
                    circle_radius=3
                ),

                mp_drawing.DrawingSpec(
                    color=(255, 150, 230),   # Pink lines
                    thickness=2
                )
            )

    # =====================================================
    # DISPLAY SENTENCE
    # =====================================================
    sentence_text = " ".join(sentence)

    cv2.putText(
        frame,
        f"Sentence: {sentence_text}",
        (10, 100),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.8,
        (0, 255, 0),
        2
    )

    # =====================================================
    # SHOW WINDOW
    # =====================================================
    cv2.imshow(
        "Hand Gesture Recognition",
        frame
    )

    # =====================================================
    # KEYBOARD INPUT
    # =====================================================
    key = cv2.waitKey(1) & 0xFF

    # Quit
    if key == ord('q'):
        break

    # Clear sentence
    elif key == ord('c'):

        sentence = []

        print("Sentence cleared.")

# =========================================================
# CLEANUP
# =========================================================
cap.release()
cv2.destroyAllWindows()