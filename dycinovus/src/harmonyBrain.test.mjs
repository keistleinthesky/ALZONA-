// Unit tests for the live harmony's musical decisions.
//   node src/harmonyBrain.test.mjs      (run from the dycinovus folder)
//
// A harmony in the wrong key still sounds like a harmony — confident, in tune
// with itself, and wrong. That is what makes this worth testing note by note
// rather than by ear: the failure mode is plausible.

import {
  HarmonyBrain,
  KeyTracker,
  harmonyInterval,
  keyName,
} from './harmonyBrain.js'
import { hzFromMidi } from './pitch.js'

let failures = 0

function eq(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} got ${actual}  want ${expected}`)
}

function ok(name, condition, detail = '') {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`)
}

const C_MAJOR = { tonic: 0, mode: 'major' }
const A_MINOR = { tonic: 9, mode: 'minor' }

// ---------------------------------------------------------------------------
console.log('\n-- a third below is not a fixed number of semitones --')
// This is the whole reason the module exists. Shift every note down by three
// semitones and half the scale comes out sour; the diatonic third alternates
// between three and four, and only the scale knows which.
for (const [note, midi, expected] of [
  ['C4', 60, -3], // down to A3, minor third
  ['D4', 62, -3], // down to B3, minor third
  ['E4', 64, -4], // down to C4, MAJOR third
  ['F4', 65, -3], // down to D4, minor third again
  ['G4', 67, -3],
  ['A4', 69, -4],
  ['B4', 71, -4],
  ['C5', 72, -3],
]) {
  eq(`third below ${note} in C major`, harmonyInterval(midi, C_MAJOR, -2), expected)
}

console.log('\n-- and it follows the mode --')
eq('third below A4 in A minor', harmonyInterval(69, A_MINOR, -2), -4) // down to F4
eq('third below B4 in A minor', harmonyInterval(71, A_MINOR, -2), -4) // down to G4
eq('third below C5 in A minor', harmonyInterval(72, A_MINOR, -2), -3) // down to A4
eq('sixth below G4 in C major', harmonyInterval(67, C_MAJOR, -5), -8) // down to B3
eq('octave below G4', harmonyInterval(67, C_MAJOR, -7), -12)
eq('third ABOVE C4 in C major', harmonyInterval(60, C_MAJOR, 2), 4) // up to E4

// ---------------------------------------------------------------------------
console.log('\n-- a note that is off the scale, or off pitch --')
// A singer 30 cents flat on E should still get the E harmony, moved by the same
// 30 cents — so the two are in tune with each other even when neither is in
// tune with a piano.
eq('E4 sung 30 cents flat still gets E4 third', harmonyInterval(63.7, C_MAJOR, -2), -4)
eq('a passing C#4 snaps to the nearest degree', harmonyInterval(61, C_MAJOR, -2), -3)
eq('B3, just under the tonic', harmonyInterval(59, C_MAJOR, -2), -4) // down to G3

console.log('\n-- and one nobody could sing --')
// Folding the octave back in beats emitting a growl below the range of hearing.
ok(
  'an octave below a very low note folds up',
  40 + harmonyInterval(40, C_MAJOR, -7) >= 43,
  `-> midi ${40 + harmonyInterval(40, C_MAJOR, -7)}`,
)

// ---------------------------------------------------------------------------
console.log('\n-- working out the key from the singing alone --')
{
  const t = new KeyTracker()
  // A C major tune: the scale, landing on the tonic and the fifth.
  const tune = [60, 62, 64, 65, 67, 65, 64, 62, 60, 67, 64, 60, 60]
  tune.forEach((m, i) => t.observe(m, 1, i * 0.4))
  const key = t.best()
  eq('a C major tune reads as C major', keyName(key), 'C major')
}
{
  const t = new KeyTracker()
  // The same seven pitch classes, but centred on A and leaning on E and G#.
  const tune = [69, 71, 72, 74, 76, 74, 72, 71, 69, 76, 69, 68, 69, 69]
  tune.forEach((m, i) => t.observe(m, 1, i * 0.4))
  eq('an A minor tune reads as A minor', keyName(t.best()), 'A minor')
}
{
  const t = new KeyTracker()
  t.observe(67, 1, 0)
  t.observe(67, 1, 0.4)
  ok('one repeated note is not a key', t.best() === null, 'stays undecided')
}
{
  // The point of the half-life: sing in one key, then another, and the second
  // one wins rather than being outvoted by everything sung earlier.
  const t = new KeyTracker({ halfLife: 4 })
  ;[60, 62, 64, 65, 67, 64, 60].forEach((m, i) => t.observe(m, 1, i * 0.5))
  const first = keyName(t.best())
  ;[66, 68, 70, 71, 73, 70, 66, 66, 73, 66].forEach((m, i) => t.observe(m, 1, 20 + i * 0.5))
  ok(
    'a change of key is followed, not averaged',
    first === 'C major' && keyName(t.best()) === 'F# major',
    `${first} -> ${keyName(t.best())}`,
  )
}

