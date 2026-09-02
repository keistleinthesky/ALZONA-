// Unit tests for the singing pitch detector.
//   node src/pitch.test.mjs      (run from the dycinovus folder)
//
// A pitch detector that is wrong by an octave still "works" — it just harmonises
// against the wrong note — so these tests check the exact frequency, not just
// that something was found.

import { detectPitch, noteLabel, midiFromHz, hzFromMidi, SATB_OFFSETS } from './pitch.js'

const SR = 48000
const SIZE = 2048
let failures = 0

function check(name, actual, expected, tolerance) {
  const ok = Math.abs(actual - expected) <= tolerance
  if (!ok) failures += 1
  const delta = (actual - expected).toFixed(2)
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(42)} got ${String(actual).padStart(9)}  ` +
      `want ${expected} (±${tolerance})  Δ${delta}`,
  )
}

// A sung vowel is not a sine — it is a fundamental plus a stack of harmonics.
// Feeding a pure sine would be an unfairly easy test, so synthesise a vowel-like
// tone with the harmonics that trip up naive FFT peak-picking.
function vowel(hz, { harmonics = [1, 0.5, 0.33, 0.22, 0.14], noise = 0 } = {}) {
  const buf = new Float32Array(SIZE)
  for (let i = 0; i < SIZE; i += 1) {
    const t = i / SR
    let v = 0
    harmonics.forEach((amp, k) => {
      v += amp * Math.sin(2 * Math.PI * hz * (k + 1) * t)
    })
    if (noise) v += (Math.random() * 2 - 1) * noise
    buf[i] = v * 0.32
  }
  return buf
}

console.log('\n--- fundamental frequency, vowel-like tone ---')
for (const [name, hz] of [
  ['G3  (196.00 Hz)  bass range', 196.0],
  ['C4  (261.63 Hz)  middle C', 261.63],
  ['G4  (392.00 Hz)  anthem start', 392.0],
  ['A4  (440.00 Hz)  concert pitch', 440.0],
  ['C5  (523.25 Hz)  soprano range', 523.25],
]) {
  const { hz: got } = detectPitch(vowel(hz), SR)
  // 1 Hz at G4 is under 5 cents — inaudible against a live singer.
  check(name, Number(got.toFixed(2)), hz, 1.0)
}

console.log('\n--- robustness ---')
{
  const { hz } = detectPitch(vowel(392.0, { noise: 0.12 }), SR)
  check('G4 with noise', Number(hz.toFixed(2)), 392.0, 3.0)
}
{
  // Strong 2nd harmonic is the classic octave-error trap.
  const { hz } = detectPitch(vowel(392.0, { harmonics: [0.6, 1.0, 0.5, 0.3] }), SR)
  check('G4, 2nd harmonic louder (octave trap)', Number(hz.toFixed(2)), 392.0, 4.0)
}
{
  const silence = new Float32Array(SIZE)
  const { hz } = detectPitch(silence, SR)
  check('silence rejected', hz, -1, 0)
}
{
  const noise = new Float32Array(SIZE)
  for (let i = 0; i < SIZE; i += 1) noise[i] = (Math.random() * 2 - 1) * 0.3
  const { hz } = detectPitch(noise, SR)
  const rejected = hz === -1
  if (!rejected) failures += 1
  console.log(`${rejected ? 'PASS' : 'FAIL'}  ${'white noise rejected'.padEnd(42)} got ${hz}`)
}

console.log('\n--- note naming ---')
for (const [hz, want] of [
  [392.0, 'G4'],
  [261.63, 'C4'],
  [440.0, 'A4'],
  [523.25, 'C5'],
  [196.0, 'G3'],
]) {
  const n = noteLabel(hz)
  const got = `${n.name}${n.octave}`
  const ok = got === want && Math.abs(n.cents) <= 1
  if (!ok) failures += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${`${hz} Hz -> ${want}`.padEnd(42)} got ${got} ${n.cents >= 0 ? '+' : ''}${n.cents}c`,
  )
}

console.log('\n--- SATB harmony against a G4 melody ---')
{
  const melody = 392.0 // G4, the anthem's opening note
  const expect = { soprano: 'G4', alto: 'D4', tenor: 'G3', bass: 'G2' }
  for (const [part, semis] of Object.entries(SATB_OFFSETS)) {
    const target = melody * Math.pow(2, semis / 12)
    const n = noteLabel(target)
    const got = `${n.name}${n.octave}`
    const ok = got === expect[part]
    if (!ok) failures += 1
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${`${part} (${semis} semis)`.padEnd(42)} got ${got}  want ${expect[part]}`,
    )
  }
}

console.log('\n--- key transposition (any starting pitch) ---')
for (const [name, hz, wantOffset] of [
  ['sings on G4 (as written)', 392.0, 0],
  ['sings on A4 (2 up)', 440.0, 2],
  ['sings on E4 (3 down)', 329.63, -3],
  ['sings on C4 (7 down)', 261.63, -7],
]) {
  const offset = Math.round(midiFromHz(hz) - midiFromHz(392.0))
  check(name, offset, wantOffset, 0)
  // Round-trip: transposing back by the offset must land on the sung pitch.
  const back = hzFromMidi(midiFromHz(392.0) + offset)
  check(`  -> round-trips to sung pitch`, Number(back.toFixed(1)), Number(hz.toFixed(1)), 1.5)
}

console.log(
  failures === 0
    ? '\nAll pitch tests passed.\n'
    : `\n${failures} test(s) FAILED.\n`,
)
process.exit(failures === 0 ? 0 : 1)
