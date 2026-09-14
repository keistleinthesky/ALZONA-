"""Breaking a word into the syllables Baybayin actually writes.

Baybayin is syllabic, not alphabetic. A word is broken into its SOUNDS first
and each sound gets one glyph, so the conversion is never letter-for-letter.
Three consequences, all of which the old splitter got wrong:

  ng is ONE letter.  It has its own glyph, and its own nga/nge/ngi/ngo/ngu.
      The old code recognised "nga" and nothing else, so "ang" came out as
      n + g - two glyphs for a sound Baybayin writes with one - and "ngipin"
      started with a bare n. Every ng PNG but nga sat unused on disk.

  A vowel beside a vowel is two syllables.  "oo" was read as consonant +
      vowel, asked for a glyph named "oo", found none and printed nothing.

  Letters with no Baybayin sound must be converted, not dropped.  Baybayin
      was never written for c, f, j, q, v, x or z. "Filipino" asked for a
      glyph named "fi", missed, and printed LI PI NO with the F silently
      gone. To Baybayin an F is a P sound, so it is written with P.

The vowel-less forms are the modern virama spellings - the mark that cancels
the "a" every basic character carries - which is what the b/k/d/... PNGs are.
"""
import re
import unicodedata

VOWELS = "aeiou"

# Consonants that survive the rewrite below and have glyphs of their own.
CONSONANTS = "bdghklmnprstwy"


def to_sounds(word):
    """Rewrite a word using only sounds Baybayin has a letter for.

    Each substitution is the nearest sound that does exist: c is a k or an s
    depending on what follows it, f is a p, v is a b, z is an s, j is an h
    (Jose is said Hose), x is k + s, and qu is a k. Marks over vowels carry
    stress, not a different sound, so they come off.
    """
    w = (word or "").lower()
    # Do these before the accents are stripped: NFKD would turn n-tilde into a
    # bare n and lose the y sound with it.
    w = w.replace("ñ", "ny").replace("ç", "s")
    w = unicodedata.normalize("NFKD", w)
    w = "".join(c for c in w if not unicodedata.combining(c))

    w = w.replace("ph", "p")     # Philippines -> Pilipinas, as it is said
    w = w.replace("th", "t")     # Anthony is said Antoni
    w = w.replace("ch", "ts")    # before c is dealt with, or ch becomes ks
    w = w.replace("ck", "k")
    w = re.sub(r"qu(?=[ei])", "k", w)   # Quezon -> Keson
    w = w.replace("qu", "kw")           # quarto -> kwarto
    w = w.replace("q", "k")
    w = re.sub(r"c(?=[eiy])", "s", w)   # ciudad -> siyudad
    w = w.replace("c", "k")
    w = w.replace("x", "ks")
    w = w.replace("ll", "ly")    # apellido -> apelyido
    w = w.replace("f", "p").replace("v", "b")
    w = w.replace("z", "s")

    # A j is a dy sound - Jeremy opens Dye, not He. There is no one character
    # for it: the d takes a virama and the y carries the vowel, so Dye is
    # written d + ye. Filipino spells the sound the same way, as in dyip.
    w = w.replace("j", "dy")

    # A doubled consonant is one sound: Betty is said be-ti, so it takes one
    # t. The g is left alone, because the double g of mangga is not a doubled
    # letter at all - it is the ng of mang followed by the g of ga, two
    # different sounds that happen to meet.
    w = re.sub(r"([bdhklmnprstwy])\1", r"\1", w)

    # A y with no vowel of its own, sitting after a consonant, is doing a
    # vowel's job: Jeremy ends in an i sound, not in the glide that bahay
    # ends in. Baybayin follows the sound, so it takes the i.
    w = re.sub(r"(?<=[" + CONSONANTS + r"])y(?![" + VOWELS + r"])", "i", w)

    # Whatever is left that Baybayin has no letter for at all - digits, stray
    # punctuation - is not something a glyph can say.
    return re.sub("[^" + VOWELS + CONSONANTS + "]", "", w)


def split_syllables(text):
    """The glyph names for everything in `text`, in reading order."""
    syllables = []

    for raw in (text or "").lower().split():
        word = to_sounds(raw)
        i = 0

        while i < len(word):

            # ng first: it is a single letter, and reading its n alone would
            # spell a different word.
            if word[i:i + 2] == "ng":

                if i + 2 < len(word) and word[i + 2] in VOWELS:
                    syllables.append(word[i:i + 3])
                    i += 3

                else:
                    syllables.append("ng")
                    i += 2

                continue

            # A vowel reached here is either starting the word or following
            # another vowel, since a consonant would have taken it already.
            # Either way it is a syllable by itself.
            if word[i] in VOWELS:
                syllables.append(word[i])
                i += 1
                continue

            if i + 1 < len(word) and word[i + 1] in VOWELS:
                syllables.append(word[i:i + 2])
                i += 2
                continue

            # A consonant with no vowel after it: written with the virama.
            syllables.append(word[i])
            i += 1

    return syllables
