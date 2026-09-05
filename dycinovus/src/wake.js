// =============================================================================
// ALZONA's name, and the phrase that hands the microphone back.
// =============================================================================
// Two panels need to agree on what her name sounds like, and they hear it
// through completely different ears:
//
//   Voice.jsx  browser SpeechRecognition, for questions and commands
//   Sing.jsx   4-second clips sent to /listen, while the harmony has the mic
//
// Only ONE of them may hold the microphone at a time. That was the bug this
// module exists to close: both were running at once, each restarting the other
// out of the device, and the /listen docstring in main.py records the measured
// result — recognition hearing nothing while the singing side received no audio
// either. So the microphone is now handed over explicitly, and a handover needs
// a phrase both sides recognise. Keeping the name in one place is what stops
// them drifting apart, which would strand the singing panel with no way back.

// Name variants cover common speech-recognition mishearings of "Alzona",
// including how Japanese/Korean/Chinese recognition writes the name.
export const NAME = "(?:al\\s?zona|alsona|elzona|al\\s?sona|arizona|alona)"
export const NAME_CJK =
  "(?:アルゾナ|アルソナ|アルゾーナ|アルソーナ|알조나|알소나|알존아|阿尔佐纳|阿尔索纳|阿爾佐納|阿爾索納|奥佐娜)"

// Words that may sit around her name in the hand-back phrase without changing
// what it means. Deliberately short: every word added here is a word that stops
// being a question she can be asked while singing.
const FILLER = /\b(?:okay|ok|oh|ah|hey|hi|hello|yo|uy|oy|so|um|uh|please|po|na)\b/gi
const CLOSER =
  /\b(?:stop|stopped|stops|back|enough|done|finish|finished|salamat|thanks|thank\s*you|tama|tapos|end)\b/gi
// Multi-word ways of saying the same thing. Stripped before the single words
// so "that is enough" does not leave "that is" behind and look like content.
const CLOSER_PHRASE =
  /\b(?:that(?:'|’)?s|that\s+is|thats|iyon)\s+(?:all|it|enough|lang|na)\b/gi

/**
 * Is this clip the singer asking for the microphone back?
 *
 * True only when the WHOLE utterance is her name plus filler — "Alzona",
 * "okay Alzona", "Alzona stop", "salamat Alzona". Anything with content left
 * over is a real question and must be answered normally, because while the
 * harmony holds the microphone this is also the only path a question can take.
 *
 * The name has to be present. "Stop" on its own is not enough to end the
 * harmony: it is an ordinary English word and could easily be sung.
 */
export function isHandBackPhrase(text) {
  const t = (text || '').trim()
  if (!t) return false
  const named = new RegExp(NAME, 'i').test(t) || new RegExp(NAME_CJK).test(t)
  if (!named) return false
  const rest = t
    .replace(new RegExp(NAME, 'gi'), ' ')
    .replace(new RegExp(NAME_CJK, 'g'), ' ')
    .replace(CLOSER_PHRASE, ' ')
    .replace(FILLER, ' ')
    .replace(CLOSER, ' ')
    // Punctuation and whitespace, Latin and CJK.
    .replace(/[\s,.!?…"'’、。，！？・ー-]+/g, '')
  return rest.length === 0
}
