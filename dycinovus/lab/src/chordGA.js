// =============================================================================
// Harmonising a melody with a genetic algorithm.
// =============================================================================
// harmonyBrain.js answers "what note goes with THIS note", thirty milliseconds
// behind the singer, with no memory of the phrase. This answers a different
// question: given a whole melody, what CHORDS go under it?
//
// That question cannot be answered a note at a time. A bar of C-E-G could sit
// on C, on Am, on Em or on F, and which one is right depends entirely on what
// came before it and what it has to lead to. There are seven diatonic chords
// and a typical phrase is eight bars, so there are 7^8 — about five and a half
// million — progressions to choose between, and no rule that picks the winner
// directly.
//
// So instead of deducing an answer we SEARCH for one: start with a crowd of
// random progressions, score each on how well it behaves, breed the good ones
// together, mutate a little, repeat. After eighty generations the population
// has drifted somewhere musical. That is the whole idea of a genetic algorithm,
// and harmony suits it because we can say precisely what "good" means (chord
// tones under the melody, movement that goes somewhere, a proper ending)
// without being able to say which progression is best.
//
// The fitness function is the real content here. The GA is just a search; every
// musical opinion this module holds lives in the five scoring terms below, and
// each is separately testable — see chordGA.test.mjs.
//
// No React, no Web Audio, no randomness that is not seeded. Same reason as
// harmonyBrain: the failure mode is a progression that is confident and wrong.

import { KeyTracker, PITCH_CLASSES, scaleOf } from './harmonyBrain.js'

// -----------------------------------------------------------------------------
// The chord vocabulary
// -----------------------------------------------------------------------------
// Seven diatonic triads, named by the scale degree they are built on. Staying
// diatonic is a real limitation — no secondary dominants, no borrowed chords,
// no sevenths — but it means every chord in the search space is already in the
// key, so the GA spends its generations on the interesting question (which
// chord, in which order) instead of rediscovering the key it was given.

export const DEGREES = [0, 1, 2, 3, 4, 5, 6]

export const ROMAN = {
  major: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'],
  minor: ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'],
}

/**
 * Semitone offsets from the tonic for the triad on `degree`, ascending.
 *
 * Built by stacking scale thirds rather than from a table of chord qualities,
 * so the qualities fall out of the key by themselves: the same code gives
 * C-E-G for I in C major and A-C-E for i in A minor, and gets vii diminished
 * without ever being told that the seventh degree is special.
 */
export function chordOffsets(degree, key) {
  const scale = scaleOf(key)
  const out = []
  for (const step of [0, 2, 4]) {
    const i = degree + step
    const oct = Math.floor(i / 7)
    out.push(scale[i - oct * 7] + 12 * oct)
  }
  return out
}

/** The triad's three pitch classes, 0-11. */
export function chordTones(degree, key) {
  const tonic = ((key.tonic % 12) + 12) % 12
  return chordOffsets(degree, key).map((o) => (tonic + o) % 12)
}

export const romanOf = (degree, key) => ROMAN[key.mode === 'minor' ? 'minor' : 'major'][degree]

/** "C", "Dm", "Bdim" — the name a guitarist would want written over the bar. */
export function chordName(degree, key) {
  const [root, third, fifth] = chordOffsets(degree, key)
  const letter = PITCH_CLASSES[(((key.tonic + root) % 12) + 12) % 12]
  const t = third - root
  const f = fifth - root
  if (f === 6) return letter + 'dim'
  if (f === 8) return letter + 'aug'
  return t === 3 ? letter + 'm' : letter
}

/**
 * The triad as playable MIDI notes, with its root parked in the octave above
 * `lo`. Accompaniment wants to sit under the tune in a fixed register rather
 * than following the melody around, otherwise the chords leap about whenever
 * the singer does.
 */
export function voiceChord(degree, key, { lo = 48 } = {}) {
  const offsets = chordOffsets(degree, key)
  let root = key.tonic + offsets[0]
  while (root < lo) root += 12
  while (root >= lo + 12) root -= 12
  return offsets.map((o) => root + (o - offsets[0]))
}

// -----------------------------------------------------------------------------
// Cutting a melody into bars
// -----------------------------------------------------------------------------
// The input is a flat run of notes — which is what you get from a sung phrase,
// a MIDI file or somebody typing a tune in — and chords are chosen per bar, so
// something has to draw the barlines. A note that straddles one is counted in
// BOTH bars, for the part of it that sounds there: a half note tied over the
// barline genuinely does have to fit the chord on either side of it, and
// pretending it belongs only to the bar it started in is how you end up with a
// progression that clashes with exactly the longest notes in the melody.

