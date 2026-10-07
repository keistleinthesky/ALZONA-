# ====================================================================
# A COPY. The program runs this file from:
#     main.py (the harmony functions only)
# Nothing imports it from here. Regenerate with:
#     python scripts/collect_harmonization.py
# --------------------------------------------------------------------
# The backend interprets the spoken command and owns the song list.
# That is all it does for this feature: the listening, the pitch
# tracking and the playback never leave the browser, because an upload
# round trip is too slow to sing against.
# ====================================================================

# --------------------------------------------------------------------
# Which voice parts the command named.
# --------------------------------------------------------------------
def parse_sing_parts(text):
    """Pull every SATB part named in a command, in SATB order.

    Handles one part ("in soprano"), several ("tenor and bass"), and the
    all-parts shorthands. Returns [] when no part is named.
    """
    t = (text or "").lower()
    # "all parts" / "everyone" / "full choir" -> the whole ensemble.
    if any(w in t for w in ("all parts", "all part", "everyone", "everybody",
                            "full choir", "whole choir", "all voices",
                            "all of them", "lahat", "buong choir", "satb")):
        return list(SATB_PARTS)
    found = [p for p in SATB_PARTS if p in t]
    # "base" is how the user says (and spells) bass.
    if "bass" not in found and re.search(r"\bbase\b", t):
        found.append("bass")
    # Keep canonical SATB order regardless of the order they were spoken.
    return [p for p in SATB_PARTS if p in found]

# --------------------------------------------------------------------
# Reads songs.json at startup, and each song's manifest with it, so the opening note of every part is known without opening a file per question.
# --------------------------------------------------------------------
def _load_songs():
    path = os.path.join(BASE, "source", "harmony", "songs.json")
    try:
        with open(path, encoding="utf-8") as f:
            songs = json.load(f).get("songs", [])
    except Exception as e:
        print("Harmony songs.json unreadable:", str(e)[:120])
        return []
    for sg in songs:
        # Longest first, so "lupang hinirang" wins over the "lupang" that
        # sits inside it and a two-word name is never half-matched.
        sg["aliases"] = sorted(
            {a.lower() for a in sg.get("aliases", [])} | {sg["title"].lower()},
            key=len, reverse=True)

        # The opening note of each part, so she can name the right one. A
        # song with no manifest keeps an empty dict and she simply does not
        # claim a note, which is better than naming the wrong one.
        sg["start_notes"] = {}
        mpath = os.path.join(BASE, "source", "harmony", sg.get("dir", ""),
                             "manifest.json")
        try:
            with open(mpath, encoding="utf-8") as f:
                for part, info in json.load(f).get("parts", {}).items():
                    if info.get("start_note"):
                        sg["start_notes"][part] = info["start_note"]
        except Exception:
            pass
    return songs

# --------------------------------------------------------------------
# Which song was asked for, matched longest alias first so a two-word name is never half-matched.
# --------------------------------------------------------------------
def detect_sing_song(text):
    """Which song was asked for, or None if the command did not name one."""
    t = (text or "").lower()
    for sg in HARMONY_SONGS:
        for alias in sg["aliases"]:
            if alias in t:
                return sg
    return None

# --------------------------------------------------------------------
# A list of parts, read aloud.
# --------------------------------------------------------------------
def _spoken_list(items):
    """["soprano", "alto"] -> "soprano and alto", for reading aloud."""
    items = list(items)
    if not items:
        return "nothing"
    if len(items) == 1:
        return items[0]
    return " and ".join([", ".join(items[:-1]), items[-1]])

