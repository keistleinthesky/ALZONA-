# ALZONA

**A**ndroid for **L**earners as **Z**one and **O**asis of **N**ational **A**rchives — a humanoid robot assistant for Philippine and Croatian culture and history, built for WRO 2026 by DYCI Novus.

A FastAPI backend drives the camera, voice and AI; a React front-end is the operator console.

## Features

- **Conversational AI** — Gemini-backed Q&A specialising in Philippine and Croatian history, with general world knowledge. Answers are capped at 25 words, or 50 when the question asks for detail.
- **Multilingual voice** — speech recognition and replies in English, Filipino, Bisaya, Ilonggo, Kapampangan, Waray, Bicolano, Japanese, Korean and Chinese. Wake with a greeting plus her name ("Hello Alzona"); release with "Thank you, Alzona".
- **Baybayin translation** — renders a word in the pre-colonial script, shows it on screen and prints it.
- **Coin identification** — hold a coin to the camera for country, denomination, year, featured symbol and historical significance, one sentence each.
- **Lupang Hinirang** — live pitch detection with a colour-coded SATB chart, plus:
  - *Sing back* — synthesises whatever you just sang, in your key
  - *Harmonise* — plays recorded soprano/alto/tenor/bass against your melody, in any combination, pausing when you pause and resuming when you carry on
- **Knowledge library** — upload `.txt`, `.md`, `.csv`, `.pdf`, `.docx`, `.jsonl` and ALZONA searches them before answering.
- **Face, age and gender detection** via OpenCV DNN and MediaPipe.

## Requirements

- Windows (printing and the launcher are Windows-specific)
- Python 3.11
- Node.js 18+
- A webcam and microphone
- A Google Gemini API key

## Setup

```bash
python -m venv gsp-env
gsp-env\Scripts\python.exe -m pip install -r requirements.txt
cd dycinovus && npm install && cd ..
copy .env.example .env
```

Then edit `.env` and add your Gemini API key.

### Assets not in this repo

To keep the repository small, these are excluded and must be supplied separately:

| Path | What it is |
|---|---|
| `age_net.caffemodel`, `gender_net.caffemodel` | Pre-trained age/gender nets (~87 MB) |
| `hand_gesture_model.pkl`, `hand_gesture_data.csv` | Gesture model and training data (~27 MB) |
| `source/videos/` | Folk-dance footage (~455 MB) |

The app runs without them; the corresponding features stay disabled.

## Running

```bash
start.bat
```

Opens the backend on port 5002 and the site on port 5173, then launches the browser. Use Chrome or Edge — voice input needs the Web Speech API.

## Layout

| Path | Purpose |
|---|---|
| `main.py` | Backend: API, camera, voice, AI routing, printing |
| `dycinovus/src/App.jsx` | Operator console |
| `dycinovus/src/Voice.jsx` | Wake word, speech recognition, spoken replies |
| `dycinovus/src/Sing.jsx` | Sing-back and harmony |
| `dycinovus/src/pitch.js` | Pitch detection (`node src/pitch.test.mjs` to test) |
| `dycinovus/src/harmonyPlayer.js` | Recorded-harmony playback, count-in, pause/resume |
| `dycinovus/src/HarmonyChart.jsx` | Colour-coded SATB pitch chart |
| `source/harmony/` | Recorded SATB parts and their analysis |
| `knowledge/` | Documents ALZONA searches when answering |

## Voice commands

| Say | Result |
|---|---|
| "Hello Alzona" | Wakes her |
| "Translate mabuhay to Baybayin" | Renders and prints the script |
| "What coin is this?" | Identifies the coin in view |
| "Harmonize with me in soprano" | One part |
| "Harmonize with me in tenor and bass" | Any combination |
| "Harmonize with me in all parts" | Full SATB |
| "Thank you, Alzona" | Back to standby |

## Notes

- Voice defaults to Gemini "Leda". ElevenLabs is supported but off; set `USE_ELEVENLABS=1` with a key to enable.
- Baybayin auto-printing is on. Set `BAYBAYIN_AUTOPRINT=0` to keep it on screen only.
- Use headphones when harmonising, or the microphone hears the harmony instead of you.
