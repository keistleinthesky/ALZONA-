// Unit tests for the microphone hand-back phrase.
//   node src/wake.test.mjs      (run from the dycinovus folder)
//
// This one is worth testing hard in both directions. Too loose and an ordinary
// question ends the harmony mid-song; too tight and the singer is stuck with no
// way back to Q&A except the mouse.

import { isHandBackPhrase } from './wake.js'

let failures = 0

function want(text, expected) {
  const got = isHandBackPhrase(text)
  const ok = got === expected
  if (!ok) failures += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${(expected ? 'hands back' : 'keeps singing').padEnd(14)} ` +
      `${JSON.stringify(text)}`,
  )
}

console.log('\n-- gives the microphone back --')
for (const t of [
  'Alzona',
  'alzona',
  '  Alzona.  ',
  'Okay Alzona',
  'Alzona, stop',
  'Alzona stop',
  'okay alzona, that is enough',   // "that is" is punctuationless filler -> see below
  'Salamat Alzona',
  'Thank you Alzona',
  'Alzona tapos na',
  'Hey Alzona',
  'Arizona',                        // the commonest mishearing of her name
  'al zona',
  'アルゾナ',
  '알조나',
  '阿尔佐纳',
]) want(t, true)

console.log('\n-- and these are questions, not a hand-back --')
for (const t of [
  'Alzona what is the national anthem',
  'Alzona, sing with me again',
  'Alzona harmonize with me in tenor',
  'stop',                           // an ordinary word — could easily be sung
  'salamat',                        // no name: not a hand-back
  'Alzona who wrote Lupang Hinirang',
  'bayang magiliw',                 // a lyric
  '',
  '   ',
  'tell Alzona to stop',            // has content beyond the name
]) want(t, false)

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n')
process.exit(failures ? 1 : 0)
