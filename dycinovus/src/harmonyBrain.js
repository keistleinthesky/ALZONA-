// =============================================================================
// The musical brain behind the live harmony.
// =============================================================================
// The shifter (harmonyVoice.js) can move a voice by any interval it is told.
// This decides WHICH interval, note by note, so the second voice belongs to the
// same song instead of trailing a fixed number of semitones behind.
//
// Two jobs:
//   1. Work out the key from the singing itself. No score, no key selector —
//      you walk up and start singing anything, and after a phrase or two she
//      knows where "home" is.
//   2. Turn "a third below" into the right interval for the note you are ON:
//      three semitones on some degrees of the scale, four on others. Getting
//      that wrong is exactly what makes a cheap harmoniser sound sour on every
//      other note, and it is the whole difference between a harmony and a
//      detune effect.
//
// No React and no Web Audio here on purpose — this is the part whose mistakes
// are inaudible-but-wrong (a plausible harmony in the wrong key), so it is kept
// where it can be tested note by note. See harmonyBrain.test.mjs.

import { midiFromHz } from './pitch.js'

export const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

// Krumhansl-Kessler key profiles: how strongly each pitch class belongs to a
// major and a minor key. Correlating what has actually been sung against all 24
// rotations is the standard way to name a key from audio alone, and it settles
// on an answer within a phrase rather than needing the whole song.
export const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
export const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

export const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
export const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10] // natural minor

// Voicings, written as SCALE STEPS rather than semitones — that is the whole
// point of this module. -2 means "a third below", whatever that works out to on
// the degree you happen to be singing.
export const PLANS = {
  auto: { steps: null, label: 'Auto' },
  'third-below': { steps: [-2], label: 'Third below' },
  'third-above': { steps: [2], label: 'Third above' },
  'sixth-below': { steps: [-5], label: 'Sixth below' },
  'octave-below': { steps: [-7], label: 'Octave below' },
  trio: { steps: [-2, -4], label: 'Trio' },
  choir: { steps: [-2, -4, -7], label: 'Choir' },
}

// Where a harmony line is allowed to live. Outside this it is either a growl
// nobody can hear or a whistle, and in both cases folding the octave back in
// sounds better than the interval as written.
const LOW_MIDI = 43 // G2
const HIGH_MIDI = 84 // C6

// Below this the singer has no room underneath them, so "below" becomes above.
const LOW_REGISTER = 55 // G3

/** Pearson correlation of the sung weights against a key profile rotated to `tonic`. */
function correlate(weights, profile, tonic) {
  let mw = 0
  let mp = 0
  for (let i = 0; i < 12; i += 1) {
    mw += weights[i]
    mp += profile[i]
  }
  mw /= 12
  mp /= 12
  let num = 0
  let dw = 0
  let dp = 0
  for (let i = 0; i < 12; i += 1) {
    const a = weights[(i + tonic) % 12] - mw
    const b = profile[i] - mp
    num += a * b
    dw += a * a
    dp += b * b
  }
  return dw > 0 && dp > 0 ? num / Math.sqrt(dw * dp) : 0
}

/**
 * Follows the key while someone sings, forgetting the past on a half-life.
 *
 * The decay matters: without it a song that changes key — or simply a second
 * song after the first — would be harmonised against everything ever sung into
 * the microphone, and the key would only get stiffer the longer the app stayed
 * open.
 */
export class KeyTracker {
  constructor({ halfLife = 12 } = {}) {
    this.halfLife = halfLife
    this.weights = new Float64Array(12)
    this.at = null
    this.total = 0
  }

  /** @param seconds when this was sung, on any monotonic clock. */
  observe(midi, weight = 1, seconds = 0) {
    if (this.at !== null && seconds > this.at) {
      const decay = Math.pow(0.5, (seconds - this.at) / this.halfLife)
      for (let i = 0; i < 12; i += 1) this.weights[i] *= decay
      this.total *= decay
    }
    this.at = seconds
    const pc = ((Math.round(midi) % 12) + 12) % 12
    this.weights[pc] += weight
    this.total += weight
  }

