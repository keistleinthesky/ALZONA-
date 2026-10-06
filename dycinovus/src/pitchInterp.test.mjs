// =============================================================================
// Regression: the parabolic interpolation must never invent a period.
// =============================================================================
// The peak search is bounded to lags a voice can produce, so BEFORE the
// sub-sample correction the period is always inside the singing range by
// construction. Only the correction can move it out, and unguarded it did.
//
// The mechanism, because it is not obvious. For a genuine interior maximum the
// vertex of a parabola through the three points is provably within half a
// sample of it: writing d1 = x2-x1 and d3 = x2-x3, both >= 0, the shift works
// out as (d1-d3) / 2(d1+d3), and |d1-d3| <= d1+d3. So the correction is
// self-bounding -- as long as the point really is a maximum.
//
// `peaks` did not guarantee that. Each entry is the largest value in a RUN of
// positive correlation, and a run gets clipped at the end of the searched lags,
// so on a signal whose true period lies beyond that limit the chosen point sits
// on a rising slope. Then d3 < 0, the bound above collapses, and b/(2a) runs
// away with the curvature near zero.
//
// The signals that do this are the ones with strong energy BELOW the 65Hz
// floor, which is to say every real microphone in a real room: mains hum (60Hz
// here, just under the floor), desk thumps, and handling rumble. That is why it
// never showed up against clean synthetic tones and never showed up in the
// other tests in this directory.
//
// static/sing_debug.log is full of the consequence -- frames reading
//   why=range raw=-3662     why=range raw=1462     why=range raw=-6459
// A negative frequency is not a poor guess at a pitch; it is arithmetic that
// ran away, and each of those frames was a note actually being sung.
//
// The invariant under test is therefore containment, not accuracy: whatever
// this detector reports, accepted or refused, must be a period it could
// plausibly have measured.

import { detectPitch } from './pitch.js'

const SR = 44100
const N = 2048
const MIN_HZ = 65
const MAX_HZ = 1200
// The clamp lets the vertex sit up to half a sample outside the searched lags,
// which at the top of the range is a couple of per cent. Nothing legitimate
// lives beyond this margin.
const LOW = MIN_HZ / 1.1
const HIGH = MAX_HZ * 1.1

const tone = (b, hz, amp, phase = 0) => {
  for (let i = 0; i < b.length; i += 1) b[i] += amp * Math.sin(2 * Math.PI * hz * (i / SR) + phase)
  return b
}
const buf = () => new Float32Array(N)

// Deterministic, so a failure is reproducible rather than one run in twenty.
let seed = 987654321
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const hiss = (b, amp) => {
  let last = 0
  for (let i = 0; i < b.length; i += 1) {
    last = last * 0.85 + (rnd() * 2 - 1) * amp
    b[i] += last
  }
  return b
}

// Every one of these has its dominant period LONGER than the longest lag the
// detector searches (1/65Hz), which is the condition that breaks the bound.
const shapes = {
  '60Hz mains hum, alone': () => tone(buf(), 60, 0.15),
  '60Hz mains hum under a sung G4': () => tone(tone(buf(), 60, 0.15), 392, 0.08),
  '50Hz hum under a sung E4': () => tone(tone(buf(), 50, 0.18), 330, 0.09),
  '40Hz desk rumble under a sung D4': () => tone(tone(buf(), 40, 0.20), 294, 0.10),
  '25Hz handling thump under a voice': () => tone(tone(buf(), 25, 0.30), 220, 0.10),
  'rumble and breath, no note at all': () => hiss(tone(buf(), 45, 0.22), 0.03),
  'hum, voice and breath together': () => hiss(tone(tone(buf(), 60, 0.14), 349, 0.09), 0.02),
}

let failures = 0
let checked = 0

for (const [label, make] of Object.entries(shapes)) {
  const r = detectPitch(make(), SR, 1e-5)
  // `raw` is the candidate the detector refused, `hz` the one it accepted.
  // Both come out of the same division, so both must be contained.
  const reported = r.hz > 0 ? r.hz : r.raw
  const ok = reported == null || (reported > LOW && reported < HIGH)
  if (reported != null) checked += 1
  if (!ok) failures += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(36)} `
    + (reported == null
      ? 'no candidate (gated/unpitched)'
      : `${reported > 0 ? ' ' : ''}${reported.toFixed(1)}Hz  why=${r.why}`),
  )
}

console.log(`\n${checked} candidate period(s) checked.`)

if (failures) {
  console.log(`${failures} shape(s) produced an impossible period.`)
  process.exit(1)
}
console.log('All interpolation-containment tests passed.')
