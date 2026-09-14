// =============================================================================
// Working out WHERE in the song the singer is, and WHICH line they are on
// =============================================================================
// The singer leads: they begin wherever they like — the opening, the middle,
// the last line — and ALZONA finds that spot and comes in with the other part.
//
// Matching is done on INTERVALS, not absolute pitches. The gap between
// consecutive notes is the same in any key, so a melody starting on G4 and the
// same melody starting on B4 produce identical interval sequences. That makes
// the match transposition-proof for free, and the leftover pitch difference
// says how far to transpose the harmony.

const A4 = 440
export const midiFromHz = (hz) => 69 + 12 * Math.log2(hz / A4)

/**
 * Collapse raw per-frame pitches into held notes.
 *
 * @param {{t:number, hz:number}[]} frames
 * @param {number} minDur  drop anything shorter — pitch wobble between notes
 *   otherwise shows up as spurious one-frame "notes" and wrecks the intervals.
 */
// How far the voice must move from the note it is on before that counts as a
// NEW note. A singer holding one pitch drifts by a quarter tone constantly, and
// rounding every frame independently turned that drift into alternating notes:
// one steady G came back as F#, G, F#, G. Those fake steps are what the matcher
// then tried to find in the anthem, which is why a correctly heard voice could
// still fail to match anything.
const HOLD_BAND = 0.65

// Frames further apart than this are not the same note, however close in pitch.
// Without it a pause of any length is swallowed into whatever came before.
const MAX_FRAME_GAP = 0.25

// Frames used for the running median. Wide enough to ride over a single bad
// reading, short enough not to smear a real step between two notes.
const SMOOTH_WINDOW = 5

/**
 * Turn a stream of pitch frames into notes.
 *
 * Two guards against a human voice, both learned from live telemetry:
 * a running median so one stray frame cannot split a note, and a hold band so
 * ordinary drift around a semitone boundary does not either.
 */
export function framesToNotes(frames, minDur = 0.09, {
  holdBand = HOLD_BAND,
  smooth = SMOOTH_WINDOW,
  maxGap = MAX_FRAME_GAP,
} = {}) {
  const pts = []
  for (const f of frames) {
    if (!f.hz || f.hz <= 0) continue
    pts.push({ t: f.t, m: midiFromHz(f.hz) })
  }
  if (!pts.length) return []

  const half = Math.max(0, Math.floor(smooth / 2))
  const smoothed = pts.map((p, i) => {
    const lo = Math.max(0, i - half)
    const hi = Math.min(pts.length, i + half + 1)
    const w = pts.slice(lo, hi).map((x) => x.m).sort((a, b) => a - b)
    return { t: p.t, m: w[Math.floor(w.length / 2)] }
  })

  const notes = []
  let cur = null
  let prevT = null
  for (const p of smoothed) {
    const gapped = prevT !== null && p.t - prevT > maxGap
    prevT = p.t
    if (cur && !gapped && Math.abs(p.m - cur.midi) <= holdBand) {
      cur.end = p.t
      continue
    }
    cur = { midi: Math.round(p.m), start: p.t, end: p.t }
    notes.push(cur)
  }
  return notes.filter((n) => n.end - n.start >= minDur)
}

/** Semitone steps between consecutive notes. */
function intervals(midis) {
  const out = []
  for (let i = 1; i < midis.length; i += 1) out.push(midis[i] - midis[i - 1])
  return out
}

/**
 * Merge runs of the same pitch into one note, keeping the first one's time.
 *
 * Nearly a third of the notes in this anthem are repeats — "B4 B4 B4" across
 * three syllables. Whether those arrive as one note or three depends entirely
 * on articulation: a gap between syllables splits them, singing legato does
 * not. The reference was extracted from a recording with its own articulation,
 * so comparing raw sequences compares performances rather than melodies, and
 * the match breaks wherever the two differ.
 *
 * Collapsing both sides compares melodic SHAPE, which is what identifies a
 * passage. Repeats carry no interval information anyway — their step is zero.
 */