  /** How many pitch classes carry real weight — three is enough to place a key. */
  get spread() {
    const floor = this.total * 0.04
    let n = 0
    for (let i = 0; i < 12; i += 1) if (this.weights[i] > floor) n += 1
    return n
  }

  /** @returns {{tonic:number, mode:string, confidence:number}|null} */
  best() {
    if (this.total < 0.8 || this.spread < 3) return null
    let score = -2
    let key = null
    for (let tonic = 0; tonic < 12; tonic += 1) {
      const maj = correlate(this.weights, MAJOR_PROFILE, tonic)
      if (maj > score) { score = maj; key = { tonic, mode: 'major' } }
      const min = correlate(this.weights, MINOR_PROFILE, tonic)
      if (min > score) { score = min; key = { tonic, mode: 'minor' } }
    }
    return key ? { ...key, confidence: Math.max(0, score) } : null
  }
}

export const scaleOf = (key) => (key.mode === 'minor' ? MINOR_SCALE : MAJOR_SCALE)

export const keyName = (key) =>
  key ? `${PITCH_CLASSES[((key.tonic % 12) + 12) % 12]} ${key.mode}` : '—'

/** Nearest scale tone to a sung note, as a degree count from the tonic. */
export function nearestDegree(sungMidi, key) {
  const scale = scaleOf(key)
  const rel = sungMidi - key.tonic
  const octave = Math.floor(rel / 12)
  const within = rel - octave * 12
  let idx = 0
  let best = Infinity
  for (let i = 0; i < scale.length; i += 1) {
    const d = Math.abs(scale[i] - within)
    if (d < best) { best = d; idx = i }
  }
  // The tonic an octave up is nearer than the seventh for anything above ~11.5,
  // and it is not in the loop above because the scale table stops at the 7th.
  if (Math.abs(12 - within) < best) {
    return { degree: (octave + 1) * 7, snapped: key.tonic + (octave + 1) * 12 }
  }
  return { degree: octave * 7 + idx, snapped: key.tonic + octave * 12 + scale[idx] }
}

/**
 * Semitones from a sung note to its harmony note, `steps` scale degrees away.
 *
 * Returned as an INTERVAL rather than an absolute pitch, so the harmony inherits
 * the singer's own intonation: if they are fifteen cents flat, so is the second
 * voice, and the two are still in tune WITH EACH OTHER — which is what a
 * listener actually hears. Snapping the harmony to concert pitch instead makes
 * every slightly-flat note beat against its own harmony.
 */
export function harmonyNote(sungMidi, key, steps) {
  const scale = scaleOf(key)
  const { degree } = nearestDegree(sungMidi, key)
  const target = degree + steps
  const oct = Math.floor(target / 7)
  return key.tonic + oct * 12 + scale[target - oct * 7]
}

export function harmonyInterval(sungMidi, key, steps) {
  const { snapped } = nearestDegree(sungMidi, key)
  let interval = harmonyNote(sungMidi, key, steps) - snapped
  // Fold back into a register a voice can actually sing.
  while (sungMidi + interval < LOW_MIDI) interval += 12
  while (sungMidi + interval > HIGH_MIDI) interval -= 12
  return interval
}

// -----------------------------------------------------------------------------
// SATB parts, by name
// -----------------------------------------------------------------------------
// Everything above answers "how far away should the second voice be". This
// answers a different question the singer actually asks: "sing the ALTO line".
//
// The anchors are the notes each part starts Lupang Hinirang on, read from
// source/harmony/manifest.json, because that is the arrangement this robot
// knows and those are the notes the singer thinks in — you start on G4 and you
// are the soprano. The ranges around them are ordinary choral ones.
export const PART_NAMES = ['soprano', 'alto', 'tenor', 'bass']
export const PART_ANCHOR = { soprano: 67, alto: 62, tenor: 59, bass: 55 }
export const PART_RANGE = {
  soprano: { lo: 60, hi: 81 },
  alto: { lo: 55, hi: 74 },
  tenor: { lo: 48, hi: 69 },
  bass: { lo: 40, hi: 62 },
}

