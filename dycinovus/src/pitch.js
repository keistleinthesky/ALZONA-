// =============================================================================
// Pitch detection + note maths for the Lupang Hinirang singing features.
// =============================================================================
// Kept as a standalone module (no React, no Web Audio) so it can be unit-tested
// against synthetic tones — see pitch.test.mjs. The detector is the part most
// likely to break silently: a wrong octave still "works", it just harmonises
// against the wrong note.

export const A4 = 440
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

// SATB offsets in semitones against the user's melody. Mirrors SATB_OFFSETS in
// main.py — keep the two in step if you change them.
export const SATB_OFFSETS = { soprano: 0, alto: -5, tenor: -12, bass: -24 }

// The user always starts Lupang Hinirang on G4, so that is our key anchor.
export const REFERENCE_HZ = 392.0 // G4

// Singing sits roughly here; anything outside is noise, not a sung note.
const MIN_HZ = 65 // C2
const MAX_HZ = 1200 // ~D6

export const midiFromHz = (hz) => 69 + 12 * Math.log2(hz / A4)
export const hzFromMidi = (m) => A4 * Math.pow(2, (m - 69) / 12)

export function noteLabel(hz) {
  if (!hz || hz <= 0) return { name: '—', octave: '', cents: 0, midi: null }
  const midi = midiFromHz(hz)
  const rounded = Math.round(midi)
  const cents = Math.round((midi - rounded) * 100)
  return {
    name: NOTE_NAMES[((rounded % 12) + 12) % 12],
    octave: Math.floor(rounded / 12) - 1,
    cents,
    midi: rounded,
  }
}

/**
 * Normalised autocorrelation with parabolic interpolation.
 *
 * Chosen over FFT peak-picking because a sung vowel has a strong harmonic stack
 * that fools spectral methods into reporting the wrong octave; autocorrelation
 * locks onto the true fundamental, which is what we need to harmonise against.
 *
 * @returns {{hz: number, clarity: number, rms: number}} hz is -1 when no
 *   confident pitch was found (silence, noise, or out of singing range).
 */
export function detectPitch(buf, sampleRate) {
  const SIZE = buf.length

  // Gate on RMS so silence and room noise never register as a note.
  let rms = 0
  for (let i = 0; i < SIZE; i += 1) rms += buf[i] * buf[i]
  rms = Math.sqrt(rms / SIZE)
  if (rms < 0.012) return { hz: -1, clarity: 0, rms }

  // Trim leading/trailing near-silence to sharpen the correlation.
  const threshold = 0.2
  let start = 0
  let end = SIZE - 1
  while (start < SIZE / 2 && Math.abs(buf[start]) < threshold) start += 1
  while (end > SIZE / 2 && Math.abs(buf[end]) < threshold) end -= 1
  const trimmed = buf.slice(start, end)
  const n = trimmed.length
  if (n < 512) return { hz: -1, clarity: 0, rms }

  const c = new Float32Array(n).fill(0)
  for (let lag = 0; lag < n; lag += 1) {
    let sum = 0
    for (let i = 0; i < n - lag; i += 1) sum += trimmed[i] * trimmed[i + lag]
    c[lag] = sum
  }

  // Walk past the zero-lag peak, then take the highest following peak.
  let d = 0
  while (d < n - 1 && c[d] > c[d + 1]) d += 1
  let maxVal = -1
  let maxPos = -1
  for (let i = d; i < n; i += 1) {
    if (c[i] > maxVal) {
      maxVal = c[i]
      maxPos = i
    }
  }
  if (maxPos <= 0) return { hz: -1, clarity: 0, rms }

  // Parabolic interpolation around the peak — without this the reported pitch
  // quantises to the sample grid and the harmony drifts audibly sharp/flat.
  let T = maxPos
  const x1 = c[maxPos - 1] ?? c[maxPos]
  const x2 = c[maxPos]
  const x3 = c[maxPos + 1] ?? c[maxPos]
  const a = (x1 + x3 - 2 * x2) / 2
  const b = (x3 - x1) / 2
  if (a !== 0) T = maxPos - b / (2 * a)

  const hz = sampleRate / T
  const clarity = c[0] > 0 ? maxVal / c[0] : 0
  if (hz < MIN_HZ || hz > MAX_HZ || clarity < 0.5) return { hz: -1, clarity, rms }
  return { hz, clarity, rms }
}
