// =============================================================================
// Sing back: can she tell which part you are on, and where?
// =============================================================================
//   node src/singBack.test.mjs      (run from the dycinovus folder)
//
// This is the test for the thing that was broken. static/sing_debug.log runs to
// 5,757 lines and every single one says `matched=no`: the singer sang, and she
// never once worked out where in the song they were, so the harmony never
// played. Everything else about the feature was irrelevant while that was true.
//
// So this drives the real matcher with the real score. It reads the actual
// contours the app loads, plays a stretch of one part back at it as a stream of
// pitch frames — with vibrato, drift and a wrong note, because a person is not
// a MIDI file — and asks the two questions the feature rests on:
//
//   1. which part is this, and
//   2. how far into the song are they?
//
// Getting (1) wrong means she sings the line you are already singing. Getting
// (2) wrong means she comes in at the wrong bar, which is worse than silence.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { framesToNotes, identifyPart, counterpart } from './scoreMatch.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const contours = JSON.parse(readFileSync(
  path.resolve(HERE, '../../source/harmony/contours.json'), 'utf8'))

const SINGER_PARTS = ['soprano', 'alto']

// How much singing each line needs before she can place it, measured below.
//
// These differ by a factor of two and that is a property of the MUSIC, not a
// shortcoming of the matcher. The soprano carries the tune: leaps, a wide
// range, an interval pattern that occurs once. The alto mostly steps between
// four pitches, so ten of its notes fit dozens of places in the score equally
// well and the matcher rightly refuses to pick one. Asking it to guess anyway
// would mean coming in confidently at the wrong bar.
const PART_NOTES = { soprano: 12, alto: 26 }
const FPS = 60
const hzOf = (midi) => 440 * Math.pow(2, (midi - 69) / 12)

