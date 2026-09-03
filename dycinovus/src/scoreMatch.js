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
export function framesToNotes(frames, minDur = 0.09) {
  const notes = []
  for (const f of frames) {
    if (!f.hz || f.hz <= 0) continue
    const midi = Math.round(midiFromHz(f.hz))
    const last = notes[notes.length - 1]
    if (last && last.midi === midi) last.end = f.t
    else notes.push({ midi, start: f.t, end: f.t })
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

/**
 * Work out WHICH line the singer is on, so ALZONA can take the other.
 *
 * Two signals, in order:
 *  1. how well the sung intervals fit that part — the lines are different
 *     melodies, so usually only one fits;
 *  2. when both fit, because the parts move in parallel through some passages,
 *     the singer's absolute pitch decides. Someone on the alto line sits at
 *     alto pitch: a near-zero offset against alto, a large one against soprano.
 */
export function identifyPart(userNotes, contours, candidates, opts = {}) {
  const found = []
  for (const part of candidates) {
    const notes = contours?.[part]?.notes
    if (!notes) continue
    const m = matchPosition(userNotes, notes, opts)
    if (m) found.push({ part, match: m })
  }
  if (!found.length) return null

  found.sort((a, b) => {
    const dc = b.match.confidence - a.match.confidence
    if (Math.abs(dc) > 0.15) return dc
    return Math.abs(a.match.semitoneOffset) - Math.abs(b.match.semitoneOffset)
  })
  return { part: found[0].part, match: found[0].match, alternatives: found.slice(1) }
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