/** @param melody [{ midi, beats }] — midi null or undefined for a rest. */
export function toBars(melody, beatsPerBar = 4) {
  const total = melody.reduce((sum, n) => sum + Math.max(0, n.beats ?? 1), 0)
  const count = Math.max(1, Math.ceil(total / beatsPerBar - 1e-9))
  const bars = Array.from({ length: count }, () => [])

  let at = 0
  for (const note of melody) {
    const beats = Math.max(0, note.beats ?? 1)
    let left = beats
    let pos = at
    while (left > 1e-9) {
      const bar = Math.min(Math.floor(pos / beatsPerBar + 1e-9), count - 1)
      const room = (bar + 1) * beatsPerBar - pos
      const slice = Math.min(left, room > 1e-9 ? room : left)
      if (note.midi != null) {
        bars[bar].push({ midi: note.midi, beats: slice, onset: pos - bar * beatsPerBar })
      }
      pos += slice
      left -= slice
    }
    at += beats
  }
  return bars
}

/** Downbeat and the middle of the bar — where a clash is most exposed. */
const isStrong = (onset, beatsPerBar) =>
  onset < 1e-6 || Math.abs(onset - beatsPerBar / 2) < 1e-6

// -----------------------------------------------------------------------------
// Fitness: five opinions about what makes a progression good
// -----------------------------------------------------------------------------

/**
 * 1. CONGRUENCE — do the melody notes in this bar belong to the chord?
 *
 * Weighted by how long each note sounds and doubled on strong beats, because a
 * passing non-chord tone on an offbeat quaver is ordinary music and the same
 * note held through the downbeat is a mistake. Returns null for an empty bar so
 * rests neither help nor hurt.
 */
export function barCongruence(bar, degree, key, beatsPerBar = 4) {
  const tones = new Set(chordTones(degree, key))
  let hit = 0
  let all = 0
  for (const note of bar) {
    const w = note.beats * (isStrong(note.onset, beatsPerBar) ? 2 : 1)
    all += w
    if (tones.has(((Math.round(note.midi) % 12) + 12) % 12)) hit += w
  }
  return all > 0 ? hit / all : null
}

/**
 * 2. FLOW — functional harmony, the reason progressions feel like they are
 *    going somewhere.
 *
 * Every diatonic chord does one of three jobs: home (tonic), leaving home
 * (subdominant) or straining to get back (dominant). The conventional
 * circulation is T -> S -> D -> T, and the one move that sounds like a mistake
 * rather than a choice is D -> S, a dominant that gives up on resolving.
 *
 * The degree-to-function table is the same in major and minor, which is not a
 * coincidence: i, III and VI are the minor key's tonic chords for the same
 * reason I, iii and vi are the major key's — they share two notes with the
 * tonic triad.
 */
export const FUNCTION = ['T', 'S', 'T', 'S', 'D', 'T', 'D']

const FLOW = {
  T: { T: 0.5, S: 1.0, D: 0.9 },
  S: { T: 0.5, S: 0.4, D: 1.0 },
  D: { T: 1.0, S: 0.0, D: 0.4 },
}

export const flowScore = (from, to) => FLOW[FUNCTION[from]][FUNCTION[to]]

/**
 * 3. CADENCE — how it begins and, much more importantly, how it ends.
 *
 * A progression that is right for seven bars and stops on iii has not
 * harmonised anything; the ear waits for a door to close. Scored separately
 * from flow and weighted heavily because it is the single most audible thing
 * about a progression, and because it is the one place a rule really is a rule.
 */
const FINAL = { 0: 1.0, 5: 0.35 }
const PENULTIMATE = { 4: 1.0, 6: 0.7, 3: 0.65, 1: 0.5 }
const OPENING = { 0: 1.0, 5: 0.5, 3: 0.4 }

export function cadenceScore(genome) {
  const n = genome.length
  const open = OPENING[genome[0]] ?? 0.15
  const close = FINAL[genome[n - 1]] ?? 0
  const approach = n > 1 ? (PENULTIMATE[genome[n - 2]] ?? 0.2) : 0.5
  return 0.2 * open + 0.5 * close + 0.3 * approach
}

/**
 * 4. VARIETY — a guard against the cheapest way to win the congruence term.
 *
 * The tonic triad contains three of the seven notes in the key, so a genome of
 * nothing but I scores respectably on congruence, perfectly on cadence and
 * needs no thought at all. It is also not a harmonisation. Four different
 * chords is enough to count as full marks; past that, more variety is neither
 * better nor worse.
 */
export function varietyScore(genome) {
  const distinct = new Set(genome).size
  return Math.min(1, distinct / Math.min(4, genome.length))
}

/**
 * 5. MOTION — root movement, the plainest proxy for voice leading there is.
 *
 * Falling fifths are the strongest move in tonal music, steps are next, thirds
 * are gentle, and a chord repeated across a barline is inertia. This is the
 * lightest-weighted term: it breaks ties between progressions that the other
 * four already agree are fine.
 */
