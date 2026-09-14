// =============================================================================
// A small synth for hearing a generated progression.
// =============================================================================
// harmonyPlayer.js plays the recorded SATB takes, which is exactly the wrong
// tool here: these chords did not exist until a moment ago, so there is nothing
// to play back and something has to make the sound.
//
// It is deliberately plain — a triangle for the tune, three quiet sines for the
// chord, one lowpass over everything. A better instrument would be a
// distraction: the question being asked on screen is "is this the right chord",
// and a rich patch makes a wrong chord sound better, which is the one thing the
// sound must not do.
//
// Everything is scheduled up front rather than driven from a timer. A tune is a
// few dozen notes, Web Audio's clock is sample-accurate and JavaScript's is
// not, and a progression that drifts against its own melody would look like a
// harmony error rather than a timing one.

import { hzFromMidi } from './pitch.js'

/**
 * One note: an oscillator, an envelope, and a promise to clean itself up.
 *
 * The attack and release are not decoration. A gain that steps from 0 to 1
 * clicks, and with twelve bars of block chords the clicks arrive on every
 * downbeat — which sounds exactly like a percussion track nobody asked for.
 */
function voice(ctx, dest, hz, at, seconds, { type = 'sine', gain = 0.2, attack = 0.012 } = {}) {
  const release = Math.min(0.18, seconds * 0.5)
  const osc = ctx.createOscillator()
  osc.type = type
  osc.frequency.value = hz

  const env = ctx.createGain()
  env.gain.setValueAtTime(0, at)
  env.gain.linearRampToValueAtTime(gain, at + attack)
  env.gain.setValueAtTime(gain, at + Math.max(attack, seconds - release))
  env.gain.linearRampToValueAtTime(0, at + seconds)

  osc.connect(env).connect(dest)
  osc.start(at)
  osc.stop(at + seconds + 0.02)
  return osc
}

export class ChordSynth {
  constructor(ctx) {
    this.ctx = ctx
    this.voices = []
    this.startedAt = 0
    this.secondsPerBeat = 0.5
    this.totalBeats = 0
    this.playing = false

    // One filter for the whole instrument. Sine and triangle are already close
    // to harmonically bare; this is here to take the edge off the triangle's
    // upper partials so a long melody is not tiring to listen to.
    this.filter = ctx.createBiquadFilter()
    this.filter.type = 'lowpass'
    this.filter.frequency.value = 2600
    this.out = ctx.createGain()
    this.out.gain.value = 1
    this.filter.connect(this.out).connect(ctx.destination)
  }

  /** Where the playhead is, in beats. Beyond the end once it has finished. */
  get beat() {
    if (!this.playing) return 0
    return (this.ctx.currentTime - this.startedAt) / this.secondsPerBeat
  }

  /**
   * @param melody  [{ midi, beats }] — played as the tune.
   * @param chords  [{ startBeat, beats, midi:[..] }] — played underneath it.
   * @param parts   which of the two to sound; hearing the chords alone is the
   *                quickest way to judge a progression, and hearing the melody
   *                alone is how you check the tune was typed correctly.
   */
  play(melody, chords, { bpm = 100, onEnded, parts = { melody: true, chords: true } } = {}) {
    this.stop()
    const spb = 60 / bpm
    const at0 = this.ctx.currentTime + 0.12 // enough lead to schedule everything
    this.secondsPerBeat = spb
    this.startedAt = at0
    this.playing = true

    let beats
    if (parts.melody) {
      let at = 0
      for (const note of melody) {
        const len = note.beats ?? 1
        if (note.midi != null) {
          this.voices.push(
            voice(this.ctx, this.filter, hzFromMidi(note.midi), at0 + at * spb, len * spb * 0.92, {
              type: 'triangle',
              gain: 0.2,
            }),
          )
        }
        at += len
      }
      beats = at
    } else {
      beats = melody.reduce((s, n) => s + (n.beats ?? 1), 0)
    }

    if (parts.chords) {
      for (const chord of chords) {
        for (const midi of chord.midi) {
          this.voices.push(
            voice(
              this.ctx,
              this.filter,
              hzFromMidi(midi),
              at0 + chord.startBeat * spb,
              chord.beats * spb * 0.94,
              // Quiet, and quieter still per note because three of them sound
              // at once — the chord is accompaniment and should sit under the
              // tune, not argue with it.
              { type: 'sine', gain: 0.085, attack: 0.03 },
            ),
          )
        }
        beats = Math.max(beats, chord.startBeat + chord.beats)
      }
    }

    this.totalBeats = beats
    const last = this.voices[this.voices.length - 1]
    if (last) {
      last.onended = () => {
        if (!this.playing) return
        this.playing = false
        onEnded?.()
      }
    } else {
      this.playing = false
      onEnded?.()
    }
  }

  /** A single chord, for clicking a bar to hear what is under it. */
  strike(midi, { seconds = 1.1, gain = 0.1 } = {}) {
    const at = this.ctx.currentTime + 0.02
    for (const m of midi) {
      voice(this.ctx, this.filter, hzFromMidi(m), at, seconds, { type: 'sine', gain, attack: 0.02 })
    }
  }

  stop() {
    // Silence the bus before killing the oscillators. Stopping a dozen voices
    // mid-cycle is a loud click, and this is a button people will press often.
    const t = this.ctx.currentTime
    this.out.gain.cancelScheduledValues(t)
    this.out.gain.setValueAtTime(this.out.gain.value, t)
    this.out.gain.linearRampToValueAtTime(0, t + 0.03)
    for (const osc of this.voices) {
      try {
        osc.onended = null
        osc.stop(t + 0.04)
      } catch {
        // Already stopped — Web Audio throws rather than shrugging.
      }
    }
    this.voices = []
    this.playing = false
    this.out.gain.setValueAtTime(0, t + 0.04)
    this.out.gain.linearRampToValueAtTime(1, t + 0.08)
  }
}
