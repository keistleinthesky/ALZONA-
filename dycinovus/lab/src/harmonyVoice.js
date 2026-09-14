// =============================================================================
// ALZONA's second voice — your own singing, shifted live into a harmony line.
// =============================================================================
// This is the other half of the singing feature. The recorded SATB parts in
// harmonyPlayer.js are fixed audio: they only know one song, and they only work
// because we spend a lot of effort lining them up with you. This file has no
// song at all. It takes whatever comes out of the microphone and produces a
// second voice a few semitones away, note for note, however you phrase it.
//
// Time-domain PSOLA, not a phase vocoder and not a resampler.
//   - A resampler (playbackRate / detune) shifts the FORMANTS with the pitch,
//     which is the chipmunk sound. It is unusable on a voice.
//   - A phase vocoder keeps the formants but smears the transients: consonants
//     turn to slush and every word gets a watery halo.
//   - PSOLA cuts the signal into grains, one per glottal pulse, and lays them
//     back down at a different spacing. The grains themselves are untouched, so
//     the voice keeps its own timbre and its own words; only the rate of the
//     pulses changes, which is exactly and only what pitch is.
//
// The cost is that it needs to know where the glottal pulses ARE, so the period
// tracking below is not optional decoration — it is the algorithm.
//
// SELF-CONTAINED ON PURPOSE. This file is loaded twice: once as an AudioWorklet
// module (where imports are unreliable and there is no DOM), and once by
// harmonyVoice.test.mjs under node, which runs the shifter offline over a
// synthetic vowel and measures what came out. Anything imported here would
// break the first; anything Web-Audio-specific would break the second. So the
// DSP is a plain class, and the processor wrapper at the bottom only exists
// when there is a registerProcessor to call.

export const PROCESSOR_NAME = 'harmony-voice'

// The range the PERIOD TRACKER searches. Not the range of the harmony — the
// harmony can go wherever the interval takes it. Widening this costs latency
// (see `latency` below), so it is kept to what a person actually sings.
export const TRACK_MIN_HZ = 80 // E2
export const TRACK_MAX_HZ = 800 // G5

// Power of two so the ring buffers can be indexed with a mask.
const RING = 8192
const MASK = RING - 1

// How often the period is re-measured, in samples. ~5ms at 48k: fast enough to
// follow a slide, slow enough that the O(n^2) correlation is not running on
// every 128-sample render quantum.
const ESTIMATE_HOP = 256

// Correlation is done on a 4x decimated copy first, then refined at full rate.
// Straight NSDF over a 1400-sample window every 5ms does not fit in a worklet's
// budget; decimating cuts it by 16 and the refinement puts the precision back.
const DECIM = 4

// Below this the correlation peak is not a sung note, it is a consonant or the
// room. Grains cut from unvoiced audio and re-laid at a different spacing sound
// like a broken fan, so the output is gated instead.
const VOICED_CLARITY = 0.55

// The gate opens and closes over this many seconds. Long enough not to click,
// short enough that the harmony still starts on the consonant of a word.
const GATE_TIME = 0.012

// A harmony louder than this against the singer's own voice stops sounding like
// a second singer and starts sounding like an effect.
const MAX_GRAIN_GAIN = 2.0

/** Normalised square difference over `buf`, for every lag up to `maxLag`. */
function nsdf(buf, n, maxLag, out) {
  for (let lag = 0; lag <= maxLag; lag += 1) {
    let ac = 0
    let energy = 0
    for (let i = 0; i + lag < n; i += 1) {
      const a = buf[i]
      const b = buf[i + lag]
      ac += a * b
      energy += a * a + b * b
    }
    out[lag] = energy > 0 ? (2 * ac) / energy : 0
  }
}

/**
 * The lag of the true fundamental, or -1.
 *
 * Takes the EARLIEST peak within 90% of the best one, not the best outright —
 * the same rule as pitch.js, and for the same reason: the octave above always
 * produces a peak of its own, and when it edges ahead the shifter would harmonise
 * from a period half as long, putting the second voice an octave out while the
 * clarity figure still looked perfect.
 */
