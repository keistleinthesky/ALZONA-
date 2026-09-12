// =============================================================================
// Does calling her by name actually wake her?
// =============================================================================
//   node src/wakePhrase.test.mjs      (run from the dycinovus folder)
//
// The wake phrase used to require a greeting in front of the name, so "Alzona"
// was ignored and only "Hi Alzona" worked. Every line marked LIVE below was
// transcribed from a real microphone while someone was trying to get her
// attention, and every one of them was thrown away.

import { NAME, NAME_CJK } from './wake.js'

const GREET_CJK =
  "(?:こんにちは|こんばんは|おはよう(?:ございます)?|やあ|ねえ|ハロー|ハイ|" +
  "안녕하세요|안녕|여보세요|" +
  "你好|您好|哈喽|哈囉|嗨|早上好|下午好|晚上好)"

const WAKE_RE = new RegExp(
  "\\b(?:(?:hey|hi|hello|heya|yo|greetings|kumusta|kamusta|mabuhay|" +
  "good\\s+(?:morning|afternoon|evening|day)|" +
  "magandang\\s+(?:umaga|hapon|gabi|araw)|okay|ok)[ ,!.]*)?" + NAME + "\\b" +
  "|" + GREET_CJK + "[、。，,!！?？・\\s]*" + NAME_CJK +
  "|" + NAME_CJK,
  "i",
)

let failures = 0
const wakes = (text, want, note = '') => {
  const got = WAKE_RE.test(text)
  const ok = got === want
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${want ? 'wakes ' : 'ignores'}  `
    + `${JSON.stringify(text).padEnd(42)}${note}`)
}

console.log('--- her name alone (all LIVE transcripts) ---')
wakes('Alzona.', true, 'LIVE')
wakes('Elzona. Mama.', true, 'LIVE')
wakes('Alzona. I.', true, 'LIVE')
wakes('Arizona, Arizona. Arizona. Awesome.', true, 'LIVE')
wakes('Alsona', true)
wakes('alona', true)

console.log('\n--- a greeting still works ---')
wakes('Hi Alzona', true)
wakes('Hello, Alzona!', true)
wakes('Kumusta Alzona', true)
wakes('Good morning Alzona', true)
wakes('Magandang umaga Alzona', true)
wakes('okay alzona', true)

console.log('\n--- name plus a command in one breath ---')
wakes('Alzona, who is Jose Rizal?', true)
wakes('Alzona harmonize me in alto', true)
wakes('Hey Alzona, identify this coin', true)

console.log('\n--- other scripts ---')
wakes('こんにちは アルゾナ', true)
wakes('アルゾナ', true, 'name alone, CJK')
wakes('안녕 알조나', true)
wakes('알조나', true, 'name alone, CJK')

console.log('\n--- must NOT wake her ---')
wakes('She does not hear me.', false, 'LIVE')
wakes('So long, so long.', false, 'LIVE')
wakes('When I.', false, 'LIVE')
wakes('Hey, Cortana.', false, 'LIVE')
wakes('', false)
wakes('what is the capital of Croatia', false)
wakes('hello there', false, 'greeting, no name')

// A bare name wakes her but carries no command: she should answer and wait,
// never act. This is what keeps a stray "Arizona" cheap.
console.log('\n--- a bare name leaves nothing to act on ---')
{
  const m = 'Alzona.'.match(WAKE_RE)
  const rest = 'Alzona.'.slice(m.index + m[0].length).replace(/^[\s,.!?]+/, '').trim()
  const ok = rest === ''
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  "Alzona." leaves no command  got ${JSON.stringify(rest)}`)
}
{
  const text = 'Alzona, who is Jose Rizal?'
  const m = text.match(WAKE_RE)
  const rest = text.slice(m.index + m[0].length).replace(/^[\s,.!?]+/, '').trim()
  const ok = rest === 'who is Jose Rizal?'
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  name + question keeps the question  got ${JSON.stringify(rest)}`)
}

if (failures) {
  console.log(`\n${failures} failure(s).`)
  process.exit(1)
}
console.log('\nAll wake-phrase tests passed.')
