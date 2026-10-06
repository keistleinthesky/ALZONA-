// =============================================================================
// End to end: sing a phrase, and check what comes back is a HARMONY.
// =============================================================================
//   node src/singWithMe.test.mjs      (run from the dycinovus folder)
//
// The other tests check the pieces separately: harmonyVoice.test.mjs proves the
// shifter moves a voice by the ratio it is given, harmonyBrain.test.mjs proves
// the brain names a key and picks intervals. Neither would notice if the two
// were wired together wrongly — the shifter would still produce confident,
// voice-like audio, in the wrong key, and everything would pass.
//
// So this runs the whole chain the way Harmonize.jsx runs it in the browser:
// shifter and brain in a closed loop, the brain steering on the pitch the
// SHIFTER reports, 128 samples at a time. Then it asks the one question that
// matters — for each note of the phrase, what note came out?
//
// The interesting assertion is not that the harmony is a third below. It is
// that a third below is sometimes THREE semitones and sometimes FOUR, chosen by
// where the note sits in the key. Getting that wrong is what makes a cheap
// harmoniser sour on every other note, and a fixed-interval shifter would fail
// here while passing every other test in this directory.

import { HarmonyVoice } from './harmonyVoice.js'
import { HarmonyBrain } from './harmonyBrain.js'
import { detectPitch, midiFromHz } from './pitch.js'

const SR = 48000
const BLOCK = 128
// The worklet reports to the brain every 50ms; match that exactly, because the
// brain's stability timers are written against that rate.
const REPORT_SAMPLES = Math.round(SR * 0.05)

let failures = 0