// ---------------------------------------------------------------------------
console.log('\n-- the brain end to end --')
{
  const brain = new HarmonyBrain({ plan: 'third-below' })
  const tune = [60, 62, 64, 65, 67, 65, 64, 62, 60]
  let now = 0
  let last = null
  for (const midi of tune) {
    // 300ms on each note, sampled every 20ms, as the worklet reports it.
    for (let t = 0; t < 300; t += 20) {
      last = brain.update(hzFromMidi(midi), 0.95, now)
      now += 20
    }
  }
  eq('picks up the key while you sing', keyName(brain.key), 'C major')
  eq('and harmonises the last note', last.intervals[0], -3) // C4 -> A3
  ok('as a ratio the shifter can use', Math.abs(last.ratios[0] - Math.pow(2, -3 / 12)) < 1e-9)
}
{
  const brain = new HarmonyBrain({ plan: 'trio' })
  let now = 0
  let last = null
  for (const midi of [60, 62, 64, 65, 67, 69, 71, 72, 67]) {
    for (let t = 0; t < 300; t += 20) {
      last = brain.update(hzFromMidi(midi), 0.95, now)
      now += 20
    }
  }
  eq('a trio gives two lines', last.intervals.length, 2)
  eq('  a third below G4', last.intervals[0], -3) // E4
  eq('  and a fifth below', last.intervals[1], -7) // C4
}
{
  // Silence must not leave a harmony hanging on the last note forever, and must
  // not cut it off inside a word either.
  const brain = new HarmonyBrain({ plan: 'third-below' })
  let now = 0
  for (const midi of [60, 62, 64, 65, 67]) {
    for (let t = 0; t < 300; t += 20) { brain.update(hzFromMidi(midi), 0.95, now); now += 20 }
  }
  const short = brain.update(-1, 0, (now += 120))
  ok('a consonant does not drop the harmony', short.intervals.length === 1, 'held')
  const long = brain.update(-1, 0, (now += 900))
  ok('the end of a phrase does', long.intervals.length === 0, 'released')
}
{
  // Auto should not put the harmony under someone who has no room underneath.
  const low = new HarmonyBrain({ plan: 'auto' })
  let now = 0
  let last = null
  for (const midi of [48, 50, 52, 53, 55, 53, 52, 48]) {
    for (let t = 0; t < 300; t += 20) { last = low.update(hzFromMidi(midi), 0.95, now); now += 20 }
  }
  ok('auto harmonises above a low voice', last.intervals[0] > 0, `interval ${last.intervals[0]}`)

  const high = new HarmonyBrain({ plan: 'auto' })
  now = 0
  for (const midi of [72, 74, 76, 77, 79, 77, 76, 72]) {
    for (let t = 0; t < 300; t += 20) { last = high.update(hzFromMidi(midi), 0.95, now); now += 20 }
  }
  ok('and below a high one', last.intervals[0] < 0, `interval ${last.intervals[0]}`)
}

{
  // The case that made the feature look broken: one held note. Placing a key
  // properly needs three distinct ones, so waiting for it meant silence.
  const brain = new HarmonyBrain({ plan: 'third-below' })
  let now = 0
  let last = null
  for (let t = 0; t < 400; t += 20) {
    last = brain.update(hzFromMidi(67), 0.95, now)
    now += 20
  }
  ok('one held note harmonises straight away', last.intervals.length === 1,
    `interval ${last.intervals[0]}, key ${keyName(last.key)}`)
  ok('  and marks that key as only a guess', last.key?.provisional === true)

  // ...and the guess gives way to the real key once there is enough to tell.
  for (const midi of [72, 74, 76, 77, 79, 77, 76, 72, 72]) {
    for (let t = 0; t < 300; t += 20) { last = brain.update(hzFromMidi(midi), 0.95, now); now += 20 }
  }
  ok('a real key replaces the guess', !last.key.provisional, `settled on ${keyName(last.key)}`)
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n')
process.exit(failures ? 1 : 0)
