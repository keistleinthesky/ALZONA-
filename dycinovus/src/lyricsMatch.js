// =============================================================================
// Using the WORDS to find the singer's place
// =============================================================================
// Melody alone can take 6-17 notes to place a passage, because the anthem
// repeats phrases — the opening and the fifth line end with the same eight
// notes. The words do not repeat: "Bayang magiliw" happens once. So a single
// recognised line pins the position immediately.
//
// Deliberately a SUPPORTING signal. A lyric hint narrows where the melody
// matcher looks, and the melody still has to agree, so a mishearing costs a
// moment rather than a wrong entry.

/** Strip accents, punctuation and the elisions Filipino lyrics are full of. */
export function normalise(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // accents
    .replace(/['’`]/g, '')       // mo'y -> moy, 'di -> di
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const words = (text) => normalise(text).split(' ').filter(Boolean)

// Short words carry little identifying weight and are the ones recognition
// invents most often.
const WEAK = new Set(['sa', 'ng', 'at', 'ay', 'ka', 'na', 'may', 'di', 'mo', 'ang'])

/** How well some heard text matches a lyric line, 0..1. */
export function scoreLine(heard, line) {
  const h = words(heard)
  const l = words(line)
  if (!h.length || !l.length) return 0

  let hit = 0
  let weight = 0
  const pool = [...h]
  for (const w of l) {
    const strength = WEAK.has(w) ? 0.3 : 1
    weight += strength
    let idx = pool.indexOf(w)
    if (idx === -1) {
      // Mishearings usually keep the stem.
      idx = pool.findIndex(
        (p) => w.length >= 5 && (p.startsWith(w.slice(0, 4)) || w.startsWith(p.slice(0, 4))),
      )
    }
    if (idx !== -1) {
      pool.splice(idx, 1)
      hit += strength
    }
  }
  return weight ? hit / weight : 0
}

/**
 * Find which lyric line the heard text belongs to.
 *
 * Several lines fitting equally well means the words were too generic to place
 * — better to say nothing than send the matcher to the wrong bar.
 */
export function matchLyric(heard, lines, opts = {}) {
  const { minScore = 0.5, margin = 0.15 } = opts
  if (!heard || !lines?.length) return null

  const scored = lines
    .map((line, index) => ({ index, line, score: scoreLine(heard, line.text) }))
    .sort((a, b) => b.score - a.score)

  const best = scored[0]
  if (!best || best.score < minScore) return null
  const rival = scored.find((s) => s.index !== best.index)
  if (rival && best.score - rival.score < margin) return null
  return best
}

/**
 * Turn a lyric match into a time window for the melody matcher.
 *
 * Padded generously: the singer may be part-way through the line by the time
 * the words are recognised, and the alignment itself is approximate.
 */
export function lyricWindow(match, padBefore = 2.5, padAfter = 6) {
  if (!match) return null
  return { from: Math.max(0, match.line.t - padBefore), to: match.line.end + padAfter }
}
