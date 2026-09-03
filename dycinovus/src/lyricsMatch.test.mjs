// Tests for placing the singer by their words.
//   node src/lyricsMatch.test.mjs
//
// Recognition on SINGING is unreliable, so these deliberately include
// mishearings and partial lines. The property that matters is never
// confidently returning the WRONG line: a miss costs a moment, a wrong hint
// sends the harmony to the wrong bar.

import fs from 'node:fs'
import { matchLyric, scoreLine, normalise } from './lyricsMatch.js'

const { lines } = JSON.parse(
  fs.readFileSync(
    'C:/Users/Win11/OneDrive/Documents/Desktop/shs_pro/source/harmony/lyrics.json',
    'utf8',
  ),
)
let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail}`)
}
const find = (heard) => matchLyric(heard, lines)

console.log(`\n${lines.length} lyric lines\n`)

console.log('--- clean recognition ---')
for (const [heard, want] of [
  ['bayang magiliw', 0],
  ['perlas ng silanganan', 1],
  ['alab ng puso', 2],
  ['lupang hinirang', 4],
  ['duyan ka ng magiting', 5],
  ['sa dagat at bundok', 8],
  ['tagumpay na nagniningning', 13],
]) {
  const m = find(heard)
  check(`"${heard}"`, m?.index === want,
    m ? `-> line ${m.index} @ ${m.line.t}s` : '-> no match')
}

console.log('\n--- as recognition mangles singing ---')
for (const [heard, want, note] of [
  ['bayan magiliw', 0, 'dropped g'],
  ['perlas nang silanganan', 1, 'ng -> nang'],
  ['sa dibdib moy buhay', 3, 'apostrophe lost'],
  ['duyan ka ng magiting po', 5, 'extra word'],
  ['kailan pa may di magdidilim', 15, 'elisions flattened'],
  ['ang bituin at araw', 14, 'line cut short'],
]) {
  const m = find(heard)
  check(`"${heard}" (${note})`, m?.index === want,
    m ? `-> line ${m.index}` : '-> no match')
}

console.log('\n--- must NOT guess ---')
for (const heard of ['sa', 'ang ng sa at', 'hello alzona how are you', '']) {
  const m = find(heard)
  check(`"${heard}" -> null`, m === null, m ? `-> wrongly matched ${m.index}` : '')
}

console.log('\n--- weak words alone are not evidence ---')
{
  const saLines = lines.filter((l) => normalise(l.text).startsWith('sa ')).length
  check(`"sa" opens ${saLines} lines, so alone it is ambiguous`, find('sa') === null)
  check('"sa manlulupig" resolves', find('sa manlulupig')?.index === 6)
}

console.log('\n--- scoring behaves sensibly ---')
{
  const exact = scoreLine('bayang magiliw', 'Bayang magiliw')
  const partial = scoreLine('bayang', 'Bayang magiliw')
  const none = scoreLine('tagumpay', 'Bayang magiliw')
  check('exact scores 1', Math.abs(exact - 1) < 0.01, `-> ${exact.toFixed(2)}`)
  check('partial in between', partial > 0.2 && partial < 1, `-> ${partial.toFixed(2)}`)
  check('unrelated scores 0', none === 0)
}

console.log(
  failures === 0 ? '\nAll lyric-matching tests passed.\n' : `\n${failures} test(s) FAILED.\n`,
)
process.exit(failures === 0 ? 0 : 1)
