// Offline test of the live harmony shifter.
//   node src/harmonyVoice.test.mjs      (run from the dycinovus folder)
//
// The shifter runs entirely on numbers, so it can be driven here exactly as the
// AudioWorklet drives it — 128 samples at a time — over a synthetic vowel, and
// the result measured with the same detector the app uses. That matters more
// than usual for this one: a pitch shifter that is wrong still produces
// confident, voice-like audio, so the only way to know it is right is to ask
// what note came out.

import { HarmonyVoice } from './harmonyVoice.js'
import { detectPitch } from './pitch.js'

const SR = 48000
const BLOCK = 128
let failures = 0

function check(name, actual, expected, tolerance) {
  const ok = Math.abs(actual - expected) <= tolerance
  if (!ok) failures += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} got ${actual.toFixed(2).padStart(9)}  ` +
      `want ${expected.toFixed(2)} (±${tolerance})`,
  )
}

function ok(name, condition, detail = '') {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} ${detail}`)
}

/**
 * A sung vowel: a glottal pulse train shaped by two formants.
 *
 * Phase-aligned harmonics on purpose — that is what a real glottal pulse is,
 * and it is what gives the tracker a pulse to snap its marks to. A sine would
 * pass a pitch test while telling us nothing about whether grains are being cut
 * in the right place.
 */
function vowel(seconds, f0, sr = SR) {
  const n = Math.round(seconds * sr)
  const buf = new Float32Array(n)
  const formants = [700, 1220, 2600]
  const amps = []
  for (let k = 1; k * f0 < sr / 2 && k <= 40; k += 1) {
    const f = k * f0
    let a = 1 / k // glottal roll-off
    let res = 0
    for (const F of formants) res += 1 / (1 + Math.pow((f - F) / 140, 2))
    amps.push(a * (0.25 + res))
  }
  let peak = 0
  for (let i = 0; i < n; i += 1) {
    let s = 0
    for (let k = 0; k < amps.length; k += 1) {
      s += amps[k] * Math.cos((2 * Math.PI * (k + 1) * f0 * i) / sr)
    }
    buf[i] = s
    if (Math.abs(s) > peak) peak = Math.abs(s)
  }
  for (let i = 0; i < n; i += 1) buf[i] = (buf[i] / peak) * 0.35
  return buf
}

/** Run a signal through the shifter and return everything it produced. */
function shift(signal, ratios, sr = SR) {
  const voice = new HarmonyVoice(sr)
  voice.setRatios(ratios)
  const out = new Float32Array(signal.length)
  const block = new Float32Array(BLOCK)
  for (let i = 0; i + BLOCK <= signal.length; i += BLOCK) {
    voice.process(signal.subarray(i, i + BLOCK), block)
    out.set(block, i)
  }
  return { out, voice }
}

const rms = (buf) => {
  let s = 0
  for (let i = 0; i < buf.length; i += 1) s += buf[i] * buf[i]
  return Math.sqrt(s / buf.length)
}

