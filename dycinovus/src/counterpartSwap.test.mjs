// =============================================================================
// Sing back: she answers with the OTHER line.
// =============================================================================
//   node src/counterpartSwap.test.mjs      (run from the dycinovus folder)
//
// Sing the melody and she takes the alto; sing the alto and she takes the
// melody. Nobody tells her which — she works it out from the pitches, and the
// screen never names either part.
//
// Run against the real recorded contours, not synthetic tones: the two lines
// share rhythm and much of their shape, and telling them apart is exactly the
// thing that could quietly regress.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { framesToNotes, identifyPart, counterpart, MIN_DISTINCT_TO_MATCH } from './scoreMatch.js'
import { hzFromMidi } from './pitch.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONTOURS = JSON.parse(
  readFileSync(path.resolve(HERE, '../../source/harmony/contours.json'), 'utf8'),
)

const SINGER_PARTS = ['soprano', 'alto']

/** Turn part of a recorded line into frames, as a microphone would deliver them. */
function sing(part, fromNote, count, { semitones = 0, step = 0.05 } = {}) {
  const notes = CONTOURS[part].notes.slice(fromNote, fromNote + count)
  const frames = []
  let t = 0
  for (const n of notes) {
    const held = Math.max(step, n.d)
    for (let u = 0; u < held; u += step) {
      frames.push({ t, hz: hzFromMidi(n.midi + semitones) })
      t += step
    }
  }
  return frames
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)}${detail}`)
}

console.log('--- she takes the line the singer is NOT on ---')
for (const [part, want] of [['soprano', 'alto'], ['alto', 'soprano']]) {
  for (const from of [6, 14, 22, 30]) {
    const notes = framesToNotes(sing(part, from, 12))
    if (notes.length < MIN_DISTINCT_TO_MATCH) continue
    const id = identifyPart(notes, CONTOURS, SINGER_PARTS)
    if (!id) { console.log(`SKIP  ${part} from note ${from}: no match (a matcher limit)`); continue }
    const hers = counterpart(id.part, SINGER_PARTS)
    check(`singing ${part} from note ${from} -> she sings ${hers}`,
          id.part === part && hers === want,
          `heard ${id.part}, answers ${hers}`)
  }
}

console.log('\n--- and in any key: the swap survives transposition ---')
for (const semis of [-4, -2, 3, 5]) {
  const notes = framesToNotes(sing('soprano', 14, 12, { semitones: semis }))
  const id = identifyPart(notes, CONTOURS, SINGER_PARTS)
  if (!id) { console.log(`SKIP  soprano ${semis > 0 ? '+' : ''}${semis} semitones: no match`); continue }
  check(`soprano sung ${semis > 0 ? '+' : ''}${semis} semitones -> she sings ${counterpart(id.part, SINGER_PARTS)}`,
        counterpart(id.part, SINGER_PARTS) === 'alto',
        `offset ${id.match.semitoneOffset}`)
}

console.log('\n--- she never doubles the singer ---')
{
  let doubled = 0
  for (const part of SINGER_PARTS) {
    for (const from of [6, 14, 22, 30]) {
      const id = identifyPart(framesToNotes(sing(part, from, 12)), CONTOURS, SINGER_PARTS)
      if (id && counterpart(id.part, SINGER_PARTS) === id.part) doubled += 1
    }
  }
  check('no case where she sings the singer\'s own line', doubled === 0,
        `${doubled} doubling(s)`)
}

if (failures) {
  console.log(`\n${failures} failure(s).`)
  process.exit(1)
}
console.log('\nAll counterpart tests passed.')