export function collapseRepeats(notes) {
  const out = []
  for (const n of notes) {
    const last = out[out.length - 1]
    if (last && last.midi === n.midi) continue
    out.push(n)
  }
  return out
}

function median(xs) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export const MIN_NOTES_TO_MATCH = 4
// Minimum number of pitch CHANGES (after collapsing repeats) before a match is
// trusted. Repeats carry no melodic information, so this is the real evidence.
export const MIN_DISTINCT_TO_MATCH = 6

/**
 * Find where in `partNotes` the singer's phrase begins.
 *
 * @param {{midi:number}[]} userNotes  what the singer has produced so far
 * @param {{midi:number, t:number}[]} partNotes  the reference melody
 * @param {object} [opts]
 * @param {number} [opts.maxIntervalError=0.45] semitones of slack per interval.
 *   Deliberately tight: a phrase with a fluffed note should come back as "not
 *   sure yet" so the next few notes settle it, rather than matching confidently
 *   somewhere else in the song.
 * @param {number} [opts.uniqueMargin=0.25] how far ahead of a distant rival the
 *   winner must be before it is trusted
 * @param {{from:number,to:number}} [opts.window] restrict the search to this
 *   stretch of the recording — used to apply a lyric hint
 * @returns {{time:number, index:number, semitoneOffset:number,
 *            confidence:number, matched:number}|null}
 */
export function matchPosition(userNotes, partNotes, opts = {}) {
  const { maxIntervalError = 0.45, uniqueMargin = 0.25, window = null } = opts
  if (userNotes.length < MIN_NOTES_TO_MATCH || partNotes.length < MIN_NOTES_TO_MATCH) {
    return null
  }

  const user = collapseRepeats(userNotes)
  const part = collapseRepeats(partNotes)
  // Collapsing shortens the phrase, so demand more DISTINCT pitches than raw
  // notes. Without this a six-note phrase collapsing to four matches on very
  // little evidence — which is how one fluffed note ended up matching
  // confidently in the wrong part of the song.
  if (user.length < MIN_DISTINCT_TO_MATCH || part.length < MIN_DISTINCT_TO_MATCH) {
    return null
  }

  const userMidis = user.map((n) => n.midi)
  const userIv = intervals(userMidis)
  const partMidis = part.map((n) => n.midi)

  // A phrase whose every step is the same size — a chromatic run, a plain scale
  // — carries no positional information: it fits anywhere the score happens to
  // move that way. Refuse rather than guess.
  if (new Set(userIv).size < 2) return null

  // No trimming of "worst" intervals: a single fluffed note corrupts two
  // intervals by a semitone each, which the average already absorbs at this
  // tolerance. Discarding the worst instead lets genuinely different passages
  // score perfectly on whatever is left.
  const scored = []
  for (let i = 0; i + userIv.length < partMidis.length; i += 1) {
    if (window && (part[i].t < window.from || part[i].t > window.to)) continue
    let sum = 0
    for (let k = 0; k < userIv.length; k += 1) {
      sum += Math.abs(userIv[k] - (partMidis[i + k + 1] - partMidis[i + k]))
    }
    scored.push({ avg: sum / userIv.length, index: i })
  }
  if (!scored.length) return null

  scored.sort((a, b) => (a.avg - b.avg) || (a.index - b.index))
  let best = scored[0]
  if (best.avg > maxIntervalError) return null

  // Phrases in this anthem share tails — the opening and the fifth line end
  // with the same eight notes. A partial capture of either fits both places
  // almost equally, and picking whichever scored a hair better put ALZONA
  // twelve seconds into the song while the singer was still on line one. Among
  // candidates that fit essentially as well, prefer the EARLIEST: singers far
  // more often start at the beginning than partway through.
  const nearTie = 0.12
  for (const s of scored) {
    if (s.avg - best.avg > nearTie) break
    if (s.index < best.index) best = s
  }

  // A passage that genuinely recurs is real ambiguity, not an error — return
  // null so the caller keeps listening. Coming in at the wrong repeat sounds
  // right for a bar and then diverges.
  const rival = scored.find((s) => Math.abs(s.index - best.index) > 2)
  if (rival && rival.avg - best.avg < uniqueMargin) return null

  const offsets = userMidis.map((m, k) => m - partMidis[best.index + k])
  return {
    time: part[best.index].t,
    index: best.index,
    semitoneOffset: Math.round(median(offsets)),
    confidence: Math.max(0, 1 - best.avg / maxIntervalError),
    matched: userMidis.length,
  }
}

