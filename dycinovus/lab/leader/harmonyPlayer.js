// =============================================================================
// Playback engine for the recorded SATB harmony parts.
// =============================================================================
// The recordings are fixed audio, so the engine's job is to keep them lined up
// with a live singer: start on the right downbeat, hold at a phrase boundary if
// the singer is sustaining, and stop cleanly when they finish.
//
// Deliberately NOT a real-time time-stretcher. Stretching voice on the fly
// sounds watery and is the least reliable thing to put in front of judges;
// waiting at the rests covers the common case (holding the last note of a
// phrase) with far less that can go wrong.

// Each song has its own folder under source/harmony. Lupang Hinirang's dir is
// the empty string: its files sit directly in source/harmony, where the
// consoles on 5173 and 5174 still read them from, and moving them would break
// those.
const MEDIA = (baseUrl, dir, file) =>
  `${baseUrl}/media/harmony/${dir ? dir + '/' : ''}${file}`

// Ask the server whether these files have changed instead of assuming they
// have not. A recording gets replaced far more often than its name does -
// a part re-sung, a take trimmed to line up with another - and the browser
// happily serves the copy it fetched the first time, for days. The lyrics
// hit this and were fixed; the audio and the manifest were not, so a new
// take could be on disk, served correctly, and still never reach the page.
//
// 'no-cache' revalidates rather than refetching: the browser asks, and the
// server answers 304 when nothing changed, so an unchanged take costs a
// round trip rather than a megabyte.
const FRESH = { cache: 'no-cache' }

export const PARTS = ['soprano', 'alto', 'tenor', 'bass']

/** Load the manifest + contours + the audio for the requested parts. */
export async function loadHarmony(baseUrl, ctx, parts, cache = {}, dir = '') {
  // A cache belongs to one song. Reusing another song's manifest would play
  // this song's audio against the wrong lead-in and the wrong phrase ends.
  if (cache.dir !== undefined && cache.dir !== dir) cache = { dir }

  const manifest =
    cache.manifest ??
    (await fetch(MEDIA(baseUrl, dir, 'manifest.json'), FRESH).then((r) => r.json()))
  const contours =
    cache.contours ??
    (await fetch(MEDIA(baseUrl, dir, 'contours.json'), FRESH).then((r) => r.json()))

  const buffers = { ...(cache.buffers ?? {}) }
  await Promise.all(
    parts
      .filter((p) => !buffers[p])
      .map(async (p) => {
        const info = manifest.parts[p]
        if (!info) return
        const raw = await fetch(MEDIA(baseUrl, dir, info.file), FRESH)
          .then((r) => r.arrayBuffer())
        buffers[p] = await ctx.decodeAudioData(raw)
      }),
  )
  return { manifest, contours, buffers, dir }
}

/**
 * Plays one or more parts together, keeping them sample-aligned with each other.
 *
 * The takes share a lead-in, so every part is started at the same offset and
 * they stay in sync for free — no per-part scheduling needed.
 */
export class HarmonyPlayer {
  constructor(ctx, manifest, buffers, { onEnded } = {}) {
    this.ctx = ctx
    this.manifest = manifest
    this.buffers = buffers
    this.onEnded = onEnded
    this.sources = []
    this.gain = ctx.createGain()
    this.gain.connect(ctx.destination)
    this.parts = []
    this.offset = manifest.lead_in // where in the file we currently are
    this.startedAt = 0 // ctx.currentTime when the current run began
    this.playing = false
    this.stopAt = null // absolute offset in the file to stop at
    this.detuneCents = 0
  }

  /** Position within the recording, in seconds from the first sung note. */
  get playhead() {
    if (!this.playing) return this.offset - this.manifest.lead_in
    return this.offset + (this.ctx.currentTime - this.startedAt) - this.manifest.lead_in
  }