/** Goertzel: how much of one exact frequency is in a buffer. */
function toneEnergy(buf, hz, sr = SR) {
  const w = (2 * Math.PI * hz) / sr
  const coeff = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < buf.length; i += 1) {
    const s0 = buf[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / buf.length
}

// ---------------------------------------------------------------------------
console.log('\n-- the shifter finds the note it is shifting --')
{
  const { voice } = shift(vowel(0.5, 220), [1])
  check('tracked pitch of a 220Hz vowel', voice.hz, 220, 2)
  ok('and calls it voiced', voice.voiced, `clarity ${voice.clarity.toFixed(3)}`)
}
{
  const { voice } = shift(vowel(0.5, 392), [1])
  check('tracked pitch of a 392Hz vowel (G4)', voice.hz, 392, 4)
}
{
  const { voice } = shift(vowel(0.5, 110), [1])
  check('tracked pitch of a 110Hz vowel (A2)', voice.hz, 110, 2)
}

// ---------------------------------------------------------------------------
console.log('\n-- and puts the second voice where it was told --')
for (const [name, semitones] of [
  ['minor third below', -3],
  ['major third below', -4],
  ['fifth below', -7],
  ['octave below', -12],
  ['major third above', 4],
  ['fifth above', 7],
]) {
  const f0 = 220
  const ratio = Math.pow(2, semitones / 12)
  const { out } = shift(vowel(0.8, f0), [ratio])
  // Measure the tail: the first few blocks are the pipeline filling up.
  const tail = out.subarray(out.length - 4096, out.length - 2048)
  const { hz, clarity } = detectPitch(tail, SR, 1e-5)
  check(`${name} (${semitones})`, hz, f0 * ratio, Math.max(2, f0 * ratio * 0.012))
  ok(`  ${name} still sounds like a voice`, clarity > 0.8, `clarity ${clarity.toFixed(3)}`)
}

// ---------------------------------------------------------------------------
console.log('\n-- it keeps the level of the voice it came from --')
{
  const dry = vowel(0.8, 220)
  const level = rms(dry.subarray(dry.length - 4096, dry.length - 2048))
  for (const semitones of [-4, -12, 5]) {
    const { out } = shift(dry, [Math.pow(2, semitones / 12)])
    const wet = rms(out.subarray(out.length - 4096, out.length - 2048))
    const ratio = wet / level
    ok(
      `  ${semitones > 0 ? '+' : ''}${semitones} semitones within 6dB of dry`,
      ratio > 0.5 && ratio < 2,
      `${(20 * Math.log10(ratio)).toFixed(1)} dB`,
    )
  }
}

// ---------------------------------------------------------------------------
console.log('\n-- two harmony lines at once --')
{
  const f0 = 262
  const { out } = shift(vowel(1.5, f0), [Math.pow(2, -3 / 12), Math.pow(2, -7 / 12)])
  // A long window on purpose: two lines a fourth apart are only 45Hz apart, so
  // a 2048-sample look cannot tell them from the gap between them.
  const tail = out.subarray(out.length - 24576, out.length - 8192)
  ok('a third and a fifth below produce audio', rms(tail) > 0.02, `rms ${rms(tail).toFixed(3)}`)
  // detectPitch is no use here, and that is not a fault: two notes at once are a
  // chord, and autocorrelation answers with one period or none. So the two
  // fundamentals are looked for one at a time, against frequencies that belong
  // to neither line.
  const third = f0 * Math.pow(2, -3 / 12)
  const fifth = f0 * Math.pow(2, -7 / 12)
  const floorEnergy = Math.max(toneEnergy(tail, 300), toneEnergy(tail, 205))
  ok(
    `  the third below (${third.toFixed(1)}Hz) is there`,
    toneEnergy(tail, third) > floorEnergy * 8,
    `${(toneEnergy(tail, third) / floorEnergy).toFixed(0)}x the off-note floor`,
  )
  ok(
    `  the fifth below (${fifth.toFixed(1)}Hz) is there too`,
    toneEnergy(tail, fifth) > floorEnergy * 8,
    `${(toneEnergy(tail, fifth) / floorEnergy).toFixed(0)}x the off-note floor`,
  )
  // The note that was SUNG must not survive into the harmony bus, or the mix
  // doubles the melody and the harmony sounds like chorus rather than a part.
  ok(
    `  and the sung note (${f0}Hz) is not`,
    toneEnergy(tail, f0) < floorEnergy * 4,
    `${(toneEnergy(tail, f0) / floorEnergy).toFixed(1)}x the off-note floor`,
  )
}

// ---------------------------------------------------------------------------
console.log('\n-- and stays quiet when nobody is singing --')
{
  const noise = new Float32Array(SR * 0.5)
  for (let i = 0; i < noise.length; i += 1) noise[i] = (Math.random() * 2 - 1) * 0.1
  const { out } = shift(noise, [Math.pow(2, -4 / 12)])
  const tail = out.subarray(out.length - 4096)
  ok('white noise produces near-silence', rms(tail) < 0.005, `rms ${rms(tail).toFixed(5)}`)
}
{
  const silence = new Float32Array(SR * 0.3)
  const { out } = shift(silence, [Math.pow(2, -4 / 12)])
  ok('silence produces silence', rms(out) === 0, `rms ${rms(out)}`)
}

// ---------------------------------------------------------------------------
console.log('\n-- the delay it adds --')
{
  const voice = new HarmonyVoice(SR)
  const ms = (voice.latency / SR) * 1000
  ok('under 35ms end to end', ms < 35, `${ms.toFixed(1)} ms`)
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n')
process.exit(failures ? 1 : 0)
