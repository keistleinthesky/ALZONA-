// =============================================================================
// SATB by name: which part am I on, and where does the answering line sit?
// =============================================================================
//   node src/parts.test.mjs      (run from the dycinovus folder)
//
// Two behaviours the singer asked for in plain words:
//
//   Sing back   start on G4 and you are the soprano, so she takes the alto.
//               Start on the alto line and she takes the soprano instead.
//   Harmonise   name a part and she sings that one.
//
// Both come down to the same question — given the note I am on and the key,
// what steps put a second voice in THAT part's register — so both are tested
// here against the anthem's own four starting notes.

import {
  PART_ANCHOR, PART_RANGE, partOf, partnerOf, stepsForPart, harmonyNote,
} from './harmonyBrain.js'

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const nameOf = (m) => `${NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`

let failures = 0
const ok = (cond, label, detail = '') => {
  if (!cond) failures += 1
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${detail}`)
}

// ---------------------------------------------------------------------------
console.log('\n-- which part is the singer on --')
// The four notes Lupang Hinirang actually starts on, from manifest.json.
{
  const cases = [
    ['G4 385Hz — the soprano start note', 67, 'soprano'],
    ['D4 — the alto start note', 62, 'alto'],
    ['B3 — the tenor start note', 59, 'tenor'],
    ['G3 — the bass start note', 55, 'bass'],
  ]
  for (const [label, midi, want] of cases) {
    const got = partOf(midi)
    ok(got === want, label, `-> ${got}`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n-- so she takes the other line --')
{
  // This is the whole of "sing back" as the singer described it.
  ok(partnerOf(partOf(67)) === 'alto', 'sing G4 (soprano) and she sings', '-> alto')
  ok(partnerOf(partOf(62)) === 'soprano', 'sing D4 (alto) and she sings', '-> soprano')
  ok(partnerOf('tenor') === 'bass', 'tenor is answered by', '-> bass')
  ok(partnerOf('bass') === 'tenor', 'bass is answered by', '-> tenor')
  // Never answer a part with itself: that is doubling, not harmony, and it is
  // the exact bug the console had to be fixed for once already.
  for (const p of ['soprano', 'alto', 'tenor', 'bass']) {
    ok(partnerOf(p) !== p, `${p} is never answered by itself`, `-> ${partnerOf(p)}`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n-- a named part lands in that part’s register --')
{
  const key = { tonic: 7, mode: 'major' }   // G major, the anthem's key
  // A soprano singing the melody, asking for each line underneath in turn.
  for (const part of ['alto', 'tenor', 'bass']) {
    let worst = null
    // Across a soprano's working range, not just one convenient note.
    for (let midi = 62; midi <= 76; midi += 1) {
      const [steps] = stepsForPart(midi, key, part)
      const note = harmonyNote(midi, key, steps)
      const { lo, hi } = PART_RANGE[part]
      if (note < lo || note > hi) worst = { midi, note }
    }
    ok(worst === null, `soprano melody -> ${part} stays in range`,
      worst ? `${nameOf(worst.midi)} gave ${nameOf(worst.note)}` : `${nameOf(PART_RANGE[part].lo)}–${nameOf(PART_RANGE[part].hi)}`)
  }

  // And it is never the note the singer is already on.
  let unison = null
  for (const part of ['soprano', 'alto', 'tenor', 'bass']) {
    for (let midi = 55; midi <= 76; midi += 1) {
      const [steps] = stepsForPart(midi, key, part)
      if (Math.abs(harmonyNote(midi, key, steps) - midi) < 2) unison = { part, midi }
    }
  }
  ok(unison === null, 'never doubles the singer in unison',
    unison ? `${unison.part} at ${nameOf(unison.midi)}` : 'across every part and note')
}

// ---------------------------------------------------------------------------
console.log('\n-- and the note it picks is in the key --')
{
  const key = { tonic: 7, mode: 'major' }        // G major: F#, no F natural
  const inKey = [7, 9, 11, 0, 2, 4, 6]           // G A B C D E F#
  let stray = null
  for (const part of ['soprano', 'alto', 'tenor', 'bass']) {
    for (let midi = 55; midi <= 76; midi += 1) {
      const [steps] = stepsForPart(midi, key, part)
      const pc = ((harmonyNote(midi, key, steps) % 12) + 12) % 12
      if (!inKey.includes(pc)) stray = { part, midi, pc }
    }
  }
  ok(stray === null, 'every harmony note is diatonic to G major',
    stray ? `${stray.part} at ${nameOf(stray.midi)} gave ${NAMES[stray.pc]}` : 'F natural never appears')
}

// ---------------------------------------------------------------------------
console.log('\n-- the anthem case, end to end --')
{
  const key = { tonic: 7, mode: 'major' }
  const you = 67                                  // G4, soprano start note
  const part = partnerOf(partOf(you))
  const [steps] = stepsForPart(you, key, part)
  const note = harmonyNote(you, key, steps)
  ok(part === 'alto', 'start on G4 and she takes the alto', `-> ${part}`)
  // The alto's own start note is D4. Landing on it exactly is not required --
  // the harmony follows the melody, not the recording -- but it must be alto
  // territory and below the singer.
  ok(note < you, 'and sings below the soprano', `${nameOf(note)} under ${nameOf(you)}`)
  ok(note >= PART_RANGE.alto.lo && note <= PART_RANGE.alto.hi,
    'in the alto range', `${nameOf(note)} (alto home is ${nameOf(PART_ANCHOR.alto)})`)
}

if (failures) {
  console.log(`\n${failures} failure(s).`)
  process.exit(1)
}
console.log('\nParts all good.')