export function motionScore(from, to, key) {
  const a = chordTones(from, key)[0]
  const b = chordTones(to, key)[0]
  const d = (((b - a) % 12) + 12) % 12
  if (d === 5 || d === 7) return 1.0
  if (d === 2 || d === 10) return 0.8
  if (d === 0) return 0.3
  return 0.6
}

/**
 * 6. IDIOM — how ordinary each chord is.
 *
 * Added after watching the search discover that vii° fits a lot of melodies.
 * It does: B-D-F covers three notes of C major and ties with I or V on
 * congruence in bar after bar. But almost no song is harmonised with a run of
 * diminished triads, and iii is nearly as rare — the melody-fit term alone has
 * no way to know that, because rarity is a fact about the repertoire rather
 * than about the notes in the bar.
 *
 * Without this the algorithm produces charts that are correct on paper and that
 * no musician would write, which is the characteristic failure of scoring a
 * search purely on rules it can game.
 */
// Unlike FUNCTION, this genuinely differs between the modes, and using the
// major table in a minor key gets it backwards in the worst way. The rare chord
// in major is vii°; in minor the diminished triad moves to ii°, while III and
// VII — the relative major and the flat seventh, the C and the G in an A minor
// song — stop being colour and become two of the commonest chords there are.
export const IDIOM = {
  //      I     ii    iii   IV    V     vi    vii
  major: [1.0, 0.75, 0.4, 0.95, 1.0, 0.8, 0.3],
  //      i     ii°   III   iv    v     VI    VII
  minor: [1.0, 0.35, 0.85, 0.9, 0.85, 0.85, 0.9],
}

export const idiomScore = (genome, key) => {
  const table = IDIOM[key?.mode === 'minor' ? 'minor' : 'major']
  return genome.reduce((sum, d) => sum + table[d], 0) / genome.length
}

export const WEIGHTS = {
  congruence: 0.4,
  flow: 0.15,
  cadence: 0.18,
  variety: 0.08,
  motion: 0.04,
  idiom: 0.15,
}

/** @returns {{ total:number, parts:object }} everything on a 0-1 scale. */
export function fitness(genome, bars, key, { beatsPerBar = 4, weights = WEIGHTS } = {}) {
  let congSum = 0
  let congCount = 0
  for (let i = 0; i < genome.length; i += 1) {
    const c = barCongruence(bars[i] ?? [], genome[i], key, beatsPerBar)
    if (c !== null) {
      congSum += c
      congCount += 1
    }
  }

  let flowSum = 0
  let motionSum = 0
  for (let i = 1; i < genome.length; i += 1) {
    flowSum += flowScore(genome[i - 1], genome[i])
    motionSum += motionScore(genome[i - 1], genome[i], key)
  }
  const links = Math.max(1, genome.length - 1)

  const parts = {
    congruence: congCount > 0 ? congSum / congCount : 0.5,
    flow: genome.length > 1 ? flowSum / links : 0.5,
    cadence: cadenceScore(genome),
    variety: varietyScore(genome),
    motion: genome.length > 1 ? motionSum / links : 0.5,
    idiom: idiomScore(genome, key),
  }

  let total = 0
  for (const k of Object.keys(weights)) total += weights[k] * parts[k]
  return { total, parts }
}

// -----------------------------------------------------------------------------
// The genetic algorithm
// -----------------------------------------------------------------------------

/** Seeded PRNG (mulberry32) so a harmonisation is reproducible and testable. */
export function rng(seed = 1) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Pick a parent by small tournament rather than by fitness proportion.
 *
 * Roulette selection would let one early lucky genome dominate the population
 * within a few generations and the search would stop exploring. A tournament of
 * three keeps selection pressure mild and constant, which matters here because
 * every genome scores somewhere between 0.4 and 0.8 — the fitnesses are close
 * together, and proportional selection is nearly random when they are.
 */
function tournament(scored, random, size) {
  let best = scored[Math.floor(random() * scored.length)]
  for (let i = 1; i < size; i += 1) {
    const other = scored[Math.floor(random() * scored.length)]
    if (other.score > best.score) best = other
  }
  return best.genome
}

/**
 * Evolve a progression for `bars`.
 *
 * Crossover is single-point on purpose: harmony is sequential, so the useful
 * building block is a RUN of chords that work together (a ii-V-I), and a
 * one-point cut keeps runs intact where uniform crossover would shred them.
 *
 * Elitism keeps the best few untouched each generation, which makes the best
 * fitness monotonic — without it a good progression can be lost to the same
 * mutation that was supposed to be exploring.
 */