// Who answers whom. Soprano and alto pair off, tenor and bass likewise:
// reaching across that divide puts the two lines so far apart they stop
// sounding like one thing.
const PARTNER = { soprano: 'alto', alto: 'soprano', tenor: 'bass', bass: 'tenor' }

/** The part that should sing against this one. */
export const partnerOf = (part) => PARTNER[part] ?? 'alto'

/**
 * Which part is this person singing, judged from one note.
 *
 * Nearest anchor wins, which puts the soprano/alto line between E4 and F4.
 * That is deliberately where the anthem's own two lines separate rather than
 * where a textbook would put it.
 */
export function partOf(midi) {
  let best = 'soprano'
  let d = Infinity
  for (const name of PART_NAMES) {
    const gap = Math.abs(midi - PART_ANCHOR[name])
    if (gap < d) { d = gap; best = name }
  }
  return best
}

// Thirds and sixths first, then fifths and fourths; no seconds and no sevenths,
// which is what keeps every candidate below something you would willingly sing.
const CONSONANT = [-5, -4, -2, 2, 4, 5]
// The same interval an octave or two either way, so a line can be placed in a
// part's register rather than merely near the melody.
const OCTAVES = [-14, -7, 0, 7]

/**
 * Scale steps that put the harmony in a NAMED part's register.
 *
 * Scored on how near the result sits to the part's home note, with leaving the
 * part's range at all treated as much worse than sitting away from its middle,
 * and a nudge towards thirds and sixths when two candidates land equally well.
 *
 * Returned as steps rather than an interval so the rest of the brain is
 * unchanged: the phrase lock, the stability timer and the intonation-following
 * all still apply.
 */
export function stepsForPart(sungMidi, key, part) {
  const range = PART_RANGE[part] ?? PART_RANGE.alto
  const anchor = PART_ANCHOR[part] ?? PART_ANCHOR.alto
  let best = null
  for (const base of CONSONANT) {
    for (const oct of OCTAVES) {
      const steps = base + oct
      const note = harmonyNote(sungMidi, key, steps)
      // Unison, or close enough to read as one voice out of tune rather than
      // two voices. Never useful, whatever the register says.
      if (Math.abs(note - sungMidi) < 2) continue
      const outside = note < range.lo ? range.lo - note
        : note > range.hi ? note - range.hi : 0
      const flavour = Math.abs(base) === 2 || Math.abs(base) === 5 ? 0 : 0.8
      const score = Math.abs(note - anchor) + outside * 4 + flavour
      if (!best || score < best.score) best = { score, steps }
    }
  }
  return [best ? best.steps : -2]
}

// A new note has to hold this long before the harmony follows it. Shorter and
// the harmony flickers between two intervals on every wobble of a held note;
// longer and it lags audibly behind a quick run.
const STABLE_MS = 70
// A gap shorter than this is a breath or a consonant, not the end of a phrase,
// so the harmony and the voicing survive it.
const PHRASE_GAP_MS = 400

/**
 * Live harmony decisions: key, voicing, and the ratios to hand the shifter.
 *
 * Feed it whatever the pitch detector reports, as often as you like. Being
 * stable is its job, not the caller's.
 */
export class HarmonyBrain {
  constructor({ plan = 'auto', part = null, keyHalfLife = 12 } = {}) {
    this.plan = plan
    // When set, this wins over `plan`: the singer asked for a NAMED line
    // rather than an interval, and where that line sits decides the rest.
    this.part = part
    this.tracker = new KeyTracker({ halfLife: keyHalfLife })
    this.key = null
    this.intervals = []
    this.candidate = null
    this.candidateSince = 0
    this.lastVoicedAt = -Infinity
    this.phraseSteps = null // locked at the start of each phrase, for 'auto'
    this.sungMidi = null
  }