/** A sung vowel: a glottal pulse train shaped by formants. */
function vowel(seconds, f0, sr = SR) {
  const n = Math.round(seconds * sr)
  const buf = new Float32Array(n)
  const formants = [700, 1220, 2600]
  const amps = []
  for (let k = 1; k * f0 < sr / 2 && k <= 40; k += 1) {
    let a = 1 / k
    for (const f of formants) {
      const d = (k * f0 - f) / 220
      a += 0.9 / (1 + d * d)
    }
    amps.push(a)
  }
  let peak = 0
  for (let i = 0; i < n; i += 1) {
    const t = i / sr
    let v = 0
    // Phase-aligned, so there is a real glottal pulse for the tracker to find.
    amps.forEach((a, k) => { v += a * Math.cos(2 * Math.PI * f0 * (k + 1) * t) })
    buf[i] = v
    peak = Math.max(peak, Math.abs(v))
  }
  for (let i = 0; i < n; i += 1) buf[i] = (buf[i] / peak) * 0.35
  // A short onset, because a voice has one.
  //
  // Not a convenience. Without it the very first note of a cold start came out
  // rough enough that the detector read it an octave down at clarity 0.6 --
  // while the note after a silence, and every later note, measured perfect at
  // 0.99. The trigger was the signal going from digital silence to full
  // amplitude in a single sample, which no larynx can do; the shifter has no
  // pulse to place its first grains against and needs a cycle or two to find
  // its footing. Given a 40ms onset the same first note measures within a cent.
  //
  // So this models the singer, it does not paper over the shifter. Take it out
  // and note 1 fails on its own.
  const onset = Math.round(0.04 * sr)
  for (let i = 0; i < onset && i < n; i += 1) buf[i] *= i / onset
  return buf
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const nameOf = (m) => `${NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`
const hzOf = (m) => 440 * Math.pow(2, (m - 69) / 12)

// A phrase that walks up the scale of C major and back. Every note is
// diatonic, so the correct third below is fully determined -- and it alternates
// between three and four semitones, which is the whole point.
const NOTE_SECONDS = 0.7
const PHRASE = [60, 62, 64, 65, 67, 69, 67] // C4 D4 E4 F4 G4 A4 G4

// Third below IN C MAJOR, worked out by hand from the scale rather than by
// calling the code under test:
//   C4->A3 (-3)  D4->B3 (-3)  E4->C4 (-4)  F4->D4 (-3)
//   G4->E4 (-3)  A4->F4 (-4)  G4->E4 (-3)
const EXPECTED = [57, 59, 60, 62, 64, 65, 64]

// ---------------------------------------------------------------------------
// Sing it, through the same loop the browser runs.
// ---------------------------------------------------------------------------
const melody = new Float32Array(PHRASE.length * Math.round(NOTE_SECONDS * SR))
PHRASE.forEach((midi, i) => {
  melody.set(vowel(NOTE_SECONDS, hzOf(midi)), i * Math.round(NOTE_SECONDS * SR))
})

const voice = new HarmonyVoice(SR)
const brain = new HarmonyBrain({ plan: 'third-below' })
const out = new Float32Array(melody.length)
const block = new Float32Array(BLOCK)
let sinceReport = 0
let keyAtEnd = null

for (let i = 0; i + BLOCK <= melody.length; i += BLOCK) {
  voice.process(melody.subarray(i, i + BLOCK), block)
  out.set(block, i)
  sinceReport += BLOCK
  if (sinceReport >= REPORT_SAMPLES) {
    sinceReport = 0
    // Exactly what LiveHarmony.heard does: the brain steers on the pitch the
    // shifter itself is tracking, so the interval can never be computed from a
    // different note than the one being shifted.
    const nowMs = (i / SR) * 1000
    const r = brain.update(voice.voiced ? voice.hz : -1, voice.clarity, nowMs)
    voice.setRatios(r.ratios)
    keyAtEnd = r.key
  }
}

// ---------------------------------------------------------------------------
// What came out?
// ---------------------------------------------------------------------------
console.log('\n-- the note she sang against each note of the phrase --')

const noteLen = Math.round(NOTE_SECONDS * SR)
// The shifter runs `latency` samples behind, and the brain deliberately waits
// for a new note to hold before following it. Measure the settled middle of
// each note, not its edges.
const skip = voice.latency + Math.round(0.28 * SR)
const WINDOW = 2048

PHRASE.forEach((sungMidi, i) => {
  const at = i * noteLen + skip
  if (at + WINDOW > out.length) return
  const { hz, clarity } = detectPitch(out.subarray(at, at + WINDOW), SR, 1e-5)
  const wantMidi = EXPECTED[i]
  const gotMidi = hz > 0 ? midiFromHz(hz) : NaN
  const cents = Math.abs(gotMidi - wantMidi) * 100
  // Within a quarter tone: closer than that and we would be testing the
  // detector's precision rather than whether the right note was chosen.
  const ok = hz > 0 && cents < 50
  if (!ok) failures += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  you sing ${nameOf(sungMidi).padEnd(3)}`
    + ` -> she sings ${(hz > 0 ? nameOf(gotMidi) : '—').padEnd(3)}`
    + `  want ${nameOf(wantMidi).padEnd(3)}`
    + `  (${(wantMidi - sungMidi)} semis)`
    + `  off ${hz > 0 ? cents.toFixed(0).padStart(3) : ' ??'} cents`
    + `  clarity ${clarity.toFixed(2)}`,
  )
})

// ---------------------------------------------------------------------------
console.log('\n-- and she worked the key out from the singing alone --')
{
  const got = keyAtEnd ? `${NAMES[keyAtEnd.tonic]} ${keyAtEnd.mode}` : 'none'
  const ok = keyAtEnd && keyAtEnd.tonic === 0 && keyAtEnd.mode === 'major'
    && !keyAtEnd.provisional
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  settled on ${got}`
    + `${keyAtEnd?.provisional ? ' (still provisional)' : ''}  want C major`)
}

// A fixed-interval shifter would sail through the notes above if we had only
// used notes whose third is three semitones. State plainly that the phrase
// actually exercises both, so this test cannot rot into a weaker one.
{
  const widths = new Set(PHRASE.map((m, i) => EXPECTED[i] - m))
  const ok = widths.has(-3) && widths.has(-4)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  the phrase needs both a minor and a major third`
    + `  (widths ${[...widths].sort().join(', ')})`)
}

if (failures) {
  console.log(`\n${failures} failure(s).`)
  process.exit(1)
}
console.log('\nShe harmonises. All good.')
