// Tests for finding the singer's position and part.
//   node src/scoreMatch.test.mjs      (run from the dycinovus folder)
//
// Runs against the REAL contours extracted from the recordings, so a pass means
// it works on the actual anthem rather than on invented data.

import fs from 'node:fs'
import {
  matchPosition,
  identifyPart,
  counterpart,
  MIN_DISTINCT_TO_MATCH,
} from './scoreMatch.js'

const contours = JSON.parse(
  fs.readFileSync(
    'C:/Users/Win11/OneDrive/Documents/Desktop/shs_pro/source/harmony/contours.json',
    'utf8',
  ),
)
const soprano = contours.soprano.notes
const alto = contours.alto.notes
const PAIR = ['soprano', 'alto']
let failures = 0

function check(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${detail}`)
}

const phraseAt = (notes, i, len, transpose = 0) =>
  notes.slice(i, i + len).map((n) => ({ midi: n.midi + transpose }))

// The singer keeps singing until the position is unambiguous, so feed notes one
// at a time and take the first confident match — exactly how it works live.
function asTheySing(notes, start, maxNotes = 24, transpose = 0, mutate = null) {
  for (let len = 4; len <= maxNotes; len += 1) {
    const sung = phraseAt(notes, start, len, transpose)
    if (mutate) mutate(sung)
    const m = matchPosition(sung, notes === soprano ? soprano : alto)
    if (m) return { ...m, notesNeeded: len }
  }
  return null
}

console.log(`\nsoprano ${soprano.length} notes, alto ${alto.length} notes\n`)

console.log('--- starting anywhere in the song ---')
for (const start of [0, 12, 40, 80, 120, 170]) {
  const m = asTheySing(soprano, start)
  // Compare TIME, not index: matching collapses repeats, so indices refer to
  // the collapsed sequence while time refers to the recording.
  const ok = m && Math.abs(m.time - soprano[start].t) <= 0.6
  check(`from note ${start} (${soprano[start].name}, ${soprano[start].t}s)`, ok,
    m ? `-> ${m.time}s after ${m.notesNeeded} notes` : '-> never matched')
}

console.log('\n--- any key (transposition-proof) ---')
for (const semis of [-5, -2, 3, 7]) {
  const m = asTheySing(soprano, 40, 24, semis)
  check(`transposed ${semis > 0 ? '+' : ''}${semis}`,
    m && Math.abs(m.time - soprano[40].t) <= 0.6 && m.semitoneOffset === semis,
    m ? `-> ${m.time}s, offset ${m.semitoneOffset}` : '-> no match')
}

console.log('\n--- articulation must not matter ---')
{
  // ~29% of notes are repeats. Singing legato produces ONE note where the
  // reference has three, so matching compares shape rather than performance.
  const legato = (notes, start, len) => {
    const out = []
    for (const n of notes.slice(start, start + len)) {
      if (out.length && out[out.length - 1].midi === n.midi) continue
      out.push({ midi: n.midi })
    }
    return out
  }
  for (const start of [60, 100, 140]) {
    let m = null
    for (let len = 6; len <= 30 && !m; len += 1) {
      m = matchPosition(legato(soprano, start, len), soprano)
    }
    check(`legato from note ${start}`, !!m, m ? `-> ${m.time}s` : '-> no match')
  }
}

console.log('\n--- junk before the phrase must not block matching ---')
{
  // Logged from a real take: 23 distinct notes collected, still "matched=no".
  // Matching the WHOLE history means one throat-clear early on corrupts the
  // sequence and nothing ever matches again. A recent window recovers.
  const junk = [48, 61, 45, 70, 52, 66].map((midi) => ({ midi }))
  const polluted = [...junk, ...phraseAt(soprano, 80, 12)]
  check('whole history with junk in front -> no match (the bug)',
    matchPosition(polluted, soprano) === null)

  let windowed = null
  for (const take of [10, 14, 20, 8]) {
    const recent = polluted.slice(-take)
    if (recent.length < MIN_DISTINCT_TO_MATCH) continue
    windowed = matchPosition(recent, soprano)
    if (windowed) break
  }
  // The window covers the LATEST notes, so it lands later than the phrase began
  // — which is what we want: come in where the singer is now.
  const from = soprano[80].t
  const to = soprano[92].t
  check('recent window finds it anyway',
    windowed && windowed.time >= from - 0.3 && windowed.time <= to + 0.3,
    windowed ? `-> ${windowed.time}s (inside ${from}-${to}s)` : '-> still no match')
}

console.log('\n--- a lyric hint speeds up the repeated passages ---')
{
  const target = soprano[8].t
  const hint = { from: target - 2.5, to: target + 6 }
  const need = (opts) => {
    for (let len = 4; len <= 40; len += 1) {
      if (matchPosition(phraseAt(soprano, 8, len), soprano, opts)) return len
    }
    return null
  }
  const without = need({})
  const withHint = need({ window: hint })
  check('lyric hint needs fewer notes', withHint && without && withHint < without,
    `-> ${withHint} with the words vs ${without} without`)
}

console.log('\n--- refuses to guess ---')
check('too few notes -> null', matchPosition(phraseAt(soprano, 40, 3), soprano) === null)
check('unrelated melody -> null',
  matchPosition([60, 61, 62, 63, 64, 65, 66].map((midi) => ({ midi })), soprano) === null)
check('empty -> null', matchPosition([], soprano) === null)

console.log('\n--- which line is the singer on ---')
function identifyAsTheySing(notes, start, maxNotes = 24) {
  for (let len = 4; len <= maxNotes; len += 1) {
    const got = identifyPart(phraseAt(notes, start, len), contours, PAIR)
    if (got) return { ...got, notesNeeded: len }
  }
  return null
}
for (const start of [8, 30, 60, 100, 140]) {
  const got = identifyAsTheySing(soprano, start)
  check(`soprano line from note ${start}`, got?.part === 'soprano',
    got ? `-> ${got.part} after ${got.notesNeeded}` : '-> not identified')
}
for (const start of [8, 30, 60, 100, 140]) {
  const got = identifyAsTheySing(alto, start)
  check(`alto line from note ${start}`, got?.part === 'alto',
    got ? `-> ${got.part} after ${got.notesNeeded}` : '-> not identified')
}

console.log('\n--- ALZONA takes the other line ---')
check('singer on soprano -> alto', counterpart('soprano', PAIR) === 'alto')
check('singer on alto -> soprano', counterpart('alto', PAIR) === 'soprano')

console.log(
  failures === 0 ? '\nAll score-matching tests passed.\n' : `\n${failures} test(s) FAILED.\n`,
)
process.exit(failures === 0 ? 0 : 1)
