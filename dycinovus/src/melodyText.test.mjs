// Unit tests for the typed-melody notation.
//   node src/melodyText.test.mjs      (run from the dycinovus folder)
//
// This is the only thing standing between somebody's typing and the
// harmoniser, and it runs on every keystroke. Two things matter: that it never
// throws, and that a half-typed line still yields the notes that ARE finished —
// a parser that returns nothing until the input is valid makes the text box
// feel broken rather than unfinished.

import { PRESETS, formatMelody, midiOf, nameOf, parseMelody } from './melodyText.js'
import { toBars } from './chordGA.js'

let failures = 0

function eq(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} got ${actual}  want ${expected}`)
}

function same(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  const ok = a === b
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} got ${a}  want ${b}`)
}

function ok(name, condition, detail = '') {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} ${detail}`)
}

console.log('\n-- note names --')
eq('middle C', midiOf('C4'), 60)
eq('A above it is concert A', midiOf('A4'), 69)
eq('sharps', midiOf('F#4'), 66)
eq('flats', midiOf('Bb3'), 58)
eq('and they agree', midiOf('A#3'), midiOf('Bb3'))
eq('lower case is fine', midiOf('c4'), 60)
eq('octave -1 exists', midiOf('C-1'), 0)
eq('nonsense is not a note', midiOf('H4'), null)
eq('nor is a bare letter', midiOf('C'), null)
eq('names round-trip', nameOf(60), 'C4')
eq('...including sharps', nameOf(66), 'F#4')

console.log('\n-- parsing --')
same('three plain notes', parseMelody('C4 D4 E4').melody, [
  { midi: 60, beats: 1 },
  { midi: 62, beats: 1 },
  { midi: 64, beats: 1 },
])
same('durations', parseMelody('C4:2 D4:0.5').melody, [
  { midi: 60, beats: 2 },
  { midi: 62, beats: 0.5 },
])
same('rests', parseMelody('- r:2').melody, [
  { midi: null, beats: 1 },
  { midi: null, beats: 2 },
])
eq('barlines are punctuation', parseMelody('C4 | D4').melody.length, 2)
eq('so are newlines and commas', parseMelody('C4,\n D4').melody.length, 2)
eq('empty input is an empty melody', parseMelody('').melody.length, 0)
eq('so is nothing at all', parseMelody(undefined).melody.length, 0)

console.log('\n-- half-typed input still works --')
// The real test of this module. Somebody typing "C4 D4 E" has not made a
// mistake, they are mid-word, and the two finished notes should still play.
const partial = parseMelody('C4 D4 E')
eq('the finished notes survive', partial.melody.length, 2)
eq('and the unfinished one is reported', partial.errors.length, 1)
eq('...by name', partial.errors[0].token, 'E')
eq('...and position', partial.errors[0].at, 2)

const bad = parseMelody('C4 zzz D4 E4:0')
eq('junk is skipped, not fatal', bad.melody.length, 2)
eq('a zero-beat note is junk too', bad.errors.length, 2)
same('and the good notes are untouched', bad.melody.map((n) => n.midi), [60, 62])

console.log('\n-- round trip --')
const text = 'C4 C4 G4 G4 | A4 A4 G4:2'
const { melody } = parseMelody(text)
eq('formatting reproduces the line', formatMelody(melody, 4), text)
same(
  'and reparsing gives the same notes',
  parseMelody(formatMelody(melody, 4)).melody,
  melody,
)
// Barlines are cosmetic on the way out and ignored on the way in, so putting
// them in the wrong place must not change a single note.
same(
  'a misplaced barline changes nothing',
  parseMelody('C4 | C4 G4 G4 A4 A4 G4:2').melody,
  melody,
)

console.log('\n-- the presets are real, playable tunes --')
for (const preset of PRESETS) {
  const { melody: notes, errors } = parseMelody(preset.text)
  const beats = notes.reduce((s, n) => s + n.beats, 0)
  const bars = toBars(notes, preset.beatsPerBar)
  ok(
    `${preset.name.padEnd(26)} parses`,
    errors.length === 0,
    `${notes.length} notes, ${beats} beats, ${bars.length} bars`,
  )
  // A tune that stops halfway through a bar is legal but is almost always a
  // typo in the preset rather than a deliberate ragged ending.
  ok(
    `${preset.name.padEnd(26)} fills whole bars`,
    Math.abs(beats % preset.beatsPerBar) < 1e-9,
    `${beats} beats / ${preset.beatsPerBar} per bar`,
  )
  ok(
    `${preset.name.padEnd(26)} stays singable`,
    notes.every((n) => n.midi === null || (n.midi >= 48 && n.midi <= 84)),
  )
}

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILURES`}\n`)
process.exit(failures === 0 ? 0 : 1)