  start(parts, { detuneCents = 0, stopAfter = null } = {}) {
    this.stopSources()
    this.parts = parts.filter((p) => this.buffers[p])
    this.detuneCents = detuneCents
    if (stopAfter != null) this.stopAt = this.manifest.lead_in + stopAfter
    const now = this.ctx.currentTime + 0.06 // small lead so all parts start together
    this.startedAt = now
    this.playing = true

    for (const p of this.parts) {
      const src = this.ctx.createBufferSource()
      src.buffer = this.buffers[p]
      // detune resamples, so it shifts tempo too — only ever used for small
      // corrections (< ~60 cents), where the tempo error is under 0.4%.
      if (detuneCents) src.detune.value = detuneCents
      const g = this.ctx.createGain()
      // Blend down slightly when several parts sound at once, so the ensemble
      // does not clip and the singer can still hear themselves.
      g.gain.value = 1 / Math.max(1, Math.sqrt(this.parts.length))
      src.connect(g).connect(this.gain)
      // stopAt was being set and then ignored, so a song asked to finish
      // early played to the end of the file regardless. The third argument
      // is how much of the buffer to play, which ends every part on the
      // same sample rather than fading them out one at a time.
      if (this.stopAt != null) {
        src.start(now, this.offset, Math.max(0, this.stopAt - this.offset))
      } else {
        src.start(now, this.offset)
      }
      this.sources.push(src)
    }

    if (this.sources.length) {
      this.sources[0].onended = () => {
        if (this.playing) this.onEnded?.()
      }
    }
  }

  /**
   * Freeze at the current position and wait.
   *
   * Used both when the singer sustains past a phrase end and when they stop
   * altogether — in each case the recording should wait for them rather than
   * carry on alone. Cutting the nodes dead would click, so the gain is dropped
   * over a few milliseconds first; the position is captured BEFORE the fade so
   * resuming picks up exactly where the music was.
   */
  hold() {
    if (!this.playing) return
    this.offset += this.ctx.currentTime - this.startedAt
    this.playing = false
    this.gain.gain.cancelScheduledValues(this.ctx.currentTime)
    this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.012)
    const dying = this.sources
    this.sources = []
    setTimeout(() => {
      for (const s of dying) {
        try {
          s.onended = null
          s.stop()
        } catch {
          /* already stopped */
        }
      }
    }, 60)
  }

  /** Resume from where hold() left off, fading back in to avoid a click. */
  resume() {
    if (this.playing) return
    this.gain.gain.cancelScheduledValues(this.ctx.currentTime)
    this.gain.gain.value = 0
    this.start(this.parts, { detuneCents: this.detuneCents })
    this.gain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.02)
  }

  setVolume(v, ramp = 0.05) {
    this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, ramp)
  }

  fadeOutAndStop(seconds = 0.5) {
    if (!this.playing) return
    this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, seconds / 3)
    setTimeout(() => this.stop(), seconds * 1000)
  }

  stop() {
    this.stopSources()
    this.playing = false
    this.offset = this.manifest.lead_in
    this.gain.gain.cancelScheduledValues(this.ctx.currentTime)
    this.gain.gain.value = 1
  }

  stopSources() {
    for (const s of this.sources) {
      try {
        s.onended = null
        s.stop()
      } catch {
        /* already stopped */
      }
    }
    this.sources = []
  }
}

/**
 * Sound a single reference pitch so the singer can tune to the RECORDING.
 *
 * This matters: the takes sit ~21 cents below concert pitch, so a singer who
 * pitches off a piano would beat against them. Giving them the recording's own
 * starting note removes the problem entirely.
 */
export function soundReference(ctx, hz, seconds = 1.6) {
  const real = new Float32Array([0, 1, 0.4, 0.22, 0.12])
  const osc = ctx.createOscillator()
  osc.setPeriodicWave(ctx.createPeriodicWave(real, new Float32Array(real.length)))
  osc.frequency.value = hz
  const g = ctx.createGain()
  g.gain.value = 0
  osc.connect(g).connect(ctx.destination)
  const t = ctx.currentTime
  g.gain.linearRampToValueAtTime(0.25, t + 0.04)
  g.gain.setValueAtTime(0.25, t + seconds - 0.25)
  g.gain.linearRampToValueAtTime(0.0001, t + seconds)
  osc.start(t)
  osc.stop(t + seconds + 0.05)
  return seconds
}

/** Four clicks at the recording's tempo, so you both come in on the same beat. */
export function countIn(ctx, bpm, beats = 4, startAt = null) {
  const spb = 60 / bpm
  const t0 = startAt ?? ctx.currentTime + 0.05
  for (let i = 0; i < beats; i += 1) {
    const t = t0 + i * spb
    const osc = ctx.createOscillator()
    osc.type = 'square'
    // Accent beat 1 so the downbeat is unmistakable.
    osc.frequency.value = i === 0 ? 1400 : 950
    const g = ctx.createGain()
    g.gain.value = 0
    osc.connect(g).connect(ctx.destination)
    g.gain.linearRampToValueAtTime(i === 0 ? 0.3 : 0.18, t + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09)
    osc.start(t)
    osc.stop(t + 0.12)
  }
  return { endsAt: t0 + beats * spb, secondsPerBeat: spb }
}
