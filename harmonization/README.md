# The harmonisation

ALZONA sings real recorded voice parts against a live singer. One spoken
sentence carries everything:

> **"Alzona, harmonize with me in silent night in alto"**

She sounds the recording's own opening note so the singer can tune to it,
counts four beats, and begins. The recording then **follows the singer**:
it waits when they stop and picks up when they start again.

---

## Read it in this order

| Folder | What is in it |
| --- | --- |
| **1-browser** | Everything that must happen within a beat of a sound |
| **2-backend** | Interpreting the spoken command |
| **3-analysis** | Measuring recordings into the numbers both sides read |
| **4-data** | What a song is, as data |

### Why the split is where it is

The listening, the pitch tracking and the playback all live in the
browser. An upload round trip is too slow to sing against — by the time a
server had heard a note and answered, the singer would be two notes past
it. The backend never hears a single sung note. It reads the sentence
that asks for the song and nothing more.

---

## 1-browser

| File | Lines | |
| --- | --- | --- |
| `Leader.jsx` | 795 | The panel and the take itself |
| `harmonyPlayer.js` | 242 | Playback: start together, hold, resume |
| `HarmonyChart.jsx` | 263 | The singer's pitch against hers, live |
| `pitch.js` | 228 | Pitch detection from the microphone |
| `selfVoice.js` | 97 | Knowing when the sound is her own |
| `partColors.js` | 12 | One colour per voice part |

**`Leader.jsx` is the one to read first.** The constants near the top are
the whole behaviour of a take:

| | | |
| --- | --- | --- |
| `SILENCE_PAUSE` | 1.2s | Stop this long and the recording waits — above a breath, below feeling sluggish |
| `SILENCE_END` | 10.0s | Only this much silence ends the take |
| `SUSTAIN_HOLD` | 0.5s | A note held at a phrase end is worth waiting for |
| `NO_SHOW_STOP` | 12.0s | Count-in over and nobody sang — stop rather than play to an empty room |
| `LYRIC_LEAD` | 0.4s | How far ahead of a line its words appear |

Two things in there are not obvious and were both bugs first:

- The microphone is **asked for before it is taken**. Announcing after
  opening it gave speech recognition no chance to let go.
- The words on screen show the **latest line whose turn has come**, not
  the line whose window contains this instant. Matching the window left
  the screen blank in every rest between lines.

## 2-backend

`harmony_commands.py` — the five functions from `main.py`, in the order
they run. Pulled out so the command handling reads as one piece.

What it does: which song, which parts, and the note that part actually
opens on. Asked for a part a song was never recorded in, it says what
there is instead of agreeing and then singing silence.

## 3-analysis

`analyze_harmony.py` — run it whenever recordings change:

```bash
gsp-env\Scripts\python.exe scripts/analyze_harmony.py <song> --write
```

It writes `manifest.json` and `contours.json`, and says whether the parts
line up with each other at all. That last part matters most: takes sung
to different tempos cannot be rescued by a manifest, and the script says
so rather than letting them through.

A phrase boundary is a rest **every part shares**. A rest in one voice is
not a phrase end — the others are still singing through it, and stopping
there cuts them off mid-word.

## 4-data

`songs.json` is the whole song list. Adding a song is an entry here plus a
folder of recordings; no code changes.

Each song also has, beside its recordings:

| | |
| --- | --- |
| `manifest.json` | measured: lead-in, each part's opening note, shared rests |
| `contours.json` | the notes as sung, for the chart |
| `lyrics.json` | the sung words with their times |
| `lyrics_en.txt` | the second line on screen, plain text, hand-edited |

---

## Everything here is a copy

The program runs from the paths named at the top of each file, never from
this folder, and nothing imports anything in it. It exists so the feature
can be read in one place and in a sensible order, which the live tree
cannot offer — the harmonisation is spread across a React panel, a corner
of a 3,800-line FastAPI file, and a script.

Regenerate after changing any of them:

```bash
python scripts/collect_harmonization.py
```

A copy that has drifted from the code it was copied from is worse than no
copy at all, because it reads as true.
