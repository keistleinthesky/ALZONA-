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
// How close a peak must come to the best one to be preferred for being
// earlier. 0.9 is McLeod's figure and it is what keeps octaves honest.
const OCTAVE_TOLERANCE = 0.9

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
export function detectPitch(buf, sampleRate, noiseFloor = 1e-5) {
  const SIZE = buf.length

  let rms = 0
  let peak = 0
  for (let i = 0; i < SIZE; i += 1) {
    rms += buf[i] * buf[i]
    const a = Math.abs(buf[i])
    if (a > peak) peak = a
  }
  rms = Math.sqrt(rms / SIZE)
  // No fixed level gate: microphone gain varies by an order of magnitude
  // between machines. Callers pass a floor learned from the room (NoiseFloor);
  // this only rejects true silence.
  if (rms < noiseFloor) return { hz: -1, clarity: 0, rms, why: 'gate' }

  // Trim leading/trailing near-silence to sharpen the correlation.
  //
  // This threshold MUST be relative to the signal. It was a fixed 0.2, which is
  // louder than a typical microphone ever reaches: for any quieter input both
  // walks met in the middle, leaving nothing to correlate, and the detector
  // reported no pitch at all. It only ever worked on loud synthetic test tones,
  // which is exactly why every test passed while the feature was deaf.
  const threshold = peak * 0.2
  let start = 0
  let end = SIZE - 1
  while (start < SIZE / 2 && Math.abs(buf[start]) < threshold) start += 1
  while (end > SIZE / 2 && Math.abs(buf[end]) < threshold) end -= 1
  const trimmed = buf.slice(start, end)
  const n = trimmed.length
  if (n < 512) return { hz: -1, clarity: 0, rms, why: 'trimmed' }

  // Normalised square difference (McLeod), not plain autocorrelation.
  //
  // Plain autocorrelation sums fewer products as the lag grows, so its values
  // taper off with lag. Taking the strongest peak then favours SHORT lags, and
  // a sung vowel correlates strongly at half its true period — which is how the
  // detector reported 743Hz for a note an octave lower. Dividing by the energy
  // actually involved at each lag removes that bias entirely and bounds the
  // result in [-1, 1], so the clarity figure means something absolute.
  const nsdf = new Float32Array(n)
  for (let lag = 0; lag < n; lag += 1) {
    let ac = 0
    let energy = 0
    for (let i = 0; i < n - lag; i += 1) {
      const a = trimmed[i]
      const b = trimmed[i + lag]
      ac += a * b
      energy += a * a + b * b
    }
    nsdf[lag] = energy > 0 ? (2 * ac) / energy : 0
  }

  // Only lags a voice can actually produce are candidates.
  //
  // This bound is what makes preferring the EARLIEST strong peak safe. Plain
  // autocorrelation tapers with lag, which suppressed short-lag harmonics as a
  // side effect; the normalisation removes that taper, so without an explicit
  // limit the earliest-peak rule happily locks onto a harmonic at four times
  // the true pitch. Measured live, that returned clarity 0.99 with the pitch
  // then thrown away for being out of range — a confident detector reporting
  // nothing at all. Restricting the search is the honest version of the bias
  // that used to be an accident of the maths.
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_HZ))
  const maxLag = Math.min(n - 2, Math.ceil(sampleRate / MIN_HZ))
  if (maxLag <= minLag) return { hz: -1, clarity: 0, rms, why: 'window' }

  const peaks = []
  let i = minLag
  while (i <= maxLag) {
    if (nsdf[i] <= 0) { i += 1; continue }
    let at = i
    while (i <= maxLag && nsdf[i] > 0) {
      if (nsdf[i] > nsdf[at]) at = i
      i += 1
    }
    peaks.push(at)
  }
  if (!peaks.length) return { hz: -1, clarity: 0, rms, why: 'nopeak' }

  // The EARLIEST peak that is nearly as good as the best one, rather than the
  // best outright. The octave above always produces a peak of its own; when it
  // happens to edge ahead, preferring the best halves the reported period and
  // the harmony comes out an octave wrong while still looking confident.
  let best = peaks[0]
  for (const p of peaks) if (nsdf[p] > nsdf[best]) best = p
  const cutoff = nsdf[best] * OCTAVE_TOLERANCE
  let maxPos = best
  for (const p of peaks) {
    if (nsdf[p] >= cutoff) { maxPos = p; break }
  }

  // Parabolic interpolation around the peak - without this the reported pitch
  // quantises to the sample grid and the harmony drifts audibly sharp/flat.
  let T = maxPos
  const x1 = nsdf[maxPos - 1] ?? nsdf[maxPos]
  const x2 = nsdf[maxPos]
  const x3 = nsdf[maxPos + 1] ?? nsdf[maxPos]
  const a = (x1 + x3 - 2 * x2) / 2
  const b = (x3 - x1) / 2
  // A maximum curves DOWNWARDS, so a >= 0 is not a peak at all and the vertex
  // is meaningless there. The clamp matters just as much: the vertex of a
  // parabola through three points either side of a true discrete maximum lies
  // within half a sample of it, so anything further is the arithmetic running
  // away, not a better estimate.
  //
  // Unguarded, a near-flat peak (a ~ 0) sent b/(2a) to infinity and T with it.
  // Live that produced periods of a fraction of a sample and "pitches" of
  // -3662Hz, 1462Hz, -6459Hz, all logged as out-of-range and discarded. The
  // note was being sung and the detector had found it; only this line lost it.
  if (a < 0) {
    const shift = -b / (2 * a)
    if (shift > -0.5 && shift < 0.5) T = maxPos + shift
  }

  const hz = sampleRate / T
  const clarity = Math.max(0, Math.min(1, nsdf[maxPos]))
  // Report the candidate that was refused, not just the refusal. A frame
  // reading "no pitch" at clarity 0.99 is a completely different fault from one
  // reading "no pitch" at clarity 0.1, and the two are indistinguishable
  // without this. Working that out from the outside cost several rounds.
  if (hz < MIN_HZ || hz > MAX_HZ) {
    return { hz: -1, clarity, rms, raw: hz, why: 'range' }
  }
  if (clarity < 0.5) return { hz: -1, clarity, rms, raw: hz, why: 'unclear' }
  return { hz, clarity, rms, why: 'ok' }
}

