// Unit tests for the genetic-algorithm chord harmoniser.
//   node src/chordGA.test.mjs        (run from the dycinovus folder)
//
// A genetic algorithm is a black box that always returns SOMETHING, and the
// something is always plausible — eight roman numerals in the right key, which
// is exactly what a correct answer looks like too. So the tests here are mostly
// not about the search at all. They pin down the fitness function piece by
// piece, because that is where every musical claim this module makes lives, and
// then check only the handful of things the search itself must guarantee:
// reproducibility, that elitism never loses ground, and that a real melody
// comes out better harmonised than the laziest possible answer.

import {
  barCongruence,
  cadenceScore,
  chordName,
  chordTones,
  evolve,
  fitness,
  flowScore,
  harmonize,
  idiomScore,
  keyOf,
  motionScore,
  romanOf,
  toBars,
  varietyScore,
  voiceChord,
} from './chordGA.js'

let failures = 0

function eq(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} got ${actual}  want ${expected}`)
}

function same(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  const ok = a === b
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} got ${a}  want ${b}`)
}

function ok(name, condition, detail = '') {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`)
}

const C_MAJOR = { tonic: 0, mode: 'major' }
const A_MINOR = { tonic: 9, mode: 'minor' }

// ---------------------------------------------------------------------------
console.log('\n-- triads come out of the scale, not out of a table --')
// Nothing anywhere says "the seventh degree is diminished" or "the second is
// minor". Stacking scale thirds produces that, and if it did not, every chord
// the GA could choose would be wrong in a way no amount of searching fixes.
same('I in C major is C E G', chordTones(0, C_MAJOR), [0, 4, 7])
same('ii in C major is D F A', chordTones(1, C_MAJOR), [2, 5, 9])
same('V in C major is G B D', chordTones(4, C_MAJOR), [7, 11, 2])
same('vii in C major is B D F', chordTones(6, C_MAJOR), [11, 2, 5])
eq('and it knows vii is diminished', chordName(6, C_MAJOR), 'Bdim')
eq('ii is minor', chordName(1, C_MAJOR), 'Dm')
eq('IV is major', chordName(3, C_MAJOR), 'F')

console.log('\n-- the same code in the minor --')
same('i in A minor is A C E', chordTones(0, A_MINOR), [9, 0, 4])
same('v in A minor is E G B', chordTones(4, A_MINOR), [4, 7, 11])
eq('v is MINOR in a natural minor key', chordName(4, A_MINOR), 'Em')
eq('VII is major', chordName(6, A_MINOR), 'G')
eq('numerals follow the mode', romanOf(6, A_MINOR), 'VII')
eq('numerals follow the mode (major)', romanOf(6, C_MAJOR), 'vii°')

console.log('\n-- voicing parks the chord in one register --')
// Accompaniment that follows the melody around leaps an octave whenever the
// singer does. The root is pinned into the octave above `lo` instead.
same('C major triad above C3', voiceChord(0, C_MAJOR, { lo: 48 }), [48, 52, 55])
same('V voices in the same octave', voiceChord(4, C_MAJOR, { lo: 48 }), [55, 59, 62])
ok(
  'every degree lands in one octave',
  [0, 1, 2, 3, 4, 5, 6].every((d) => {
    const r = voiceChord(d, C_MAJOR, { lo: 48 })[0]
    return r >= 48 && r < 60
  }),
)

// ---------------------------------------------------------------------------
console.log('\n-- barlines cut notes, they do not swallow them --')
const straddle = toBars([{ midi: 60, beats: 6 }], 4)
eq('a six-beat note spans two bars', straddle.length, 2)
eq('four beats of it sound in bar 1', straddle[0][0].beats, 4)
eq('and two in bar 2', straddle[1][0].beats, 2)
eq('the tail starts on bar 2 downbeat', straddle[1][0].onset, 0)

const withRest = toBars(
  [{ midi: 60, beats: 2 }, { midi: null, beats: 2 }, { midi: 62, beats: 4 }],
  4,
)
eq('rests take up their bar', withRest.length, 2)
eq('but put no note in it', withRest[0].length, 1)

// ---------------------------------------------------------------------------
console.log('\n-- 1. congruence: does the melody fit the chord --')
const ceg = toBars([{ midi: 60 }, { midi: 64 }, { midi: 67 }, { midi: 72 }], 4)[0]
eq('C E G C under I', barCongruence(ceg, 0, C_MAJOR), 1)
eq('...under ii, nothing fits', barCongruence(ceg, 1, C_MAJOR), 0)
ok('...under vi, partly', barCongruence(ceg, 5, C_MAJOR) > 0 && barCongruence(ceg, 5, C_MAJOR) < 1)
eq('an empty bar has no opinion', barCongruence([], 0, C_MAJOR), null)

// A clash on the downbeat is worse than the same clash offbeat. Without this
// the GA cheerfully puts a chord under a bar whose longest, loudest, most
// exposed note is the one note that does not belong to it.
const onBeat = toBars([{ midi: 62 }, { midi: 60 }, { midi: 64 }, { midi: 67 }], 4)[0]
const offBeat = toBars([{ midi: 60 }, { midi: 62 }, { midi: 64 }, { midi: 67 }], 4)[0]
ok(
  'a wrong note hurts more on the downbeat',
  barCongruence(onBeat, 0, C_MAJOR) < barCongruence(offBeat, 0, C_MAJOR),
  `${barCongruence(onBeat, 0, C_MAJOR).toFixed(3)} < ${barCongruence(offBeat, 0, C_MAJOR).toFixed(3)}`,
)

// ---------------------------------------------------------------------------
console.log('\n-- 2. flow: dominants resolve, they do not retreat --')
eq('V -> I is the best move there is', flowScore(4, 0), 1)
eq('V -> IV is the one real mistake', flowScore(4, 3), 0)
ok('I -> IV is good', flowScore(0, 3) > flowScore(0, 0))
ok('ii -> V is good', flowScore(1, 4) === 1)
ok('vi counts as home', flowScore(5, 4) === flowScore(0, 4))

console.log('\n-- 3. cadence: the ending is the audible part --')
ok(
  'a perfect cadence beats stopping on iii',
  cadenceScore([0, 3, 4, 0]) > cadenceScore([0, 3, 4, 2]),
)
ok(
  'V-I beats IV-I into the same tonic',
  cadenceScore([0, 3, 4, 0]) > cadenceScore([0, 4, 3, 0]),
)
ok('and beats a deceptive ending', cadenceScore([0, 3, 4, 0]) > cadenceScore([0, 3, 4, 5]))

console.log('\n-- 4. variety: I everywhere is not a harmonisation --')
eq('eight bars of I', varietyScore([0, 0, 0, 0, 0, 0, 0, 0]), 0.25)
eq('four different chords is full marks', varietyScore([0, 3, 4, 0, 5, 1, 4, 0]), 1)
eq('a two-bar phrase is not punished for being short', varietyScore([4, 0]), 1)

console.log('\n-- 5. motion: root movement --')
ok('a fifth is the strongest move', motionScore(4, 0, C_MAJOR) === 1)
ok('a repeat is the weakest', motionScore(0, 0, C_MAJOR) < motionScore(0, 1, C_MAJOR))

console.log('\n-- 6. idiom: chords nobody actually writes --')
// B-D-F covers three notes of C major, so vii° ties with I or V on congruence
// bar after bar and the search will happily fill a chart with diminished
// triads. Nothing in the other five terms can object, because the objection is
// about the repertoire rather than about the notes in the bar.
ok('I IV V I is as ordinary as a chart gets', idiomScore([0, 3, 4, 0], C_MAJOR) > 0.98)
ok(
  'a diminished chart scores far worse than a plain one',
  idiomScore([6, 6, 6, 6], C_MAJOR) < idiomScore([0, 3, 4, 0], C_MAJOR) * 0.5,
)
ok('vi and ii are ordinary enough', idiomScore([0, 5, 1, 4], C_MAJOR) > 0.8)
ok('iii is not', idiomScore([0, 2, 2, 4], C_MAJOR) < idiomScore([0, 5, 5, 4], C_MAJOR))

// The minor mode is not the major table with different names on it. Scoring a
// minor key with the major prior punishes III and VII — which in a minor song
// are the relative major and the flat seventh, two of the commonest chords
// available — and lets the diminished ii° through unchallenged.
ok(
  'in minor, i VI III VII is completely ordinary',
  idiomScore([0, 5, 2, 6], A_MINOR) > 0.85,
  idiomScore([0, 5, 2, 6], A_MINOR).toFixed(2),
)
ok(
  'the same numerals are odd in major',
  idiomScore([0, 5, 2, 6], C_MAJOR) < 0.65,
  idiomScore([0, 5, 2, 6], C_MAJOR).toFixed(2),
)
ok(
  'the rare chord in minor is ii°, not vii',
  idiomScore([1, 1, 1, 1], A_MINOR) < idiomScore([6, 6, 6, 6], A_MINOR),
)
ok(
  'and in major it is vii°, not ii',
  idiomScore([6, 6, 6, 6], C_MAJOR) < idiomScore([1, 1, 1, 1], C_MAJOR),
)

// ---------------------------------------------------------------------------
console.log('\n-- the search --')

// Twelve bars of Twinkle Twinkle, 4/4, in C. Chosen because everybody already
// knows what it should sound like: if the GA puts something strange under it,
// the numerals give it away without anyone having to listen.
const N = { C: 60, D: 62, E: 64, F: 65, G: 67, A: 69 }
const bar = (a, b, c, d) => [
  { midi: a, beats: 1 },
  { midi: b, beats: 1 },
  { midi: c, beats: d === undefined ? 2 : 1 },
  ...(d === undefined ? [] : [{ midi: d, beats: 1 }]),
]
const TWINKLE = [
  ...bar(N.C, N.C, N.G, N.G), ...bar(N.A, N.A, N.G),
  ...bar(N.F, N.F, N.E, N.E), ...bar(N.D, N.D, N.C),
  ...bar(N.G, N.G, N.F, N.F), ...bar(N.E, N.E, N.D),
  ...bar(N.G, N.G, N.F, N.F), ...bar(N.E, N.E, N.D),
  ...bar(N.C, N.C, N.G, N.G), ...bar(N.A, N.A, N.G),
  ...bar(N.F, N.F, N.E, N.E), ...bar(N.D, N.D, N.C),
]

const key = keyOf(TWINKLE)
eq('it works out the key on its own', key.tonic, 0)
eq('...and the mode', key.mode, 'major')

const result = harmonize(TWINKLE, { seed: 7 })
const numerals = result.chords.map((c) => c.roman)
console.log(`      ${numerals.join('  ')}`)
console.log(`      ${result.chords.map((c) => c.name).join('  ')}`)
console.log(
  `      fitness ${result.score.toFixed(3)}  ` +
    Object.entries(result.parts).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  '),
)

eq('one chord per bar', result.chords.length, 12)
ok('every chord is diatonic', result.chords.every((c) => c.degree >= 0 && c.degree <= 6))
eq('it ends at home', result.chords[11].degree, 0)
ok('it does not end on a plagal shrug', result.chords[10].degree === 4 || result.chords[10].degree === 6)
ok('it uses at least four chords', new Set(result.chords.map((c) => c.degree)).size >= 4)
ok(
  'no dominant retreats to a subdominant',
  result.chords.every((c, i) => i === 0 || flowScore(result.chords[i - 1].degree, c.degree) > 0),
)

// The laziest answer that still ends correctly. If the search cannot beat it,
// the fitness function is not describing harmony.
const bars12 = toBars(TWINKLE, 4)
const allTonic = fitness(Array(12).fill(0), bars12, key).total
ok(
  'it beats twelve bars of plain I',
  result.score > allTonic,
  `${result.score.toFixed(3)} > ${allTonic.toFixed(3)}`,
)

// Hand-written by a human who knows the tune. The GA is not required to find
// this exact progression — several are defensible — only to land in the same
// neighbourhood rather than well below it.
const BYHAND = [0, 0, 3, 0, 0, 0, 0, 4, 0, 3, 0, 0].map((d, i) => (i === 11 ? 0 : d))
const byHand = fitness(BYHAND, bars12, key).total
ok(
  'it is in the same league as a hand-written chart',
  result.score > byHand * 0.95,
  `${result.score.toFixed(3)} vs ${byHand.toFixed(3)}`,
)

console.log('\n-- the search behaves --')
const a = harmonize(TWINKLE, { seed: 7 })
const b = harmonize(TWINKLE, { seed: 7 })
same(
  'the same seed gives the same answer',
  a.chords.map((c) => c.degree),
  b.chords.map((c) => c.degree),
)

const run = evolve(bars12, key, { seed: 3 })
ok(
  'elitism means the best never gets worse',
  run.history.every((s, i) => i === 0 || s >= run.history[i - 1] - 1e-12),
)
ok(
  'and it actually improves on the random start',
  run.history[run.history.length - 1] > run.history[0],
  `${run.history[0].toFixed(3)} -> ${run.history[run.history.length - 1].toFixed(3)}`,
)

// Seeds should disagree on the details — if they all converge on one genome the
// population has collapsed and the search is doing no work.
const spread = new Set(
  [1, 2, 3, 4, 5, 6].map((s) => harmonize(TWINKLE, { seed: s }).chords.map((c) => c.degree).join()),
)
ok('different seeds explore different answers', spread.size > 1, `${spread.size} of 6 distinct`)

// The regression the idiom term exists to prevent. Before it, a run of eight
// seeds put diminished triads and mediants through the middle of Twinkle — a
// chart that scores well and that nobody would play.
const allDegrees = [1, 2, 3, 4, 5, 6, 7, 8].flatMap(
  (s) => harmonize(TWINKLE, { seed: s }).chords.map((c) => c.degree),
)
const rare = allDegrees.filter((d) => d === 2 || d === 6).length
ok(
  'it does not reach for iii or vii over eight seeds',
  rare === 0,
  `${rare} of ${allDegrees.length}`,
)

console.log('\n-- a minor key is harmonised in the minor --')
const minorResult = harmonize(TWINKLE, { key: A_MINOR, seed: 2 })
ok(
  'numerals are the minor set',
  minorResult.chords.every((c) => ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'].includes(c.roman)),
)
eq('and it still ends at home', minorResult.chords[11].roman, 'i')

// ---------------------------------------------------------------------------
console.log('\n-- awkward input --')
const single = harmonize([{ midi: 60, beats: 4 }], { seed: 1 })
eq('a one-bar melody gets one chord', single.chords.length, 1)
const silent = harmonize([{ midi: null, beats: 8 }], { seed: 1 })
eq('a bar of silence still gets chords', silent.chords.length, 2)
const ragged = harmonize([{ midi: 60, beats: 4 }, { midi: 64, beats: 1 }], { seed: 1 })
eq('a part bar counts as a bar', ragged.chords.length, 2)

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILURES`}\n`)
process.exit(failures === 0 ? 0 : 1)