export function* evolveSteps(bars, key, options = {}) {
  const {
    population = 120,
    generations = 80,
    mutation = 0.08,
    elite = 4,
    tournamentSize = 3,
    beatsPerBar = 4,
    weights = WEIGHTS,
    seed = 1,
  } = options

  const n = bars.length
  const random = rng(seed)
  const randomDegree = () => Math.floor(random() * 7)
  const score = (g) => fitness(g, bars, key, { beatsPerBar, weights }).total

  let pop = Array.from({ length: population }, () =>
    Array.from({ length: n }, randomDegree),
  )

  const history = []
  let best = null

  for (let gen = 0; gen <= generations; gen += 1) {
    const scored = pop.map((genome) => ({ genome, score: score(genome) }))
    scored.sort((a, b) => b.score - a.score)
    if (!best || scored[0].score > best.score) {
      best = { genome: [...scored[0].genome], score: scored[0].score }
    }
    history.push(scored[0].score)

    // `history` is the live array rather than a copy — a caller drawing a graph
    // of it every generation would otherwise allocate one array per frame.
    yield {
      generation: gen,
      generations,
      genome: best.genome,
      score: best.score,
      thisGeneration: scored[0].score,
      spread: new Set(scored.map((s) => s.genome.join())).size,
      history,
    }
    if (gen === generations) break

    const next = scored.slice(0, elite).map((s) => [...s.genome])
    while (next.length < population) {
      const mum = tournament(scored, random, tournamentSize)
      const dad = tournament(scored, random, tournamentSize)
      const cut = n > 1 ? 1 + Math.floor(random() * (n - 1)) : 0
      const child = [...mum.slice(0, cut), ...dad.slice(cut)]
      for (let i = 0; i < n; i += 1) if (random() < mutation) child[i] = randomDegree()
      next.push(child)
    }
    pop = next
  }
}

/**
 * Run the search to the end.
 *
 * The generator above is the real implementation, so that a page can step the
 * search one generation at a time and DRAW it — watching a progression assemble
 * itself out of noise is the only way to see that this is a search rather than
 * a lookup. Everything that does not need to watch calls this instead.
 */
export function evolve(bars, key, options = {}) {
  let last = null
  for (const step of evolveSteps(bars, key, options)) last = step
  return { genome: last.genome, score: last.score, history: last.history }
}

// -----------------------------------------------------------------------------
// Key, and the front door
// -----------------------------------------------------------------------------

/**
 * Name the key of a written melody, reusing the same Krumhansl-Kessler
 * correlation that follows the key while somebody sings. Weighted by duration:
 * a semibreve says more about the key than a passing quaver.
 */
export function keyOf(melody) {
  const tracker = new KeyTracker({ halfLife: Infinity })
  let at = 0
  for (const note of melody) {
    const beats = Math.max(0, note.beats ?? 1)
    if (note.midi != null) tracker.observe(note.midi, beats, at)
    at += beats
  }
  const found = tracker.best()
  if (found) return found

  // Too little to correlate — fall back to the most-sung pitch class as tonic,
  // which for a fragment that short is as good a guess as anything.
  let tonic = 0
  let heaviest = -1
  for (let pc = 0; pc < 12; pc += 1) {
    if (tracker.weights[pc] > heaviest) {
      heaviest = tracker.weights[pc]
      tonic = pc
    }
  }
  return { tonic, mode: 'major', confidence: 0 }
}

/**
 * Dress a genome up as chords: where each one starts, what to call it, and
 * which notes to sound.
 *
 * Separate from harmonize() because a page watching the search needs this on
 * every generation, for a genome no one has finished evolving yet.
 */
export function chordsFrom(genome, key, { beatsPerBar = 4, lo = 48 } = {}) {
  return genome.map((degree, i) => ({
    bar: i,
    startBeat: i * beatsPerBar,
    beats: beatsPerBar,
    degree,
    roman: romanOf(degree, key),
    name: chordName(degree, key),
    pitchClasses: chordTones(degree, key),
    midi: voiceChord(degree, key, { lo }),
  }))
}

/**
 * Harmonise a melody.
 *
 * @param melody [{ midi, beats }] — midi null for a rest, beats defaulting to 1.
 * @returns { key, chords, score, parts, history }
 */
export function harmonize(melody, options = {}) {
  const { beatsPerBar = 4, key: given, lo = 48 } = options
  const key = given ?? keyOf(melody)
  const bars = toBars(melody, beatsPerBar)
  const { genome, score, history } = evolve(bars, key, { ...options, beatsPerBar })
  const { parts } = fitness(genome, bars, key, { beatsPerBar, weights: options.weights })
  return { key, chords: chordsFrom(genome, key, { beatsPerBar, lo }), score, parts, history }
}