// An octave is not a key. Someone singing the alto line an octave up is still
// singing alto, but the raw offset reads +12 — "miles from alto" — and the old
// tie-break handed them the soprano line for it. Folding to the nearest octave
// measures what actually matters: how far from the WRITTEN PITCH they are,
// regardless of which octave they are comfortable in.
const OCTAVE = 12
const foldToOctave = (semis) => semis - OCTAVE * Math.round(semis / OCTAVE)

// How much the pitch register is allowed to weigh against the interval fit.
// Intervals identify the melody; register separates two lines that move in
// parallel, which is exactly where intervals alone cannot decide.
const REGISTER_WEIGHT = 0.5

// The winner must beat the runner-up by this much. Below it both lines fit the
// singing about equally, and committing is a coin toss that sounds wrong for a
// bar and then diverges. Refusing costs a phrase of waiting; guessing costs the
// whole entrance.
const PART_MARGIN = 0.15

/**
 * Work out WHICH line the singer is on, so ALZONA can take the other.
 *
 * Two independent signals, combined rather than ranked:
 *
 *  1. INTERVAL FIT — the lines are different melodies, so usually only one of
 *     them moves the way the singer is moving. Transposition-invariant, so it
 *     holds in any key.
 *  2. REGISTER — where the voice actually sits. Through passages where the two
 *     parts move in parallel the intervals are identical and cannot decide;
 *     someone on the alto line sits at alto pitch, and that settles it. Octave
 *     is folded out first: singing alto an octave up is still singing alto.
 *
 * Returns null when the two are too close to call, which is a real answer —
 * she keeps listening and comes in a phrase later rather than on the wrong line.
 */
export function identifyPart(userNotes, contours, candidates, opts = {}) {
  const {
    partMargin = PART_MARGIN,
    minConfidence = 0,
    registerWeight = REGISTER_WEIGHT,
  } = opts

  const found = []
  for (const part of candidates) {
    const notes = contours?.[part]?.notes
    if (!notes) continue
    const m = matchPosition(userNotes, notes, opts)
    if (!m || m.confidence < minConfidence) continue
    // 0 = singing exactly at the written pitch (in some octave), 6 = a tritone
    // away, which is as far as it is possible to be.
    const keyError = Math.abs(foldToOctave(m.semitoneOffset))
    const score = m.confidence + registerWeight * (1 - keyError / 6)
    found.push({ part, match: m, keyError, score })
  }
  if (!found.length) return null

  found.sort((a, b) => b.score - a.score)
  const best = found[0]
  const second = found[1]

  // Too close to call. Say so rather than pick one.
  if (second && best.score - second.score < partMargin) return null

  return {
    part: best.part,
    match: best.match,
    keyError: best.keyError,
    score: best.score,
    margin: second ? best.score - second.score : Infinity,
    runnerUp: second ? { part: second.part, score: second.score } : null,
    alternatives: found.slice(1),
  }
}

/** The line ALZONA should sing against a singer on `part`. */
export function counterpart(part, available = ['soprano', 'alto']) {
  return available.find((p) => p !== part) ?? part
}

/** Describe the match in words — "phrase 4 (0:26)" beats a note index. */
export function describePosition(match, boundaries = []) {
  if (!match) return 'listening…'
  const t = match.time
  const stamp = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
  const phrase = boundaries.filter((b) => b <= t).length + 1
  const key =
    match.semitoneOffset === 0
      ? 'as written'
      : `${match.semitoneOffset > 0 ? '+' : ''}${match.semitoneOffset} semitones`
  return `phrase ${phrase} (${stamp}), ${key}`
}
