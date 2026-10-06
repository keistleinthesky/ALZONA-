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
- **Sing with me** — a live harmony for *any* song, in two modes (it picks your
  part and takes the other, or you name the part), and a **separate program**
  from this console. See below.
- **Knowledge library** — upload `.txt`, `.md`, `.csv`, `.pdf`, `.docx`, `.jsonl` and ALZONA searches them before answering.
- **Face, age and gender detection** via OpenCV DNN and MediaPipe.

## Sing with me — the live harmoniser

A second, self-contained program that shares only the audio engine with the
console. No backend, no camera, no API key, no network — open it and sing.

```bash
cd dycinovus && npm run harmonizer
```

Then open <http://localhost:5180>. The console keeps 5173; both can run at once.

It works out the key from your singing — no score and no song list — and shifts
your own voice into a second line, choosing the interval note by note so it stays
in the key. About 30ms behind you. Two ways to ask:

**Sing back.** Say nothing. It hears the note you start on, works out which part
that makes you, and takes the other one. Start on G4 and you are the soprano, so
it sings alto; start on the alto line and it sings soprano back at you. Tenor and
bass answer each other the same way.

**Harmonise.** Name the part — soprano, alto, tenor, bass, or several at once —
and it sings that, whatever you are singing.

The four parts are anchored on the notes each one starts Lupang Hinirang on
(`source/harmony/manifest.json`: soprano G4, alto D4, tenor B3, bass G3), so
"alto" means where the alto actually sits in this arrangement. It never doubles
you in unison or at the octave — a named part always comes back as a real
harmony line, so asking for bass under a G4 gives a tenth rather than the same
note lower down.

This is the opposite approach to the Lupang Hinirang panel above, on purpose:
that one plays *recorded* SATB parts and has to find your place in one fixed
song; this one knows no songs at all and works on anything you sing.

Two things worth knowing:

- **Use headphones.** Through speakers the microphone hears the harmony as well
  as you, and it starts harmonising with itself.
- **Open it on `localhost` or over https.** On a plain `http://` network address
  the browser blocks the microphone outright, so the page can only tell you so.

## Chord finder — harmony by genetic algorithm

A third program, and the only one that needs nothing at all: no backend, no API
key, no recordings, no microphone, no network.

```bash
cd dycinovus && npm run chordga
```

Then open <http://localhost:5181>. All three can run at once.

You type a melody; it searches for the **chords** that go under it. Not a
lookup — it starts from a few hundred random progressions, scores each one,
breeds the good ones together and mutates a little, eighty times over. The page
steps the generations one animation frame at a time so you can watch a
progression assemble itself out of noise, which is the only part of this that
explains what a genetic algorithm is.

Melodies are typed the way you would say them: `C4 C4 G4 G4 | A4 A4 G4:2`.
`:2` is a two-beat note, `-` is a rest, and barlines are ignored — type them
wherever they help you read. Four presets are built in. It works out the key
itself, using the same Krumhansl-Kessler correlation that follows a singer in
the live harmoniser.

Everything it believes about music is six numbers, and all six are sliders on
the page:

| Term | What it says |
|---|---|
| Congruence | melody notes should be chord tones, weighted by length and stress |
| Flow | tonic → subdominant → dominant → tonic, and V never falls back to IV |
| Cadence | it opens at home and, above all, closes properly |
| Variety | not the same chord twelve times |
| Motion | roots that move by fifths and steps rather than sitting still |
| Idiom | chords people actually play — diminished triads are rare |

Two things worth knowing:

- **It cannot harmonise you while you sing, and never will.** A search needs the
  whole phrase before it can score anything, and it tries about 115,000
  progressions per run. Singing live is what "Sing with me" above is for; the
  two are solving different problems at opposite ends of the latency scale.
- **Congruence does not reach 1.00, and should not.** A bar of `F F E E` has no
  diatonic triad containing both notes, so about 0.5 is the best any chord can
  do there. The page shows the ceiling next to the score — 0.55 of a possible
  0.62 on Twinkle — because otherwise the number reads as a failure when it is
  the melody talking.


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
| `dycinovus/harmonizer/` | "Sing with me" — the standalone live harmoniser |
| `dycinovus/vite.harmonizer.config.js` | Its dev server and build (port 5180) |
| `dycinovus/chordga/` | "Chord finder" — the genetic-algorithm harmoniser |
| `dycinovus/vite.chordga.config.js` | Its dev server and build (port 5181) |
| `dycinovus/src/chordGA.js` | The search and its fitness function (`node src/chordGA.test.mjs`) |
| `dycinovus/src/melodyText.js` | Typed-melody notation (`node src/melodyText.test.mjs`) |
| `dycinovus/src/chordSynth.js` | Web Audio synth for hearing a generated progression |
| `dycinovus/src/harmonyVoice.js` | PSOLA pitch shifter, runs as an AudioWorklet |
| `dycinovus/src/harmonyBrain.js` | Key detection and scale-correct intervals |
| `dycinovus/src/liveHarmony.js` | Wires microphone → shifter → speakers |
| `dycinovus/src/liveMic.js` | Opens a microphone and checks it is not silent |
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
- `cd dycinovus && for f in src/*.test.mjs; do node "$f"; done` runs the audio
  tests. `singWithMe.test.mjs` is the end-to-end one: it sings a phrase through
  the whole live-harmony chain and checks which notes came back.
