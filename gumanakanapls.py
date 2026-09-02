import cv2
import mediapipe as mp
# import os
import time
from display_utils import display_frame




def detect_faces(frame, face_detection):
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = face_detection.process(rgb_frame)
    bboxs = []


    if results.detections:
        frameHeight, frameWidth = frame.shape[:2]


        for detection in results.detections:
            bbox = detection.location_data.relative_bounding_box
            x1 = int(bbox.xmin * frameWidth)
            y1 = int(bbox.ymin * frameHeight)
            x2 = int((bbox.xmin + bbox.width) * frameWidth)
            y2 = int((bbox.ymin + bbox.height) * frameHeight)


            x1 = max(0, min(x1, frameWidth - 1))
            y1 = max(0, min(y1, frameHeight - 1))
            x2 = max(0, min(x2, frameWidth - 1))
            y2 = max(0, min(y2, frameHeight - 1))


            if x2 > x1 and y2 > y1:
                bboxs.append([x1, y1, x2, y2])
                # cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 1)


    return frame, bboxs


ageProto = "age_deploy.prototxt"
ageModel = "age_net.caffemodel"


MODEL_MEAN_VALUES = (78.4263377603, 87.7689143744, 114.895847746)
ageList = ['(0-2)', '(4-6)', '(8-12)', '(15-20)', '(25-32)', '(38-43)', '(48-53)', '(60-100)']


FACE_CONFIRM_SECONDS = 5
face_seen_start = None
age_label = None


# if not os.path.exists(ageProto) or not os.path.exists(ageModel):
#     missing = [p for p in [ageProto, ageModel] if not os.path.exists(p)]
#     print(f"ERROR: Missing age model files: {missing}")
#     raise SystemExit(1)


# try:
ageNet = cv2.dnn.readNetFromCaffe(ageProto, ageModel)
# except cv2.error as e:
#     print(f"ERROR: Failed to load age model '{ageModel}' with proto '{ageProto}'.")
#     print(f"age_proto_size={os.path.getsize(ageProto)} bytes, age_model_size={os.path.getsize(ageModel)} bytes")
#     print("If the model file is corrupted, replace 'age_net.caffemodel' with a valid Caffe age model.")
#     print(e)
#     raise SystemExit(1)


video = cv2.VideoCapture(0)


mp_face_detection = mp.solutions.face_detection


with mp_face_detection.FaceDetection(
    model_selection=0,
    min_detection_confidence=0.7
) as face_detection:


    while True:
        ret, frame = video.read()
        if not ret:
            print("Failed to grab frame.")
            break


        frame, bboxs = detect_faces(frame, face_detection)


        if len(bboxs) > 0:
            if face_seen_start is None:
                face_seen_start = time.time()
                age_label = None
            elif age_label is None and time.time() - face_seen_start >= FACE_CONFIRM_SECONDS:
                x1, y1, x2, y2 = bboxs[0]
                if x2 > x1 and y2 > y1:
                    face = frame[y1:y2, x1:x2]
                    if face.size != 0 and face.shape[0] != 0 and face.shape[1] != 0:
                        blob = cv2.dnn.blobFromImage(face, 1.0, (227, 227), MODEL_MEAN_VALUES, swapRB=False)


                        ageNet.setInput(blob)
                        agePreds = ageNet.forward()
                        age = ageList[agePreds[0].argmax()]


                        if age in ['(38-43)', '(48-53)', '(60-100)']:
                            age_label = "MANO"
                           
                        else:
                            age_label = "GREET"
                        print(f"Age range: {age} -> {age_label}")
        else:
            face_seen_start = None
            age_label = None


        # if age_label is not None and len(bboxs) > 0:
        #     bbox = bboxs[0]
        #     cv2.putText(frame, age_label, (bbox[0], bbox[1]-10), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2, cv2.LINE_AA)


        display_frame(frame, "Face Detection")


        key = cv2.waitKey(1)
        if key == ord('q'):
            print("Exiting...")
            break


video.release()
cv2.destroyAllWindows()





