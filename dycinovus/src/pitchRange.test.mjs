// =============================================================================
// Regression: a confident detection must not be thrown away as out of range.
// =============================================================================
// Live telemetry showed frames reading clarity 0.99 with hz reported as -1. The
// detector had locked hard onto a HARMONIC, at a period far too short for a
// voice, and the range check then binned the whole frame. To the singer that is
// a microphone that hears nothing while the meter shows plenty of signal.
//
// These cases are shaped like a real microphone rather than a clean tone:
// breath noise, a formant stack that outweighs the fundamental, and vibrato.

import { detectPitch, midiFromHz } from './pitch.js'

const SR = 44100
const N = 2048
const MIN_HZ = 65
const MAX_HZ = 1200

/** A sung vowel: harmonic stack, optional vibrato, optional breath noise. */
function sung(f0, amps, { vibrato = 0, noise = 0 } = {}) {
  const b = new Float32Array(N)
  let phase = 0
  for (let i = 0; i < N; i += 1) {
    const t = i / SR
    const f = f0 * (1 + vibrato * Math.sin(2 * Math.PI * 5.5 * t))
    phase += (2 * Math.PI * f) / SR
    let v = 0
    amps.forEach((a, k) => { v += a * Math.sin(phase * (k + 1)) })
    if (noise) v += (Math.random() * 2 - 1) * noise
    b[i] = v * 0.2
  }
  return b
}

const cases = [
  // The shape that broke it: upper harmonics dominate the fundamental.
  ['G4 392, 4th harmonic strongest', 392, [0.15, 0.5, 0.7, 1.0]],
  ['F#4 370, formant on the 3rd', 369.99, [0.2, 0.6, 1.0, 0.5]],
  ['D4 294, fundamental very weak', 293.66, [0.08, 1.0, 0.9, 0.6]],
  ['A3 220, breathy with vibrato', 220, [0.3, 0.9, 0.6, 0.4],
    { vibrato: 0.02, noise: 0.08 }],
  ['C4 262, noisy microphone', 261.63, [0.35, 0.8, 0.7, 0.5], { noise: 0.12 }],
  ['G3 196, low and harmonic-heavy', 196, [0.12, 0.9, 1.0, 0.7]],
  ['E5 659, high soprano', 659.26, [0.5, 1.0, 0.4, 0.2]],
]

let failures = 0
for (const [label, f0, amps, opts] of cases) {
  const { hz, clarity } = detectPitch(sung(f0, amps, opts), SR, 1e-5)
  const inRange = hz >= MIN_HZ && hz <= MAX_HZ
  // Half a semitone is as much as the harmony can absorb before it sounds wrong.
  const semis = hz > 0 ? Math.abs(midiFromHz(hz) - midiFromHz(f0)) : 99
  const ok = inRange && semis < 0.5
  if (!ok) failures += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(36)} got ${hz.toFixed(1).padStart(7)}Hz`
    + `  want ${f0.toFixed(1).padStart(6)}Hz  off ${semis.toFixed(2)} semis`
    + `  clarity ${clarity.toFixed(2)}`,
  )
}

// A confident frame must never come back as "no pitch" — that combination is
// the exact failure this file exists to catch.
const strong = detectPitch(sung(392, [0.15, 0.5, 0.7, 1.0]), SR, 1e-5)
if (strong.clarity > 0.8 && strong.hz <= 0) {
  console.log(`FAIL  clarity ${strong.clarity.toFixed(2)} but hz=${strong.hz}`)
  failures += 1
} else {
  console.log(`PASS  confident frame reports a pitch (clarity `
    + `${strong.clarity.toFixed(2)}, ${strong.hz.toFixed(1)}Hz)`)
}

if (failures) {
  console.log(`\n${failures} range failure(s).`)
  process.exit(1)
}
console.log('\nAll pitch-range tests passed.')