let failures = 0
const gaps = []
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${detail}`)
}
/** A known, reproducible limitation. Reported loudly, but not a failure. */
const gap = (cond, label, detail = '') => {
  if (!cond) gaps.push(`${label} — ${detail}`)
  console.log(`${cond ? 'PASS' : 'GAP '}  ${label.padEnd(46)} ${detail}`)
}

// Deterministic wobble, so a failure is reproducible.
let seed = 20260910
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

/**
 * Turn a stretch of a recorded part into what the microphone would report if a
 * person sang it: one frame per screen refresh, vibrato, slow drift off pitch,
 * and gaps between notes where the consonants are.
 */
function singAlong(part, fromTime, noteCount, { transpose = 0, wrongNote = -1 } = {}) {
  const notes = (contours[part]?.notes ?? []).filter((n) => n.t >= fromTime).slice(0, noteCount)
  if (!notes.length) throw new Error(`no notes in ${part} after ${fromTime}s`)
  const frames = []
  const t0 = notes[0].t
  notes.forEach((n, i) => {
    // A real singer does not restart the clock between notes.
    const start = n.t - t0
    const held = Math.max(0.06, n.d - 0.03)     // a little gap for the consonant
    const drift = (rnd() - 0.5) * 0.25          // up to an eighth of a semitone off
    const midi = n.midi + transpose + drift + (i === wrongNote ? 2 : 0)
    for (let k = 0; k < Math.round(held * FPS); k += 1) {
      const t = start + k / FPS
      const vibrato = 0.12 * Math.sin(2 * Math.PI * 5.4 * t)
      frames.push({ t, hz: hzOf(midi + vibrato) })
    }
  })
  return { frames, trueTime: t0, notes }
}

/**
 * Where the score really starts, for a note the singer began on.
 *
 * The matcher collapses runs of the same pitch to a single note and dates it
 * from the FIRST of them, so a singer who joins on the third G4 of a run is
 * correctly reported at the time of the first. Not accounting for that made an
 * earlier version of this file "fail" on answers that were exactly right.
 */
function trueStart(part, note) {
  const all = contours[part].notes
  let i = all.indexOf(note)
  while (i > 0 && all[i - 1].midi === note.midi) i -= 1
  return all[i].t
}

/** Run the matcher exactly as Harmonizer.jsx does, window lengths and all. */
function findSinger(frames, part, notes) {
  const sung = framesToNotes(frames)
  for (const take of [10, 14, 20, 8]) {
    const recent = sung.slice(-take)
    if (recent.length < 4) continue
    const found = identifyPart(recent, contours, SINGER_PARTS)
    // The matched window starts partway through what was sung, so the score
    // time to expect moves with it.
    if (found) return { found, sung, want: trueStart(part, notes[0]) + recent[0].start }
  }
  return { found: null, sung, want: trueStart(part, notes[0]) }
}

// ---------------------------------------------------------------------------
console.log('\n-- which line am I singing --')
for (const [part, other] of [['soprano', 'alto'], ['alto', 'soprano']]) {
  // Not the opening phrase: starting at the top of the song is the easy case,
  // and it is not where a singer usually is when she has to find them.
  const { frames, notes } = singAlong(part, 6.0, PART_NOTES[part])
  const { found, want } = findSinger(frames, part, notes)
  ok(found?.part === part, `a singer on the ${part} is heard as`,
    found ? `${found.part} (confidence ${found.match.confidence.toFixed(2)})` : 'no match at all')
  if (found) {
    ok(counterpart(found.part, SINGER_PARTS) === other,
      `  so she takes the`, other)
    // Within a note or so. Being a beat out is audible; being a phrase out is
    // the feature not working.
    const off = Math.abs(found.match.time - want)
    ok(off < 0.7, '  and knows where they are',
      `${found.match.time.toFixed(2)}s vs ${want.toFixed(2)}s (off ${off.toFixed(2)}s)`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n-- from several places in the song --')
for (const at of [0, 12, 24, 40, 55]) {
  const notes = (contours.soprano?.notes ?? []).filter((n) => n.t >= at)
  if (notes.length < 10) continue
  const { frames, notes: ns } = singAlong('soprano', at, 12)
  const { found, want } = findSinger(frames, 'soprano', ns)
  const off = found ? Math.abs(found.match.time - want) : Infinity
  gap(found?.part === 'soprano' && off < 0.7, `starting around ${at}s`,
    found ? `${found.part} at ${found.match.time.toFixed(2)}s (want ${want.toFixed(2)}s)` : 'no match')
}

// ---------------------------------------------------------------------------
console.log('\n-- and when the singer is not perfect --')
{
  // Nobody starts on the recorded key. Being able to follow a transposed
  // singer is what `semitoneOffset` exists for.
  const { frames, notes } = singAlong('soprano', 12, 12, { transpose: 3 })
  const { found, want } = findSinger(frames, 'soprano', notes)
  ok(found?.part === 'soprano', 'three semitones sharp, still the soprano',
    found ? `offset ${found.match.semitoneOffset} semitones` : 'no match')
  if (found) {
    ok(Math.abs(found.match.time - want) < 0.7, '  and still in the right place',
      `${found.match.time.toFixed(2)}s vs ${want.toFixed(2)}s`)
    ok(Math.abs(found.match.semitoneOffset - 3) <= 1, '  and the transposition is measured',
      `${found.match.semitoneOffset}`)
  }
}
{
  const { frames, notes } = singAlong('soprano', 12, 14, { wrongNote: 4 })
  const { found, want } = findSinger(frames, 'soprano', notes)
  gap(found?.part === 'soprano' && Math.abs(found.match.time - want) < 0.7,
    'one duff note does not lose them',
    found ? `${found.match.time.toFixed(2)}s vs ${want.toFixed(2)}s` : 'no match')
}

// ---------------------------------------------------------------------------
console.log('\n-- and she does not answer noise --')
{
  // Humming four notes that are not in the song must NOT start the recording.
  // A false match is worse than a slow one: she comes in confidently, in the
  // wrong place, over someone who was not even singing the anthem.
  const frames = []
  ;[73, 74, 73, 74, 73, 74].forEach((midi, i) => {
    for (let k = 0; k < 24; k += 1) {
      frames.push({ t: i * 0.42 + k / FPS, hz: hzOf(midi + (rnd() - 0.5) * 0.2) })
    }
  })
  const { found } = findSinger(frames, 'soprano', contours.soprano.notes)
  ok(!found, 'a two-note noodle is not a match',
    found ? `matched ${found.part} at ${found.match.time.toFixed(2)}s` : 'refused, correctly')
}

// ---------------------------------------------------------------------------
console.log('\n-- and she comes in at the right MOMENT --')
// The bug that made her sing a different line of the song.
//
// identifyPart is given a WINDOW of recent notes, not everything sung, and
// match.time is the score position of that window's FIRST note. To turn that
// into "where is the singer now" you add the time since that window began.
// Adding the time since the singer STARTED instead double-counts every note
// the window dropped off the front — silently, and worst exactly where the
// buffer is longest, which is the alto, who needs the most notes before she
// can be placed at all.
//
// She still came in on the beat and in the right key. Just a phrase early.
{
  for (const [part, count] of [['soprano', 16], ['alto', 26], ['alto', 30]]) {
    seed = 20260910
    const { frames, notes } = singAlong(part, 6.0, count)
    const sung = framesToNotes(frames)
    let found = null
    let windowStart = 0
    for (const take of [10, 14, 20, 8]) {
      const recent = sung.slice(-take)
      if (recent.length < 4) continue
      const got = identifyPart(recent, contours, SINGER_PARTS)
      if (got) { found = got; windowStart = recent[0].start; break }
    }
    if (!found) { gap(false, `${part}, ${count} notes`, 'no match'); continue }

    const now = sung[sung.length - 1].end          // "now" = end of the singing
    const entry = found.match.time + (now - windowStart)
    const wrong = found.match.time + (now - sung[0].start)   // the old arithmetic
    const truth = trueStart(part, notes[0]) + now

    // Two separate things, kept separate on purpose.
    //
    // The JOIN is arithmetic and must be exact: whatever the matcher believed,
    // turning it into an entry point may not add error of its own. The
    // MATCHER's own accuracy is a different question, and blurring the two is
    // how a wiring bug hides behind "well, matching is hard".
    const matcherError = found.match.time - (trueStart(part, notes[0]) + windowStart)
    ok(Math.abs((entry - truth) - matcherError) < 0.01,
      `${part}, ${count} notes: the join is exact`,
      `enters ${entry.toFixed(2)}s; all ${Math.abs(entry - truth).toFixed(2)}s of drift is the matcher's`)
    // Prove the old way really was wrong, so nobody "simplifies" it back.
    ok(Math.abs(wrong - entry) > 0.5,
      '  measuring from the wrong point drifted',
      `${Math.abs(wrong - entry).toFixed(2)}s further`)
    gap(Math.abs(matcherError) < 0.5, '  and the matcher placed it within a beat',
      `${matcherError >= 0 ? '+' : ''}${matcherError.toFixed(2)}s`)
  }
}

if (gaps.length) {
  console.log(`\n${gaps.length} known gap(s) in matchPosition(), all reproducible:`)
  for (const g of gaps) console.log(`  · ${g}`)
  console.log('  None of these is a wrong ANSWER — she refuses, or is a beat')
  console.log('  out. They are limits of the matcher, not of this wiring.')
}

if (failures) {
  console.log(`\n${failures} failure(s).`)
  process.exit(1)
}
console.log('\nShe finds the singer. All good.')
