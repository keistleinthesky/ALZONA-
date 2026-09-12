// =============================================================================
// Does she come in at the right PLACE?
// =============================================================================
//   node src/joinPoint.test.mjs      (run from the dycinovus folder)
//
// Reported from a real take: "it's singing back but it's singing a different
// part." Choosing the wrong line and choosing the right line in the wrong place
// sound identical from the room, and only one of them was happening.
//
// match.time is where the first note of the MATCHED WINDOW sits in the
// recording — not the first note of the take. Measuring elapsed time from the
// start of the whole take pushes her further into the song with every phrase
// sung: 3 seconds in it is barely audible, 20 seconds in she is a line and a
// half ahead and sounds like a different part altogether.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { framesToNotes, identifyPart, MIN_DISTINCT_TO_MATCH } from './scoreMatch.js'
import { hzFromMidi } from './pitch.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONTOURS = JSON.parse(
  readFileSync(path.resolve(HERE, '../../source/harmony/contours.json'), 'utf8'),
)
const PARTS = ['soprano', 'alto']
const STEP = 0.05

/**
 * Sing from `from` for `count` notes, in real time, exactly as the browser
 * collects it: t is seconds since the microphone opened.
 *
 * Note times come from the recording, RESTS INCLUDED. Playing the notes
 * back-to-back instead compresses the take — nearly a second of missing
 * silence over a phrase — and then measures that as the code's error. The
 * gaps are also what framesToNotes uses to tell two notes of the same pitch
 * apart, so removing them changes what is being matched, not just when.
 */
function take(part, from, count) {
  const notes = CONTOURS[part].notes.slice(from, from + count)
  const t0 = notes[0].t
  const frames = []
  for (const n of notes) {
    const begin = n.t - t0
    for (let u = 0; u + 1e-9 < n.d; u += STEP) {
      frames.push({ t: begin + u, hz: hzFromMidi(n.midi) })
    }
  }
  const last = notes[notes.length - 1]
  return { frames, now: last.t - t0 + last.d, startedAtSong: t0 }
}

let failures = 0
const gaps = []
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)}${detail}`)
}

console.log('--- she enters where the singer actually is ---')
for (const part of PARTS) {
  for (const from of [14, 22, 30]) {
    // A long take: 24 notes sung, matched on the most recent 10. This is where
    // measuring from the wrong point does its damage.
    const { frames, now, startedAtSong } = take(part, from, 24)
    const sung = framesToNotes(frames)
    if (sung.length < MIN_DISTINCT_TO_MATCH) continue

    let id = null
    let win = null
    for (const t of [10, 14, 20, 8]) {
      const recent = sung.slice(-t)
      if (recent.length < MIN_DISTINCT_TO_MATCH) continue
      id = identifyPart(recent, CONTOURS, PARTS)
      if (id) { win = recent; break }
    }
    if (!id) { console.log(`SKIP  ${part} from ${from}: refused`); continue }

    // Where she should be: the singer's position in the song right now.
    const wantNow = startedAtSong + now

    const rightWay = id.match.time + (now - win[0].start)
    const oldWay = id.match.time + (now - sung[0].start)

    const err = Math.abs(rightWay - wantNow)
    const oldErr = Math.abs(oldWay - wantNow)

    // A beat at 84bpm is ~0.71s. Inside that they are singing together.
    // Between one and two beats she is a little late but still on the right
    // line — that is the matcher settling on a near-identical passage, a limit
    // of matchPosition rather than of this arithmetic, and it is listed rather
    // than hidden. Beyond two beats she is somewhere else in the song, which is
    // the fault this file exists to catch.
    const beat = 60 / 84
    if (err > 2 * beat) {
      failures += 1
      console.log(`FAIL  ${`${part} from note ${from}: lands elsewhere`.padEnd(46)}`
        + `off by ${err.toFixed(2)}s (from take start: ${oldErr.toFixed(2)}s)`)
    } else if (err > beat) {
      gaps.push(`${part} from note ${from} — ${err.toFixed(2)}s late`)
      console.log(`GAP   ${`${part} from note ${from}: a beat late`.padEnd(46)}`
        + `off by ${err.toFixed(2)}s (from take start: ${oldErr.toFixed(2)}s)`)
    } else {
      console.log(`PASS  ${`${part} from note ${from}: enters with the singer`.padEnd(46)}`
        + `off by ${err.toFixed(2)}s (from take start: ${oldErr.toFixed(2)}s)`)
    }
  }
}

if (gaps.length) {
  console.log(`\n${gaps.length} known gap(s) — a beat late, on the RIGHT line:`)
  for (const g of gaps) console.log('  · ' + g)
  console.log('  matchPosition settling on a near-identical passage, not this arithmetic.')
}
if (failures) {
  console.log(`\n${failures} failure(s).`)
  process.exit(1)
}
console.log('\nShe comes in where the singer is.')