  /**
   * Sing one or more named SATB lines. Pass null for interval voicings.
   * @param {string|string[]|null} part
   */
  setPart(part) {
    const a = part == null ? [] : [].concat(part)
    const b = this.part == null ? [] : [].concat(this.part)
    if (a.length === b.length && a.every((x, i) => x === b[i])) return
    this.part = part
    this.phraseSteps = null
    this.intervals = []
    this.candidate = null
  }

  setPlan(plan) {
    if (plan === this.plan) return
    this.plan = plan
    this.phraseSteps = null
    this.intervals = []
    this.candidate = null
  }

  /** The scale steps to use for a phrase that starts on this note. */
  stepsFor(midi) {
    if (this.part) {
      // Several named lines at once is just each of them worked out
      // separately -- they are independent voices, not a chord shape.
      return [].concat(this.part).flatMap((p) => stepsForPart(midi, this.key, p))
    }
    const named = PLANS[this.plan]
    if (named?.steps) return named.steps
    // Auto: harmonise underneath, unless there is no room underneath — in which
    // case go above rather than growl along the bottom of the range.
    return midi <= LOW_REGISTER ? PLANS['third-above'].steps : PLANS['third-below'].steps
  }

  /**
   * @param hz      detected pitch, or <= 0 for "nothing sung"
   * @param clarity 0..1 from the detector
   * @param nowMs   monotonic milliseconds
   * @returns {{ratios:number[], intervals:number[], key:object|null, midi:number|null, voiced:boolean}}
   */
  update(hz, clarity, nowMs) {
    const voiced = hz > 0 && clarity >= 0.6
    if (!voiced) {
      // Hold the last harmony briefly. Dropping it the instant a consonant
      // interrupts the vowel makes the second voice stutter through every word.
      if (nowMs - this.lastVoicedAt > PHRASE_GAP_MS) {
        this.phraseSteps = null
        this.intervals = []
        this.candidate = null
      }
      this.sungMidi = null
      return this.result(false)
    }

    const midi = midiFromHz(hz)
    this.sungMidi = midi
    const newPhrase = nowMs - this.lastVoicedAt > PHRASE_GAP_MS
    this.lastVoicedAt = nowMs

    // Weight by clarity, so a half-heard note nudges the key rather than moving
    // it, and by a nominal frame length, so the totals mean roughly "seconds
    // sung" whatever rate the caller runs at.
    this.tracker.observe(midi, clarity * 0.05, nowMs / 1000)
    const found = this.tracker.best()
    if (found) {
      this.key = found
    } else if (!this.key || (this.key.provisional && newPhrase)) {
      // Placing a key properly takes three distinct notes, which is a second or
      // so of singing. Waiting for it meant a held note produced silence for
      // ever, and silence is indistinguishable from a broken feature — so until
      // the tracker is sure, the note being sung is TAKEN as the tonic of a
      // major scale. That is what a harmoniser pedal does when you set its key
      // by ear; it is right often enough to be musical, and it is replaced by
      // the real key the moment there is enough to work one out.
      this.key = {
        tonic: ((Math.round(midi) % 12) + 12) % 12,
        mode: 'major',
        confidence: 0,
        provisional: true,
      }
    }

    if (newPhrase || !this.phraseSteps) this.phraseSteps = this.stepsFor(midi)

    const next = this.phraseSteps.map((s) => harmonyInterval(midi, this.key, s))
    const same =
      next.length === this.candidate?.length && next.every((v, i) => v === this.candidate[i])
    if (!same) {
      this.candidate = next
      this.candidateSince = nowMs
    }
    // Only move once the new interval has held — see STABLE_MS.
    if (!this.intervals.length || nowMs - this.candidateSince >= STABLE_MS) {
      this.intervals = this.candidate
    }
    return this.result(true)
  }

  result(voiced) {
    return {
      voiced,
      key: this.key,
      midi: this.sungMidi,
      intervals: this.intervals,
      ratios: this.intervals.map((i) => Math.pow(2, i / 12)),
    }
  }
}
