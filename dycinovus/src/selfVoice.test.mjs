// Unit tests for the self-hearing window.
//   node src/selfVoice.test.mjs      (run from the dycinovus folder)
//
// Two failures matter here and they pull in opposite directions. If the window
// is too small she answers her own replies for as long as anyone lets her. If
// it can ever get stuck open she stops hearing people altogether — which is
// the worse of the two, and the one that actually happened. So the last test
// is the important one: the window must lapse on its own.

import {
  markSpeaking, hearingSelf, resetSelfVoice, TAIL_MS,
} from './selfVoice.js'

let failures = 0

function check(name, got, want) {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (got ${got}, want ${want})`}`)
}

// She has not spoken. Everything the microphone hears is a person, and she has
// to act on it — this is the case that was broken.
resetSelfVoice()
check('silent: a clip now is the singer', hearingSelf(performance.now()), false)

// While she is speaking, a clip recorded now is her.
resetSelfVoice()
markSpeaking(1000)
check('speaking: a clip now is hers', hearingSelf(performance.now()), true)

// The start of the clip decides, not the end. A clip that began while she was
// talking is hers even though the room is quiet by the time it is judged.
resetSelfVoice()
const spokeAt = performance.now()
markSpeaking(1000)
check('a clip that began during her reply is hers', hearingSelf(spokeAt), true)

// Far enough past the tail, the microphone is the singer's again.
resetSelfVoice()
markSpeaking(1000)
check('after the window: the singer again', hearingSelf(performance.now() + 2000), false)

// Repeated marks extend the window; they must never cut it short. The audio
// loop fires this constantly with the default tail while a longer one is open.
resetSelfVoice()
markSpeaking(5000)
markSpeaking(10)
check('a short mark cannot shorten a long window', hearingSelf(performance.now() + 3000), true)

// The one that matters. Nothing clears this window: it expires. However
// playback ends — properly, or by stalling, or by the module being swapped out
// underneath it — she is listening again a tail later.
resetSelfVoice()
markSpeaking()
check('window lapses on its own', hearingSelf(performance.now() + TAIL_MS + 1), false)

console.log(failures === 0 ? '\nall passed' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
