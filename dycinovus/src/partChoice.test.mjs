// =============================================================================
// Which line is she hearing? The cases that decide it.
// =============================================================================
//   node src/partChoice.test.mjs      (run from the dycinovus folder)
//
// Reported from a real take: "it's singing back but it's singing a different
// part." Two ways that happens, and both are tested here.
//
//   1. OCTAVE. Singing the alto line an octave up reads as a +12 offset
//      against alto. Ranked on the raw number that looks like "miles from
//      alto", and the soprano line wins on a technicality. An octave is not a
//      key: a woman singing the alto line in her own range is still on alto.
//
//   2. A COIN TOSS. Through passages where the two parts move in parallel the
//      intervals are identical and cannot tell them apart. Committing there is
//      a guess that sounds right for a bar and then diverges. Refusing is the
//      correct answer — she comes in a phrase later, on the right line.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { framesToNotes, identifyPart, counterpart, MIN_DISTINCT_TO_MATCH } from './scoreMatch.js'
import { hzFromMidi } from './pitch.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONTOURS = JSON.parse(
  readFileSync(path.resolve(HERE, '../../source/harmony/contours.json'), 'utf8'),
)
const PARTS = ['soprano', 'alto']

function sing(part, from, count, { semitones = 0, step = 0.05 } = {}) {
  const notes = CONTOURS[part].notes.slice(from, from + count)
  const frames = []
  let t = 0
  for (const n of notes) {
    for (let u = 0; u < Math.max(step, n.d); u += step) {
      frames.push({ t, hz: hzFromMidi(n.midi + semitones) })
      t += step
    }
  }
  return frames
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(50)}${detail}`)
}

console.log('--- an octave up or down is the SAME part ---')
for (const part of PARTS) {
  for (const oct of [-12, +12]) {
    for (const from of [14, 22]) {
      const notes = framesToNotes(sing(part, from, 12, { semitones: oct }))
      if (notes.length < MIN_DISTINCT_TO_MATCH) continue
      const id = identifyPart(notes, CONTOURS, PARTS)
      if (!id) { console.log(`SKIP  ${part} ${oct > 0 ? '+' : ''}${oct} from ${from}: refused`); continue }
      check(`${part} sung ${oct > 0 ? '+' : ''}${oct} from note ${from}`,
            id.part === part,
            `heard ${id.part}, answers ${counterpart(id.part, PARTS)}`)
    }
  }
}

console.log('\n--- an honest refusal beats a wrong entrance ---')
{
  // Two notes is nothing to go on. She must not produce an answer from it.
  const thin = framesToNotes(sing('alto', 14, 2))
  check('two notes is not enough to decide', identifyPart(thin, CONTOURS, PARTS) === null)

  // A scale carries no positional information at all.
  const scale = []
  let t = 0
  for (const m of [60, 62, 64, 65, 67, 69, 71, 72]) {
    for (let u = 0; u < 0.3; u += 0.05) { scale.push({ t, hz: hzFromMidi(m) }); t += 0.05 }
  }
  check('a plain scale is refused, not matched',
        identifyPart(framesToNotes(scale), CONTOURS, PARTS) === null)
}

console.log('\n--- when she does commit, she says how clearly ---')
{
  let decided = 0, sure = 0
  for (const part of PARTS) {
    for (const from of [14, 22, 30]) {
      const id = identifyPart(framesToNotes(sing(part, from, 12)), CONTOURS, PARTS)
      if (!id) continue
      decided += 1
      if (id.part === part) sure += 1
      const runner = id.runnerUp ? `${id.runnerUp.part} ${id.runnerUp.score.toFixed(2)}` : 'none'
      console.log(`      ${part} from ${from}: chose ${id.part} `
        + `(score ${id.score.toFixed(2)}, margin ${id.margin === Infinity ? 'sole' : id.margin.toFixed(2)}, `
        + `key error ${id.keyError}, runner-up ${runner})`)
    }
  }
  check('every decision it committed to was correct', decided > 0 && sure === decided,
        `${sure}/${decided}`)
}

if (failures) {
  console.log(`\n${failures} failure(s).`)
  process.exit(1)
}
console.log('\nAll part-choice tests passed.')