function pickLag(curve, minLag, maxLag) {
  let i = 1
  while (i < maxLag && curve[i] > 0) i += 1 // step off the zero-lag hump
  const peaks = []
  let best = -1
  while (i < maxLag) {
    if (curve[i] <= 0) { i += 1; continue }
    let at = i
    while (i < maxLag && curve[i] > 0) {
      if (curve[i] > curve[at]) at = i
      i += 1
    }
    if (at >= minLag) {
      peaks.push(at)
      if (best < 0 || curve[at] > curve[best]) best = at
    }
  }
  if (best < 0) return -1
  const cutoff = curve[best] * 0.9
  for (const p of peaks) if (curve[p] >= cutoff) return p
  return best
}

export class HarmonyVoice {
  constructor(sampleRate, { minHz = TRACK_MIN_HZ, maxHz = TRACK_MAX_HZ } = {}) {
    this.sr = sampleRate
    this.maxLag = Math.ceil(sampleRate / minHz)
    this.minLag = Math.max(2, Math.floor(sampleRate / maxHz))

    this.in = new Float32Array(RING)
    this.out = new Float32Array(RING)

    // The delay between hearing a sample and being allowed to emit it.
    //
    // A grain reaches half a period past its own pitch mark, and marks are only
    // laid down where the input is complete — so the newest usable mark sits a
    // period behind the write head, and the grain built from it another period
    // behind that. Two periods of the LOWEST trackable note is therefore the
    // floor, and lowering minHz raises this directly: at 80Hz it is 28ms, which
    // is about how far away a singer standing next to you already is.
    this.fillAhead = this.maxLag + 256
    this.latency = this.maxLag + this.fillAhead
    this.writePos = this.latency
    this.readPos = 0

    // Period tracking.
    this.window = new Float32Array(2 * this.maxLag + 256)
    this.decim = new Float32Array(Math.ceil(this.window.length / DECIM))
    this.curveD = new Float32Array(Math.ceil(this.maxLag / DECIM) + 2)
    this.sinceEstimate = ESTIMATE_HOP
    this.period = 0
    this.clarity = 0
    this.voiced = false
    this.gate = 1.5e-4 // RMS below which nothing is happening; the host may reset it

    // Analysis pitch marks: absolute sample positions of the glottal pulses.
    this.marks = new Float64Array(64)
    this.markCount = 0
    this.lastMark = 0

    this.voices = [] // [{ ratio, synthMark }]
    this.level = 1
    this.envelope = 0
  }

  get hz() {
    return this.period > 0 ? this.sr / this.period : -1
  }

  /**
   * The intervals to sing, as frequency ratios. Changing them mid-note is fine
   * and is the normal case — the synthesis marks simply start advancing at a
   * new spacing from wherever they are.
   */
  setRatios(ratios) {
    const next = []
    for (let i = 0; i < ratios.length; i += 1) {
      const ratio = ratios[i]
      if (!(ratio > 0.2 && ratio < 5)) continue
      next.push({ ratio, synthMark: this.voices[i]?.synthMark ?? 0 })
    }
    this.voices = next
  }

  setLevel(level) {
    this.level = level
  }

  /** RMS below which the input counts as silence. Learned by the caller. */
  setGate(gate) {
    if (gate > 0) this.gate = gate
  }

