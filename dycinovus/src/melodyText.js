// =============================================================================
// Melodies as text you can type.
// =============================================================================
// The harmoniser wants [{ midi, beats }]. People do not want to type that, and
// a piano-roll editor is a lot of machinery to stand between someone and the
// thing they came to try. So a melody is written the way a musician would say
// it out loud:
//
//   C4 C4 G4 G4 | A4 A4 G4:2
//
// One token per note, `:beats` when it is not one beat, `-` for a rest, and
// barlines that are ignored entirely — they are there so the line stays
// readable, not because anything reads them. Bars are worked out from the time
// signature, exactly as they are for a melody that arrived any other way; a
// barline typed in the wrong place changes nothing, which is deliberate. It
// means a mistyped tune still harmonises instead of failing.
//
// Parsing never throws. A bad token is skipped and reported, because the caller
// is a text box somebody is halfway through typing in, and a melody that
// vanishes on every keystroke is unusable.

const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const TOKEN = /^([A-Ga-g])([#b]?)(-?\d)(?::(\d+(?:\.\d+)?))?$/
const REST = /^[-r](?::(\d+(?:\.\d+)?))?$/i

/** "C4" -> 60, "Bb3" -> 58, "F#4" -> 66. Null if it is not a note. */
export function midiOf(token) {
  const m = TOKEN.exec(token)
  if (!m) return null
  const [, letter, accidental, octave] = m
  const pc = STEP[letter.toUpperCase()] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0)
  return (Number(octave) + 1) * 12 + pc
}

/** 60 -> "C4". Sharps only; nothing here needs to know how it was spelled. */
export const nameOf = (midi) =>
  `${NAMES[(((Math.round(midi) % 12) + 12) % 12)]}${Math.floor(Math.round(midi) / 12) - 1}`

/**
 * @returns {{ melody: Array, errors: Array<{token:string, at:number}> }}
 *          Whatever parsed, plus whatever did not, so a text box can underline
 *          the mistake without throwing the rest of the tune away.
 */
export function parseMelody(text) {
  const melody = []
  const errors = []
  const tokens = String(text ?? '').split(/[\s,]+/).filter(Boolean)

  tokens.forEach((token, at) => {
    if (token === '|') return // a barline is punctuation, not music

    const rest = REST.exec(token)
    if (rest) {
      melody.push({ midi: null, beats: rest[1] ? Number(rest[1]) : 1 })
      return
    }

    const m = TOKEN.exec(token)
    if (!m) {
      errors.push({ token, at })
      return
    }
    const beats = m[4] ? Number(m[4]) : 1
    if (!(beats > 0)) {
      errors.push({ token, at })
      return
    }
    melody.push({ midi: midiOf(token), beats })
  })

  return { melody, errors }
}

/** The inverse, so a preset can be loaded INTO the text box and then edited. */
export function formatMelody(melody, beatsPerBar = 4) {
  const out = []
  let at = 0
  for (const note of melody) {
    const beats = note.beats ?? 1
    // A barline every bar, on the beat where one actually falls — decoration
    // for the reader, and dropped again the moment it is parsed back.
    if (at > 0 && Math.abs(at % beatsPerBar) < 1e-9) out.push('|')
    const head = note.midi == null ? '-' : nameOf(note.midi)
    out.push(beats === 1 ? head : `${head}:${beats}`)
    at += beats
  }
  return out.join(' ')
}

// -----------------------------------------------------------------------------
// Something to start from
// -----------------------------------------------------------------------------
// Four tunes chosen to disagree with each other: one that sits almost entirely
// on chord tones, one that is mostly stepwise and so gives the search far less
// to go on, one in three time, and one in a minor key.
//
// Lupang Hinirang is deliberately NOT here. The recordings in source/harmony
// have contours, but they are pitch-tracked from a real take — the opening
// wobbles between 66 and 67 and drops an octave where the tracker lost the
// voice — so turning them into notation would mean inventing a transcription of
// a national anthem and presenting it as the anthem. Anyone who wants to try it
// can type it in; the console next door plays the written arrangement properly.

export const PRESETS = [
  {
    name: 'Twinkle, Twinkle',
    beatsPerBar: 4,
    text:
      'C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2 | ' +
      'G4 G4 F4 F4 | E4 E4 D4:2 | G4 G4 F4 F4 | E4 E4 D4:2 | ' +
      'C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2',
  },
  {
    name: 'Ode to Joy',
    beatsPerBar: 4,
    text:
      'E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | E4:1.5 D4:0.5 D4:2 | ' +
      'E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4:1.5 C4:0.5 C4:2',
  },
  {
    name: 'Frère Jacques',
    beatsPerBar: 4,
    text:
      'C4 D4 E4 C4 | C4 D4 E4 C4 | E4 F4 G4:2 | E4 F4 G4:2 | ' +
      'G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4 C4 | ' +
      'G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4 C4 | ' +
      'C4 G3 C4:2 | C4 G3 C4:2',
  },
  {
    name: 'House of the Rising Sun',
    beatsPerBar: 3,
    // Three time and a minor key, both of which the other three avoid. The
    // rising A-C-D-F shape means almost every bar has a genuine choice of
    // chord, so this is the one where changing the weights visibly changes the
    // answer rather than nudging it.
    text:
      'A3 C4 D4 | F4:3 | A3 C4 E4 | E4:3 | ' +
      'A3 C4 D4 | F4 E4 D4 | C4:2 A3 | A3:3',
  },
]
