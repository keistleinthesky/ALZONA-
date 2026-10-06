// =============================================================================
// Wiring: microphone -> shifter -> speakers, with the brain steering.
// =============================================================================
// Everything hard lives in the two modules this one glues together —
// harmonyVoice.js makes the second voice, harmonyBrain.js decides what note it
// should be. This file exists so Sing.jsx does not have to know that either of
// them is an AudioWorklet.
//
// The loop is deliberately closed through the worklet rather than through the
// analyser in Sing.jsx: the worklet reports the pitch IT is tracking, on the
// signal IT is shifting, so the interval can never be computed from a different
// note than the one being harmonised.

import workletUrl from './harmonyVoice.js?url'
import { PROCESSOR_NAME } from './harmonyVoice'
import { HarmonyBrain } from './harmonyBrain'
import { hearingSelf } from './selfVoice'

// addModule is per-context and throws nothing useful when repeated, so contexts
// that already have it are remembered rather than re-registered.
const registered = new WeakSet()

export class LiveHarmony {
  static async attach(ctx, source, options = {}) {
    if (!ctx.audioWorklet) {
      throw new Error('This browser cannot run live harmony (no AudioWorklet).')
    }
    if (!registered.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl)
      registered.add(ctx)
    }
    return new LiveHarmony(ctx, source, options)
  }

  constructor(ctx, source, { plan = 'auto', level = 0.85, gate, onUpdate } = {}) {
    this.ctx = ctx
    this.source = source
    this.onUpdate = onUpdate
    this.brain = new HarmonyBrain({ plan })

    this.node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    this.gain = ctx.createGain()
    // Only the HARMONY reaches the speakers. The singer already hears their own
    // voice through the air; playing it back would be a monitor mix, and a
    // monitor mix delayed by 30ms is the one thing guaranteed to put a singer
    // off their note.
    source.connect(this.node)
    this.node.connect(this.gain).connect(ctx.destination)

    this.node.port.postMessage({ level, ...(gate ? { gate } : {}) })
    this.node.port.onmessage = ({ data }) => this.heard(data)
  }

  /** A pitch report from the worklet, every ~50ms. */
  heard({ hz, clarity, voiced }) {
    // Her own reply, coming back in through the same open microphone. Shifting
    // that would harmonise her with herself, in a key taken from her speaking
    // voice — so the ratios go away and the gate closes on its own.
    //
    // Note this asks about HER SPEECH only. The live harmony never marks the
    // window itself: it is playing continuously while you sing, so marking
    // would make her mute her own harmony a frame after starting it.
    const mine = hearingSelf()
    const result = this.brain.update(mine ? -1 : hz, clarity, performance.now())
    this.node.port.postMessage({ ratios: mine ? [] : result.ratios })
    this.onUpdate?.({ ...result, hz, clarity, voiced: voiced && !mine })
  }

  /** Sing a named SATB line — soprano, alto, tenor or bass. */
  setPart(part) {
    this.brain.setPart(part)
  }

  setPlan(plan) {
    this.brain.setPlan(plan)
  }

  setLevel(level) {
    this.node.port.postMessage({ level })
  }

  /** The room's noise floor, as learned by the caller's NoiseFloor. */
  setGate(gate) {
    if (gate > 0) this.node.port.postMessage({ gate })
  }

  stop() {
    this.node.port.onmessage = null
    try { this.source.disconnect(this.node) } catch { /* already apart */ }
    try { this.node.disconnect() } catch { /* already apart */ }
    try { this.gain.disconnect() } catch { /* already apart */ }
  }
}