  /** Re-measure the period over the newest audio. */
  estimate() {
    const W = this.window.length
    const base = this.writePos - W
    let rms = 0
    for (let i = 0; i < W; i += 1) {
      const v = this.in[(base + i) & MASK]
      this.window[i] = v
      rms += v * v
    }
    rms = Math.sqrt(rms / W)
    if (rms < this.gate) {
      this.voiced = false
      this.clarity = 0
      return
    }

    // Box-average down by DECIM. Crude as a filter, but the correlation only
    // needs the periodicity to survive, and this is the cheapest thing that
    // stops the top octave aliasing into it.
    const n = Math.floor(W / DECIM)
    for (let i = 0; i < n; i += 1) {
      let s = 0
      for (let j = 0; j < DECIM; j += 1) s += this.window[i * DECIM + j]
      this.decim[i] = s / DECIM
    }
    const maxLagD = Math.min(n - 2, Math.ceil(this.maxLag / DECIM))
    const minLagD = Math.max(2, Math.floor(this.minLag / DECIM))
    nsdf(this.decim, n, maxLagD, this.curveD)
    const coarse = pickLag(this.curveD, minLagD, maxLagD)
    if (coarse < 0) {
      this.voiced = false
      this.clarity = 0
      return
    }

    // Refine at full rate. The coarse lag is only accurate to DECIM samples,
    // and DECIM samples at a 200-sample period is 35 cents — audible as a
    // harmony that sits slightly sour against the voice it came from.
    const lo = Math.max(this.minLag, coarse * DECIM - DECIM)
    const hi = Math.min(this.maxLag, coarse * DECIM + DECIM)
    let bestLag = -1
    let bestVal = -2
    const vals = new Float32Array(hi - lo + 1)
    for (let lag = lo; lag <= hi; lag += 1) {
      let ac = 0
      let energy = 0
      for (let i = 0; i + lag < W; i += 1) {
        const a = this.window[i]
        const b = this.window[i + lag]
        ac += a * b
        energy += a * a + b * b
      }
      const v = energy > 0 ? (2 * ac) / energy : 0
      vals[lag - lo] = v
      if (v > bestVal) { bestVal = v; bestLag = lag }
    }
    if (bestLag < 0 || bestVal < VOICED_CLARITY) {
      this.voiced = false
      this.clarity = Math.max(0, bestVal)
      return
    }

    // Parabolic interpolation for a fractional period. Without it the harmony
    // quantises to the sample grid and drifts sharp or flat by a few cents as
    // the note moves.
    let period = bestLag
    const k = bestLag - lo
    if (k > 0 && k < vals.length - 1) {
      const a = (vals[k - 1] + vals[k + 1] - 2 * vals[k]) / 2
      const b = (vals[k + 1] - vals[k - 1]) / 2
      if (a !== 0) period = bestLag - b / (2 * a)
    }
    this.period = period
    this.clarity = Math.min(1, bestVal)
    this.voiced = true
  }

  /**
   * Lay down pitch marks up to wherever the input is complete.
   *
   * Each mark is put on the loudest sample near where the period says the next
   * glottal pulse should be. Marks placed blindly every P samples also "work",
   * but they cut grains at an arbitrary phase, and overlapping grains that
   * disagree about phase cancel each other — the harmony comes out thin and
   * hollow. Snapping to the pulse is what makes it sound like a voice.
   */
  extendMarks() {
    const P = this.period
    if (!(P > 0)) return
    const limit = this.writePos - this.maxLag
    // After silence (or at startup) the mark can be arbitrarily far behind;
    // walking it forward one period at a time would spin for thousands of
    // iterations, so it is simply moved up to the front.
    if (this.lastMark < limit - 4 * this.maxLag) this.lastMark = limit - this.maxLag
    const half = Math.max(1, Math.round(P * 0.25))
    while (this.lastMark + P <= limit) {
      const center = Math.round(this.lastMark + P)
      let at = center
      if (this.voiced) {
        let best = -1
        for (let n = center - half; n <= center + half; n += 1) {
          const v = Math.abs(this.in[n & MASK])
          if (v > best) { best = v; at = n }
        }
      }
      this.lastMark = at
      this.marks[this.markCount % this.marks.length] = at
      this.markCount += 1
    }
  }

