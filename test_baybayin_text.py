# -*- coding: utf-8 -*-
"""Baybayin writes sounds, not Roman letters. Run: python test_baybayin_text.py

Every expectation here is a syllable count as much as a spelling. "Jeremy" is
three characters because it is three sounds - the M and the Y at the end are
one of them, not two - and the test fails if it ever goes back to spelling the
word out letter by letter.
"""
import io
import os
import sys

from baybayin_text import split_syllables

GLYPHS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "source", "BAYBAYIN")

CASES = [
    # --- a syllable is a sound, not a letter -------------------------------
    ("Jeremy",     ["he", "re", "mi"]),   # the my is one sound: mi
    ("Mary",       ["ma", "ri"]),
    ("Emily",      ["e", "mi", "li"]),
    ("gym",        ["gi", "m"]),
    # ...but a y after a vowel really is a glide, and keeps its own character
    ("bahay",      ["ba", "ha", "y"]),
    ("siya",       ["si", "ya"]),
    ("mayroon",    ["ma", "y", "ro", "o", "n"]),

    # --- ng is one letter ---------------------------------------------------
    ("ang",        ["a", "ng"]),
    ("ngipin",     ["ngi", "pi", "n"]),
    ("ngayon",     ["nga", "yo", "n"]),
    ("pangalan",   ["pa", "nga", "la", "n"]),
    # the double g of mangga is the ng of mang meeting the g of ga - two
    # sounds, so it must NOT collapse the way a doubled letter does
    ("mangga",     ["ma", "ng", "ga"]),
    ("tanggap",    ["ta", "ng", "ga", "p"]),
    ("bangka",     ["ba", "ng", "ka"]),

    # --- a doubled letter is one sound --------------------------------------
    ("Betty",      ["be", "ti"]),
    ("Cherry",     ["t", "se", "ri"]),

    # --- a vowel beside a vowel is two syllables ----------------------------
    ("oo",         ["o", "o"]),
    ("paano",      ["pa", "a", "no"]),

    # --- letters Baybayin has no sound for become the sound they make -------
    ("Filipino",   ["pi", "li", "pi", "no"]),
    ("Jose",       ["ho", "se"]),
    ("Quezon",     ["ke", "so", "n"]),
    ("Victoria",   ["bi", "k", "to", "ri", "a"]),
    ("Zamboanga",  ["sa", "m", "bo", "a", "nga"]),
    ("Anthony",    ["a", "n", "to", "ni"]),
    ("Niño",       ["ni", "n", "yo"]),
    ("Novus",      ["no", "bu", "s"]),

    # --- clusters take the virama -------------------------------------------
    ("prito",      ["p", "ri", "to"]),
    ("trans",      ["t", "ra", "n", "s"]),

    # --- plain Tagalog, unchanged -------------------------------------------
    ("mahal",      ["ma", "ha", "l"]),
    ("kapatid",    ["ka", "pa", "ti", "d"]),
    ("araw",       ["a", "ra", "w"]),
    ("bahay kubo", ["ba", "ha", "y", "ku", "bo"]),
]


def main():
    out = io.open(1, "w", encoding="utf-8", closefd=False)
    have = {os.path.splitext(f)[0].lower() for f in os.listdir(GLYPHS)}
    failed = 0

    for word, want in CASES:
        got = split_syllables(word)

        if got != want:
            failed += 1
            out.write("%-12s got  %s\n%-12s want %s\n"
                      % (word, " ".join(got), "", " ".join(want)))
            continue

        # A syllable with no glyph on disk is skipped when the sheet is drawn,
        # so the word would print silently incomplete.
        missing = [s for s in got if s not in have]

        if missing:
            failed += 1
            out.write("%-12s no glyph for %s\n" % (word, ", ".join(missing)))

    out.write("%d of %d words wrong\n" % (failed, len(CASES)))
    out.flush()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
