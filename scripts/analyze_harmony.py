# -*- coding: utf-8 -*-
"""Measure a song's recorded parts and write its manifest and contours.

    python scripts/analyze_harmony.py silent-night

The manifest in source/harmony has always said its numbers came from
"scripts/analyze_harmony". That script did not exist - the numbers for Lupang
Hinirang were measured once by hand and never written down as code. This is
it, written when a second song arrived and the measuring had to happen again.

For each part it finds where the singing starts, how long it runs, the first
sung pitch, and a note-by-note contour. It then reports whether the parts line
up with each other, which is the thing that decides whether they can be played
together at all: the engine starts every part at the same offset, so takes
recorded to different tempos cannot be rescued by a manifest.

Nothing is written unless --write is passed.
"""
import argparse
import json
import math
import os
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HARMONY = os.path.join(HERE, "source", "harmony")
PARTS = ("soprano", "alto", "tenor", "bass")

FRAME = 2048
HOP = 512
MIN_HZ, MAX_HZ = 60.0, 1100.0
# Below this a frame is silence rather than a quiet note. Set from the takes:
# the room noise floor sits around 0.002 and sung notes above 0.02.
SILENCE_RMS = 0.012
# A note has to last this long to be a note and not a slide between two.
MIN_NOTE = 0.09
# A rest every part shares has to last this long to be a phrase end rather
# than the gap between two words. Calibrated against Lupang Hinirang, whose
# ten boundaries were measured by hand before this code existed: 0.10 finds
# all ten and invents none. 0.35, picked to match the panel's hold window,
# found two - the rests between phrases are breath-length, not pauses.
MIN_GAP = 0.10
# Boundaries closer together than this are the same rest. It matches the
# window Leader.jsx treats a boundary as occupying, so two inside it could
# never be told apart anyway.
BOUNDARY_APART = 0.35


def load(path):
    audio, rate = sf.read(path, dtype="float32", always_2d=True)
    return audio.mean(axis=1), rate


def rms_envelope(x, hop=HOP, frame=FRAME):
    n = 1 + max(0, (len(x) - frame) // hop)
    out = np.empty(n, dtype=np.float32)
    for i in range(n):
        w = x[i * hop:i * hop + frame]
        out[i] = math.sqrt(float(np.dot(w, w)) / max(1, len(w)))
    return out


def first_sound(env, rate, hop=HOP, hold=4):
    """Start of the first stretch of sound that lasts - not a click."""
    loud = env > SILENCE_RMS
    run = 0
    for i, v in enumerate(loud):
        run = run + 1 if v else 0
        if run >= hold:
            return (i - hold + 1) * hop / rate
    return 0.0


def last_sound(env, rate, hop=HOP, hold=4):
    loud = env > SILENCE_RMS
    run = 0
    for i in range(len(loud) - 1, -1, -1):
        run = run + 1 if loud[i] else 0
        if run >= hold:
            return (i + hold) * hop / rate
    return len(env) * hop / rate


def pitch(frame_x, rate):
    """Autocorrelation with an octave guard. Returns Hz, or 0."""
    x = frame_x - frame_x.mean()
    if math.sqrt(float(np.dot(x, x)) / len(x)) < SILENCE_RMS:
        return 0.0
    x = x * np.hanning(len(x))
    n = 1 << (2 * len(x) - 1).bit_length()
    spec = np.fft.rfft(x, n)
    ac = np.fft.irfft(spec * np.conjugate(spec))[:len(x)]
    if ac[0] <= 0:
        return 0.0
    ac = ac / ac[0]

    lo = int(rate / MAX_HZ)
    hi = min(len(ac) - 1, int(rate / MIN_HZ))
    if hi <= lo + 2:
        return 0.0

    seg = ac[lo:hi]
    peak = int(np.argmax(seg)) + lo
    if ac[peak] < 0.3:
        return 0.0

    # Prefer an earlier lag only when it is nearly as strong: the true period,
    # not a multiple of it heard an octave down. 0.85 was too generous and let
    # a harmonic win - it read a bass part's opening D3 as a D#5.
    for lag in range(lo, peak):
        if ac[lag] >= ac[peak] * 0.95:
            peak = lag
            break

    a, b, c = ac[peak - 1], ac[peak], ac[peak + 1]
    shift = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) else 0.0
    hz = rate / (peak + shift)
    return hz if MIN_HZ <= hz <= MAX_HZ else 0.0