  /** The analysis mark nearest a given output position. */
  nearestMark(pos) {
    const kept = Math.min(this.markCount, this.marks.length)
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < kept; i += 1) {
      const m = this.marks[(this.markCount - 1 - i) % this.marks.length]
      const d = Math.abs(m - pos)
      if (d < bestD) { bestD = d; best = m }
      else if (m < pos - bestD) break // marks walk backwards; no closer one left
    }
    return best
  }

  /** One grain: a Hann-windowed period, cut at `mark`, laid down at `at`. */
  placeGrain(at, gain) {
    const half = Math.max(2, Math.round(this.period))
    const len = 2 * half
    const mark = this.nearestMark(at)
    const start = Math.round(at) - half
    const from = Math.round(mark) - half
    const step = (2 * Math.PI) / len
    for (let i = 0; i < len; i += 1) {
      const w = 0.5 - 0.5 * Math.cos(step * i)
      this.out[(start + i) & MASK] += this.in[(from + i) & MASK] * w * gain
    }
  }

  /**
   * One render quantum. `input` may be null (no microphone connected yet);
   * `output` is filled with the harmony alone — the caller mixes it against the
   * dry voice, or not, as they like.
   */
  process(input, output) {
    const L = output.length

    for (let i = 0; i < L; i += 1) {
      this.in[(this.writePos + i) & MASK] = input ? input[i] : 0
    }
    this.writePos += L

    this.sinceEstimate += L
    if (this.sinceEstimate >= ESTIMATE_HOP) {
      this.sinceEstimate = 0
      this.estimate()
    }
    this.extendMarks()

    const emitPos = this.readPos
    if (this.voiced && this.period > 0 && this.markCount > 0 && this.voices.length) {
      // Grains from more than one voice sum, so each is backed off to keep the
      // stack at roughly the level of a single line.
      const spread = 1 / Math.sqrt(this.voices.length)
      for (const v of this.voices) {
        // Hann grains hopped by P sum to one; hopped by P/ratio they sum to
        // `ratio`, so the gain undoes it. Every voice then arrives at the level
        // of the voice it was cut from, whichever direction it moved.
        const gain = Math.min(MAX_GRAIN_GAIN, 1 / v.ratio) * spread
        const hop = this.period / v.ratio
        // Guarantees the next grain starts at or after the block being emitted,
        // and re-anchors a voice that fell behind during silence.
        if (v.synthMark < emitPos + this.maxLag) v.synthMark = emitPos + this.maxLag
        while (v.synthMark < emitPos + this.fillAhead) {
          this.placeGrain(v.synthMark, gain)
          v.synthMark += hop
        }
      }
    }

    const target = this.voiced && this.voices.length ? this.level : 0
    const k = 1 - Math.exp(-1 / (GATE_TIME * this.sr))
    for (let i = 0; i < L; i += 1) {
      const idx = (emitPos + i) & MASK
      const v = this.out[idx]
      this.out[idx] = 0 // consumed; the ring is an accumulator
      this.envelope += (target - this.envelope) * k
      const s = v * this.envelope
      output[i] = s > 1 ? 1 : s < -1 ? -1 : s
    }
    this.readPos += L
  }
}

// -----------------------------------------------------------------------------
// AudioWorklet wrapper. Only defined inside a worklet — see the header.
// -----------------------------------------------------------------------------
/* global AudioWorkletProcessor, registerProcessor, sampleRate */
if (typeof registerProcessor === 'function' && typeof AudioWorkletProcessor === 'function') {
  class HarmonyVoiceProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.voice = new HarmonyVoice(sampleRate, options?.processorOptions ?? {})
      this.silence = new Float32Array(128)
      this.sinceReport = 0
      this.port.onmessage = ({ data }) => {
        if (data.ratios) this.voice.setRatios(data.ratios)
        if (data.level != null) this.voice.setLevel(data.level)
        if (data.gate != null) this.voice.setGate(data.gate)
      }
    }

    process(inputs, outputs) {
      const out = outputs[0]
      if (!out?.length) return true
      let mic = inputs[0]?.[0]
      if (!mic || mic.length !== out[0].length) {
        if (this.silence.length !== out[0].length) this.silence = new Float32Array(out[0].length)
        mic = this.silence
      }
      this.voice.process(mic, out[0])
      for (let c = 1; c < out.length; c += 1) out[c].set(out[0])

      // What she is hearing, sent back for the display and for the key tracker.
      // The worklet's own estimate is the one the shifter is acting on, so the
      // number on screen can never disagree with the harmony you hear.
      this.sinceReport += out[0].length
      if (this.sinceReport >= sampleRate * 0.05) {
        this.sinceReport = 0
        this.port.postMessage({
          hz: this.voice.hz,
          clarity: this.voice.clarity,
          voiced: this.voice.voiced,
        })
      }
      return true
    }
  }

  registerProcessor(PROCESSOR_NAME, HarmonyVoiceProcessor)
}
