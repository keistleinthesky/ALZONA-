// =============================================================================
// whenQuiet — nothing of hers should start while she is still talking.
// =============================================================================
//   node src/whenQuiet.test.mjs      (run from the dycinovus folder)
//
// A command is acknowledged out loud before the harmony begins. Starting the
// moment the directive arrives put the reference note and the count-in
// underneath her own reply, both sounding at once.

import { markSpeaking, hearingSelf, resetSelfVoice, whenQuiet } from './selfVoice.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0

const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

// ---- it waits while she is speaking ----------------------------------------
{
  resetSelfVoice()
  markSpeaking(400)                  // she is talking for 400ms
  let ranAt = null
  const t0 = Date.now()
  whenQuiet(() => { ranAt = Date.now() - t0 }, { pollMs: 20 })
  await sleep(200)
  check('holds off while she is still talking', ranAt === null,
        ranAt === null ? '' : `ran after ${ranAt}ms`)
  await sleep(400)
  check('starts once she stops', ranAt !== null && ranAt >= 380,
        ranAt === null ? 'never ran' : `ran after ${ranAt}ms`)
}

// ---- a sentence that keeps going keeps it waiting ---------------------------
{
  resetSelfVoice()
  let ran = false
  whenQuiet(() => { ran = true }, { pollMs: 20 })
  // Pushed forward repeatedly, the way playback marks the window as it plays.
  for (let i = 0; i < 8; i += 1) { markSpeaking(150); await sleep(50) }
  check('a continuing reply keeps it waiting', !ran)
  await sleep(250)
  check('and it starts when that reply ends', ran)
}

// ---- silence means start, without a needless delay --------------------------
{
  resetSelfVoice()
  let ranAt = null
  const t0 = Date.now()
  whenQuiet(() => { ranAt = Date.now() - t0 }, { pollMs: 20 })
  await sleep(120)
  check('starts promptly when she is not talking', ranAt !== null && ranAt < 100,
        ranAt === null ? 'never ran' : `ran after ${ranAt}ms`)
}

// ---- a reply that never reports finishing must not strand it ----------------
{
  resetSelfVoice()
  let ran = false
  whenQuiet(() => { ran = true }, { pollMs: 20, maxWaitMs: 200 })
  // Marked far into the future and never cleared — a stalled element, or a tab
  // that lost focus mid-clip. Without the cap this would wait for ever.
  markSpeaking(60000)
  await sleep(400)
  check('gives up waiting rather than never starting', ran)
  check('and the window itself is still open', hearingSelf())
}

// ---- cancelling actually cancels --------------------------------------------
{
  resetSelfVoice()
  let ran = false
  const cancel = whenQuiet(() => { ran = true }, { pollMs: 20 })
  cancel()
  await sleep(150)
  check('a cancelled wait never runs', !ran)
}

resetSelfVoice()
if (failures) {
  console.log(`\n${failures} failure(s).`)
  process.exit(1)
}
console.log('\nAll whenQuiet tests passed.')
