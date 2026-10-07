# -*- coding: utf-8 -*-
"""Gather the harmonisation into harmonization/, in labelled folders.

    python scripts/collect_harmonization.py

Everything here is a COPY. The program runs from the paths named at the
top of each file, never from this folder, and nothing imports anything in
it. It exists so the feature can be read in one place and in a sensible
order, which the live tree cannot offer - the harmonisation is spread
across a React panel, a corner of a 3,800-line FastAPI file and a script.

Re-run it after changing any of them. A copy that drifts from the code it
was copied from is worse than no copy, because it reads as true.
"""
import io
import os
import re
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "harmonization")

# folder, source path, one line on what it is for
BROWSER = [
    ("1-browser", "dycinovus/lab/leader/Leader.jsx",
     "The panel, and the take itself: songs, voice parts, the count-in, the "
     "words on the camera frame, waiting when the singer stops and picking "
     "up when they start again."),
    ("1-browser", "dycinovus/lab/leader/harmonyPlayer.js",
     "Playback. Loads a song's manifest, contours and audio, starts every "
     "part on the same sample, holds at a phrase end and resumes."),
    ("1-browser", "dycinovus/lab/leader/HarmonyChart.jsx",
     "The live chart: the singer's pitch drawn against the parts she sings."),
    ("1-browser", "dycinovus/lab/src/pitch.js",
     "Pitch detection from the microphone. NSDF, an octave guard, and a "
     "named reason for every frame it throws away."),
    ("1-browser", "dycinovus/lab/src/selfVoice.js",
     "Knowing when the sound in the room is hers, so she never tracks her "
     "own voice or answers it."),
    ("1-browser", "dycinovus/lab/src/partColors.js",
     "One colour per voice part, shared by the chart and the buttons."),
]

ANALYSIS = [
    ("3-analysis", "scripts/analyze_harmony.py",
     "Measures a song's recordings into manifest.json and contours.json: "
     "where each part starts, the note it opens on, the rests every part "
     "shares, and whether the takes line up with each other at all."),
]

DATA = [
    ("4-data", "source/harmony/songs.json",
     "Every song, the names she answers to, which parts exist, and where a "
     "song stops if not at the end of its recording."),
    ("4-data", "source/harmony/manifest.json",
     "Lupang Hinirang, measured. One manifest per song; the others sit in "
     "their own folders beside their recordings."),
]

# The harmony functions inside main.py, in the order they run.
BACKEND_FUNCS = [
    ("parse_sing_parts", "Which voice parts the command named."),
    ("_load_songs", "Reads songs.json at startup, and each song's manifest "
                    "with it, so the opening note of every part is known "
                    "without opening a file per question."),
    ("detect_sing_song", "Which song was asked for, matched longest alias "
                         "first so a two-word name is never half-matched."),
    ("_spoken_list", "A list of parts, read aloud."),
    ("detect_sing_command", "The whole command. Which song, which parts, "
                            "the note that part opens on - and sing back "
                            "kept to the people who actually ask for it."),
]


def header(src_rel, why):
    return (
        "// " if src_rel.endswith((".js", ".jsx")) else "# "
    ).join([""]) + ""


def banner(src_rel, why, comment):
    bar = comment + " " + "=" * 68
    lines = [bar,
             comment + " A COPY. The program runs this file from:",
             comment + "     " + src_rel,
             comment + " Nothing imports it from here. Regenerate with:",
             comment + "     python scripts/collect_harmonization.py",
             comment + " " + "-" * 68]
    for chunk in _wrap(why, 68):
        lines.append(comment + " " + chunk)
    lines.append(bar)
    return "\n".join(lines) + "\n\n"


def _wrap(text, width):
    words, line, out = text.split(), "", []
    for w in words:
        if len(line) + len(w) + 1 > width:
            out.append(line)
            line = w
        else:
            line = (line + " " + w).strip()
    if line:
        out.append(line)
    return out


if os.path.isdir(OUT):
    shutil.rmtree(OUT)

copied = 0
for folder, rel, why in BROWSER + ANALYSIS + DATA:
    dest_dir = os.path.join(OUT, folder)
    os.makedirs(dest_dir, exist_ok=True)
    body = io.open(os.path.join(ROOT, rel), encoding="utf-8").read()
    name = os.path.basename(rel)
    if rel.endswith(".json"):
        # JSON takes no comments, so the note goes beside it.
        io.open(os.path.join(dest_dir, name), "w", encoding="utf-8",
                newline="\n").write(body)
        io.open(os.path.join(dest_dir, name + ".txt"), "w", encoding="utf-8",
                newline="\n").write(
            "A COPY of %s\n\n%s\n" % (rel, "\n".join(_wrap(why, 70))))
    else:
        comment = "//" if rel.endswith((".js", ".jsx")) else "#"
        io.open(os.path.join(dest_dir, name), "w", encoding="utf-8",
                newline="\n").write(banner(rel, why, comment) + body)
    copied += 1

# The backend, pulled out of main.py into one readable file.
src = io.open(os.path.join(ROOT, "main.py"), encoding="utf-8").read()
be_dir = os.path.join(OUT, "2-backend")
os.makedirs(be_dir, exist_ok=True)
parts = [banner("main.py (the harmony functions only)",
                "The backend interprets the spoken command and owns the song "
                "list. That is all it does for this feature: the listening, "
                "the pitch tracking and the playback never leave the browser, "
                "because an upload round trip is too slow to sing against.",
                "#")]
for fn, why in BACKEND_FUNCS:
    m = re.search(r"^def %s\(.*?(?=^\S)" % re.escape(fn), src, re.S | re.M)
    if not m:
        continue
    parts.append("# " + "-" * 68 + "\n# %s\n" % why + "# " + "-" * 68 + "\n")
    parts.append(m.group(0).rstrip() + "\n\n")

m = re.search(r"    sing = detect_sing_command\(transcript\).*?"
              r'return \{"mode": "sing".*?\}\n', src, re.S)
if m:
    parts.append("# " + "-" * 68 + "\n"
                 "# Inside route_command: the sentence she says back. It\n"
                 "# names the song it is about to arm and the note that part\n"
                 "# actually opens on, and turns down a part the song was\n"
                 "# never recorded in rather than agreeing and then singing\n"
                 "# silence.\n# " + "-" * 68 + "\n")
    parts.append(m.group(0))

io.open(os.path.join(be_dir, "harmony_commands.py"), "w", encoding="utf-8",
        newline="\n").write("".join(parts))
copied += 1

total = 0
for folder, _, files in os.walk(OUT):
    for f in files:
        if f.endswith((".jsx", ".js", ".py")):
            total += io.open(os.path.join(folder, f),
                             encoding="utf-8").read().count("\n")

print("wrote %s" % OUT)
print("%d files, about %d lines of code" % (copied, total))
