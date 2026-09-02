import cv2
from ffpyplayer.player import MediaPlayer
from display_utils import display_frame

def play_video_with_volume(video_path):

    cap = cv2.VideoCapture(video_path)

    if not cap.isOpened():
        print("Cannot open video.")
        return

    # fixed volume = 0.5
    player = MediaPlayer(video_path, ff_opts={'volume': 0.5})

    while True:

        ret, frame = cap.read()

        if not ret:
            print("Video ended.")
            break

        # keep audio running
        audio_frame, val = player.get_frame()

        display_frame(frame, "BAYBAYIN")

        # ESC to exit
        if cv2.waitKey(25) & 0xFF == 27:
            break

    cap.release()
    cv2.destroyAllWindows()


# =========================
# RUN VIDEO
# =========================

video_path = "./source/teaching_baybayin.mp4"
play_video_with_volume(video_path)