// A frame this many times the current floor is the singer, not the room, and is
// ignored when learning the floor.
const LOUD_MULTIPLE = 2.5
// The gate never rises above this. Real singing measures 0.02-0.3 RMS, so a
// gate beyond this point can only be wrong.
const MAX_GATE = 0.012

/**
 * Learns how quiet the room is, so "is anything happening?" adapts to the
 * microphone instead of assuming a level.
 *
 * Two failures this exists to prevent, both seen on real hardware:
 *  - a FIXED threshold chosen on one machine silently discarded every note on
 *    another whose microphone ran ten times quieter;
 *  - a floor that learns from every frame gets dragged up by the singing
 *    itself. Logged live, the gate walked from 0.003 to 0.042 in ten seconds
 *    and began rejecting the very voice it was listening for.
 */
export class NoiseFloor {
  constructor({ margin = 2.0, floor = 1.5e-4, adapt = 0.02 } = {}) {
    this.margin = margin
    this.hardFloor = floor
    this.adapt = adapt
    this.quiet = null
  }

  /** Feed the RMS of a frame; returns the level to gate on. */
  update(rms) {
    if (this.quiet === null) {
      this.quiet = rms
      return this.threshold
    }
    if (rms < this.quiet) {
      this.quiet += (rms - this.quiet) * 0.25          // fall quickly
    } else if (rms < this.quiet * LOUD_MULTIPLE) {
      this.quiet += (rms - this.quiet) * this.adapt    // creep up from background
    }
    // Louder than that is the singer, and must not move the floor at all.
    return this.threshold
  }

  get threshold() {
    return Math.min(
      MAX_GATE,
      Math.max(this.hardFloor, (this.quiet ?? 0) * this.margin),
    )
  }
}