# --------------------------------------------------------------------
# The whole command. Which song, which parts, the note that part opens on - and sing back kept to the people who actually ask for it.
# --------------------------------------------------------------------
def detect_sing_command(text):
    """Recognise a singing command. Returns a dict the frontend uses to arm
    its listener, or None."""
    t = (text or "").lower()

    # Sing back has to be ASKED for by name. It used to be anything
    # containing "sing", which swallowed "sing Silent Night in soprano alto
    # tenor and bass" - a plain harmony request - and answered it with the
    # sing-back line, naming Lupang Hinirang at that.
    sing_back = any(w in t for w in ("sing back", "sing it back", "imitate",
                                     "copy me", "repeat after", "follow me",
                                     "gayahin", "ulitin"))
    harmonize = any(w in t for w in ("harmonize", "harmony", "harmonise",
                                     "sabayan", "boses", "sing with"))
    # On a word boundary: "singkil" is a dance, not an instruction to sing.
    # The dance answer happens to be checked first, so this has never shown,
    # but it should not depend on the order of two unrelated features.
    asks = bool(re.search(r"\b(?:sing|kanta|kantahin|awit|awitin)\b", t))

    song = detect_sing_song(text)
    named = parse_sing_parts(text)

    if sing_back and not harmonize:
        return {"mode": "imitate", "parts": [], "part": None, "offset": 0,
                "song": song["id"] if song else None,
                "song_title": song["title"] if song else None,
                "reference_note": SING_REFERENCE_NOTE,
                "reference_hz": SING_REFERENCE_HZ,
                "beats_per_bar": 4}

    if not (harmonize or song or named or asks):
        return None

    # Naming no song takes the first one with recordings, which is what
    # every command meant before there was more than one song.
    if song is None:
        song = next((sg for sg in HARMONY_SONGS if sg.get("ready")), None)

    # Only the parts this song was actually recorded in. Bahay Kubo has a
    # soprano and nothing else, and agreeing to sing its alto produces
    # silence at the moment of singing - the worst place to find out.
    have = [p for p in SATB_PARTS
            if p in ((song or {}).get("start_notes") or {})]
    missing = [p for p in named if have and p not in have]
    parts = [p for p in named if p in have] if have else list(named)
    if not parts:
        parts = (["alto"] if "alto" in have else have[:1]) if have else ["alto"]

    return {"mode": "harmonize", "parts": parts,
            # The note this part actually opens on, so the sentence she says
            # and the note the panel sounds are the same note.
            "start_note": (song or {}).get("start_notes", {}).get(parts[0]),
            "missing_parts": missing,
            "available_parts": have,
            "song": song["id"] if song else None,
            "song_title": song["title"] if song else None,
            "song_ready": bool(song and song.get("ready")),
            # Kept for the synth fallback when a recording is missing.
            "part": parts[0], "offset": SATB_OFFSETS[parts[0]],
            "reference_note": SING_REFERENCE_NOTE,
            "reference_hz": SING_REFERENCE_HZ,
            "beats_per_bar": 4}

# --------------------------------------------------------------------
# Inside route_command: the sentence she says back. It
# names the song it is about to arm and the note that part
# actually opens on, and turns down a part the song was
# never recorded in rather than agreeing and then singing
# silence.
# --------------------------------------------------------------------
    sing = detect_sing_command(transcript)
    if sing:
        if sing["mode"] == "harmonize":
            parts = sing["parts"]
            if len(parts) == 1:
                who = parts[0]
            elif len(parts) == len(SATB_PARTS):
                who = "all four parts"
            else:
                who = " and ".join([", ".join(parts[:-1]), parts[-1]])
            title = sing.get("song_title") or "Lupang Hinirang"
            if not sing.get("song_ready", True):
                reply = f"I don't have {title} recorded yet."
            else:
                # Asked for a part this song was never recorded in: say what
                # there is rather than agreeing and then singing nothing.
                head = ""
                if sing.get("missing_parts"):
                    head = (f"I only have {_spoken_list(sing['available_parts'])} "
                            f"recorded for {title}, so ")
                note = sing.get("start_note")
                # No note known means no manifest, and a sentence that says
                # "starting on" and then no note is worse than not saying it.
                tail = f" Starting on {note}, four four time." if note \
                    else " Four four time."
                # "...for Bahay Kubo, so sing it" — the title has just been
                # said, and saying it twice in one breath reads as a stutter.
                what = "it" if head else title
                reply = (f"{head}{'' if head else 'Okay — '}sing {what} and "
                         f"I'll harmonize with you in {who}.{tail}")
        else:
            # Sing back names the song that was asked for too. The workbench
            # console has no sing back at all and says so when this arrives.
            back = sing.get("song_title") or "Lupang Hinirang"
            reply = f"Sing a line of {back} and I'll sing it back to you."
        return {"mode": "sing", "reply": reply, "sing": sing}
