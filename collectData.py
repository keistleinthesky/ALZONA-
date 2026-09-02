import cv2
import mediapipe as mp
import numpy as np
import csv

from display_utils import display_frame

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
# DRAWING UTILITIES
# =========================================================
mp_drawing = mp.solutions.drawing_utils

# =========================================================
# CSV FILE
# =========================================================
csv_file = "hand_gesture_data.csv"

# =========================================================
# CREATE CSV HEADERS
# =========================================================
headers = ['label']

# 21 landmarks × (x,y,z)
for i in range(21):
    headers += [f'x{i}', f'y{i}', f'z{i}']

# Distance features
distance_headers = [

    "dist_wrist_thumb",
    "dist_wrist_index",
    "dist_wrist_middle",
    "dist_wrist_ring",
    "dist_wrist_pinky",

    "dist_thumb_index",
    "dist_index_middle",
    "dist_middle_ring",
    "dist_ring_pinky"

]

headers += distance_headers

# Direction vectors
for finger in ["thumb", "index", "middle", "ring", "pinky"]:

    headers += [
        f"{finger}_vec_x",
        f"{finger}_vec_y",
        f"{finger}_vec_z"
    ]

# Face distance features
headers += [

    "face_wrist_distance",

    "face_thumb_distance",
    "face_index_distance",
    "face_middle_distance",
    "face_ring_distance",
    "face_pinky_distance"

]

# =========================================================
# CREATE CSV
# =========================================================
with open(csv_file, mode='w', newline='') as file:

    writer = csv.writer(file)

    writer.writerow(headers)

print("CSV initialized.")

# =========================================================
# LABELS
# =========================================================
labels = {

    'q': 'who',
    'w': 'how',
    'e': 'is',
    'r': 'what',
    't': 'when',
    'y': 'where',
    'u': 'history',
    'i': 'national',
    'o': 'costume',
    'p': 'colonized',
    'a': 'dance',
    's': 'song',
    'd': 'celebration',
    'f': 'arts',
    'g': 'culture',
    'h': 'manner',
    'j': 'beliefs',
    'k': 'indigenous',
    'l': 'true',
    'z': 'exist',
    'x': 'discover',
    'c': 'ressa',
    "A": "A",
    "B": "B",
    "C": "C",
    "D": "D",
    "E": "E",
    "F": "F",
    "G": "G",
    "H": "H",
    "I": "I",
    "J": "J",
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
    "Z":"clear"

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

    # =====================================================
    # RAW LANDMARKS
    # =====================================================
    features.extend(landmarks.flatten())

    # =====================================================
    # DISTANCE FEATURES
    # =====================================================
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

    # =====================================================
    # DIRECTION VECTORS
    # =====================================================
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

    # =====================================================
    # FACE DISTANCES
    # =====================================================
    if face_center is not None:

        wrist = landmarks[0]

        # Wrist to face
        face_distance = np.linalg.norm(
            wrist - face_center
        )

        features.append(face_distance)

        # Fingertips to face
        fingertips = [4, 8, 12, 16, 20]

        for tip in fingertips:

            tip_distance = np.linalg.norm(
                landmarks[tip] - face_center
            )

            features.append(tip_distance)

    else:

        # If no face detected
        features.extend([0] * 6)

    return features

# =========================================================
# SAVE FEATURES
# =========================================================
def save_features(label, features):

    with open(csv_file, mode='a', newline='') as file:

        writer = csv.writer(file)

        row = [label] + features

        writer.writerow(row)

    print(f"Saved: {label}")

# =========================================================
# CAMERA
# =========================================================
cap = cv2.VideoCapture(0)

label = None

frame_count = 0

print("=================================================")
print("HAND + FACE DATA COLLECTION")
print("=================================================")

for key, value in labels.items():

    print(f"{key} -> {value}")

print("\nESC -> Quit")
print("N -> Skip Frame")

# =========================================================
# MAIN LOOP
# =========================================================
while cap.isOpened():

    ret, frame = cap.read()

    if not ret:
        print("Failed to read camera.")
        break

    # Flip frame
    frame = cv2.flip(frame, 1)

    # RGB conversion
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

            # Nose landmark
            nose = face_landmarks.landmark[1]

            face_center = np.array([
                nose.x,
                nose.y,
                nose.z
            ])

            # Draw face mesh
            mp_drawing.draw_landmarks(
                frame,
                face_landmarks,
                mp_face_mesh.FACEMESH_CONTOURS,

                mp_drawing.DrawingSpec(
                    color=(0,255,255),
                    thickness=1,
                    circle_radius=1
                ),

                mp_drawing.DrawingSpec(
                    color=(255,255,255),
                    thickness=1
                )
            )

    # =====================================================
    # HAND DETECTION
    # =====================================================
    hand_result = hands.process(rgb_frame)

    if hand_result.multi_hand_landmarks:

        for hand_landmarks in hand_result.multi_hand_landmarks:

            # Extract landmarks
            landmarks = []

            for lm in hand_landmarks.landmark:

                landmarks.append([
                    lm.x,
                    lm.y,
                    lm.z
                ])

            landmarks = np.array(landmarks)

            # Normalize
            normalized_landmarks = normalize_landmarks(
                landmarks
            )

            # Compute features
            features = compute_features(
                normalized_landmarks,
                face_center
            )

            # Save features
            if label is not None:

                save_features(label, features)

            # Draw hands
            mp_drawing.draw_landmarks(
                frame,
                hand_landmarks,
                mp_hands.HAND_CONNECTIONS,

                mp_drawing.DrawingSpec(
                    color=(255,0,0),
                    thickness=1,
                    circle_radius=3
                ),

                mp_drawing.DrawingSpec(
                    color=(255,150,230),
                    thickness=2
                )
            )

    # =====================================================
    # DISPLAY LABEL
    # =====================================================
    if label is not None:

        cv2.putText(
            frame,
            f"Label: {labels[label]}",
            (10,50),
            cv2.FONT_HERSHEY_SIMPLEX,
            1,
            (255,0,0),
            2
        )

    else:

        cv2.putText(
            frame,
            "No Label",
            (10,50),
            cv2.FONT_HERSHEY_SIMPLEX,
            1,
            (0,0,255),
            2
        )

    # =====================================================
    # SHOW FRAME
    # =====================================================
    display_frame(frame, "Collect Hand + Face Data")

    # =====================================================
    # KEYBOARD INPUT
    # =====================================================
    key = cv2.waitKey(1) & 0xFF

    # ESC = Quit
    if key == 27:
        break

    # N = Skip
    elif key == ord('n'):

        label = None

        print("Skipping frame.")

    # Set label
    elif chr(key) in labels:

        label = chr(key)

        print(f"Current Label: {labels[label]}")

    frame_count += 1

# =========================================================
# CLEANUP
# =========================================================
cap.release()
cv2.destroyAllWindows()