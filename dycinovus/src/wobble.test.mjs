// =============================================================================
// Regression: a held note must not be segmented into alternating ones.
// =============================================================================
// From live telemetry, a singer holding one pitch produced notes=[66,67,66,67,…]
// — a single G sitting near the semitone boundary, rounded independently every
// frame. The matcher was then handed steps of +1 and -1 that the singer never
// sang, and could not find them in the anthem. A correctly heard voice still
// failed to harmonise.

import { framesToNotes, collapseRepeats } from './scoreMatch.js'
import { hzFromMidi } from './pitch.js'

const frames = (specs, dt = 0.05) => {
  const out = []
  let t = 0
  for (const midi of specs) {
    out.push({ t, hz: midi > 0 ? hzFromMidi(midi) : -1 })
    t += dt
  }
  return out
}

let failures = 0
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} got [${got}]  want [${want}]`)
}

// A steady G4 sung slightly flat, drifting either side of the 66/67 boundary.
const wobble = Array.from({ length: 24 }, (_, i) => 66.5 + 0.18 * Math.sin(i / 1.5))
check('held note near a semitone boundary',
      framesToNotes(frames(wobble)).map((n) => n.midi), [67])

// Ordinary human drift within one note: a quarter tone.
const drift = Array.from({ length: 20 }, (_, i) => 64 + 0.25 * Math.sin(i / 2))
check('quarter-tone drift stays one note',
      framesToNotes(frames(drift)).map((n) => n.midi), [64])

// A real step must still register.
const step = [...Array(10).fill(67), ...Array(10).fill(69)]
check('a genuine whole tone still splits',
      framesToNotes(frames(step)).map((n) => n.midi), [67, 69])

// A single bad frame must not split a held note.
const glitch = [...Array(8).fill(64), 52, ...Array(8).fill(64)]
check('one stray frame does not split a note',
      framesToNotes(frames(glitch)).map((n) => n.midi), [64])

// The same pitch either side of a real pause is two notes, not one.
const paused = [
  ...Array(6).fill(0).map((_, i) => ({ t: i * 0.05, hz: hzFromMidi(64) })),
  ...Array(6).fill(0).map((_, i) => ({ t: 2 + i * 0.05, hz: hzFromMidi(64) })),
]
check('a pause splits a repeated pitch',
      framesToNotes(paused).map((n) => n.midi), [64, 64])

// A phrase sung with drift must keep its melodic shape. The repeated opening
// note collapses by design — repeats carry no interval information, and
// whether a singer re-articulates one is a matter of phrasing, not melody.
const opening = [67, 67, 69, 71, 72, 71, 69, 67]
const sungWithDrift = opening.flatMap((m, k) =>
  Array.from({ length: 6 }, (_, i) => m + 0.3 * Math.sin((k * 6 + i) / 2)))
check('a phrase keeps its shape through drift',
      collapseRepeats(framesToNotes(frames(sungWithDrift))).map((n) => n.midi),
      [67, 69, 71, 72, 71, 69, 67])

if (failures) {
  console.log(`\n${failures} segmentation failure(s).`)
  process.exit(1)
}
console.log('\nAll wobble tests passed.')