def midi_of(hz):
    return 69 + 12 * math.log2(hz / 440.0)


NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


def note_name(midi):
    m = int(round(midi))
    return "%s%d" % (NAMES[m % 12], m // 12 - 1)


def contour(x, rate):
    """[{t, d, midi, name}] - the notes as sung."""
    times, midis = [], []
    for i in range(0, max(0, len(x) - FRAME), HOP):
        hz = pitch(x[i:i + FRAME], rate)
        times.append(i / rate)
        midis.append(round(midi_of(hz)) if hz else None)

    notes, run_start, run_midi = [], None, None
    for t, m in list(zip(times, midis)) + [(times[-1] + HOP / rate if times else 0, None)]:
        if m != run_midi:
            if run_midi is not None and run_start is not None:
                d = t - run_start
                if d >= MIN_NOTE:
                    notes.append({"t": round(run_start, 2), "d": round(d, 2),
                                  "midi": run_midi, "name": note_name(run_midi)})
            run_midi, run_start = m, t
    return notes


def shared_rests(envs, rate, lead_in, hop=HOP):
    """Where EVERY part is quiet at once, in playhead seconds.

    A rest in one voice is not a phrase end - the others are still singing
    through it, and stopping there cuts them off mid-word. Only a gap the
    whole ensemble shares is somewhere the music can wait.

    Times are returned from the first sung note, not from the top of the
    file, because that is the clock the panel's playhead runs on.
    """
    n = min(len(e) for e in envs)
    quiet = np.ones(n, dtype=bool)
    for e in envs:
        quiet &= e[:n] <= SILENCE_RMS

    out, run_start = [], None
    for i in range(n):
        if quiet[i]:
            if run_start is None:
                run_start = i
            continue
        if run_start is not None:
            t0, t1 = run_start * hop / rate, i * hop / rate
            if t1 - t0 >= MIN_GAP:
                out.append(round(t0 - lead_in, 2))
            run_start = None

    # A run reaching the end of the file is the silence after the last note,
    # not a phrase end - there is nothing left to come back for.
    out = [t for t in out if t > 0]

    # Two boundaries inside the panel's own 0.35s window are one boundary: a
    # single breath that a frame popping over the threshold split in two.
    # Bahay Kubo came out with 17.50 and 17.68 in it, which is one rest.
    merged = []
    for t in out:
        if not merged or t - merged[-1] >= BOUNDARY_APART:
            merged.append(t)
    return merged


def analyse(path):
    x, rate = load(path)
    env = rms_envelope(x, )
    start = first_sound(env, rate)
    end = last_sound(env, rate)

    # The first sung pitch: the MEDIAN over the first second of singing, not
    # the first frame that happens to return something. One frame is a coin
    # toss - a breath, the attack of the note, a gate opening - and this
    # number is what she sounds for the singer to tune to, so a wrong one is
    # worse than none. Voting across the opening note throws the outliers out.
    heard = []
    i = int((start + 0.10) * rate)
    while i < len(x) - FRAME and i < int((start + 1.10) * rate):
        hz = pitch(x[i:i + FRAME], rate)
        if hz:
            heard.append(hz)
        i += HOP
    hz = float(np.median(heard)) if heard else 0.0

    return {
        "file": os.path.basename(path),
        "seconds": round(len(x) / rate, 2),
        "starts": round(start, 2),
        "ends": round(end, 2),
        "sings_for": round(end - start, 2),
        "start_hz": round(hz, 1),
        "start_note": note_name(midi_of(hz)) if hz else "?",
        "notes": contour(x, rate),
        "env": env,
        "rate": rate,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("song", help="folder under source/harmony, e.g. silent-night")
    ap.add_argument("--write", action="store_true",
                    help="write manifest.json and contours.json")
    ap.add_argument("--title", default=None)
    a = ap.parse_args()

    folder = os.path.join(HARMONY, a.song)
    if not os.path.isdir(folder):
        sys.exit("No such song folder: " + folder)

    found = {}
    for p in PARTS:
        for ext in (".wav", ".mp3", ".m4a"):
            f = os.path.join(folder, p + ext)
            if os.path.isfile(f):
                found[p] = f
                break

    if not found:
        sys.exit("No part recordings in " + folder)

    out = sys.stdout
    out.write("part      file        length   sings      start   first note\n")
    res = {}
    for p in PARTS:
        if p not in found:
            continue
        r = analyse(found[p])
        res[p] = r
        out.write("%-9s %-11s %6.2fs  %6.2fs  %6.2fs  %-4s %.1f Hz  (%d notes)\n"
                  % (p, r["file"], r["seconds"], r["sings_for"], r["starts"],
                     r["start_note"], r["start_hz"], len(r["notes"])))

    # Do these takes belong to one performance?
    out.write("\n")
    if len(res) > 1:
        spans = {p: r["sings_for"] for p, r in res.items()}
        widest = max(spans.values()) - min(spans.values())
        out.write("sung length differs by %.2fs across the parts\n" % widest)
        if widest > 1.5:
            out.write("  THEY DO NOT LINE UP. Every part is started at the same\n"
                      "  offset, so takes of different lengths drift apart and\n"
                      "  cannot be played together whatever the manifest says.\n")
        else:
            out.write("  close enough to play together; the lead-in below lines\n"
                      "  up their first notes.\n")

    if not a.write:
        out.write("\n(nothing written — pass --write)\n")
        return

    lead_in = round(min(r["starts"] for r in res.values()), 2)
    rate = next(iter(res.values()))["rate"]
    bounds = shared_rests([r["env"] for r in res.values()], rate, lead_in)
    manifest = {
        "_comment": "Measured by scripts/analyze_harmony.py. Regenerate if the "
                    "recordings are replaced.",
        "song": a.title or a.song.replace("-", " ").title(),
        "duration": round(max(r["ends"] for r in res.values()), 2),
        "sample_rate": 44100,
        "lead_in": lead_in,
        "_lead_in_note": "Seconds of silence before the first sung note. "
                         "Playback starts here so the downbeat lands with the "
                         "singer.",
        "beats_per_bar": 4,
        "parts": {p: {"file": os.path.splitext(r["file"])[0] + ".mp3",
                      "start_note": r["start_note"],
                      "start_hz": r["start_hz"]}
                  for p, r in res.items()},
        "phrase_boundaries": bounds,
        "_boundaries_note": "Gaps present in EVERY part, in seconds from the "
                            "first sung note — safe places to stop the "
                            "ensemble without cutting a word.",
    }
    with open(os.path.join(folder, "manifest.json"), "w", encoding="utf-8",
              newline="\n") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")

    contours = {p: {"notes": r["notes"],
                    "midi_range": [min(n["midi"] for n in r["notes"]),
                                   max(n["midi"] for n in r["notes"])]
                    if r["notes"] else [0, 0]}
                for p, r in res.items()}
    with open(os.path.join(folder, "contours.json"), "w", encoding="utf-8",
              newline="\n") as f:
        json.dump(contours, f, indent=1, ensure_ascii=False)
        f.write("\n")

    out.write("\nwrote manifest.json and contours.json in %s\n" % folder)


if __name__ == "__main__":
    main()
