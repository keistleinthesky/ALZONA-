// ALZONA's own voice, as the microphones hear it.
//
// The microphone has to stay open the whole time — she has to notice singing
// on her own, and a microphone that is only open when asked cannot do that.
// So the microphone is never the thing that gets switched off; what gets
// ignored is whatever arrives while SHE is the one making the sound.
//
// She makes sound from four places, and a microphone cannot tell any of them
// from a person:
//   - the hidden player in App        (answers routed through the singing panel)
//   - the reply audio in Voice        (its own `new Audio`)
//   - the browser's synthetic voice   (fallback when the backend has no TTS)
//   - the recorded SATB parts         (real human voices, while harmonising)
// Every one of them marks this window, and everything that listens asks.
//
// A deadline, not an "is speaking" flag. A flag has to be cleared by an event,
// and an event that never arrives — a stalled element, a hot reload, a tab
// that lost focus mid-clip — leaves her deaf for good, which is far worse than
// hearing herself. A deadline expires on its own: whoever is making the sound
// keeps pushing it forward while the sound lasts, and when they stop, the
// window lapses and she is listening again.

// How long her voice keeps arriving after the audio itself has stopped: the
// room's echo, plus whatever the microphone buffer is still holding.
export const TAIL_MS = 900

let quietUntil = 0

// ALZONA is making sound right now. Cheap on purpose — callers fire this from
// timeupdate and from per-frame audio loops.
export function markSpeaking(tailMs = TAIL_MS) {
  const until = performance.now() + tailMs
  if (until > quietUntil) quietUntil = until
}

// Was the microphone hearing ALZONA at this moment?
//
// Pass the moment a clip STARTED recording, not the moment it finished. A clip
// that began while she was still talking is hers however quiet the room went
// afterwards, and it is the start that decides.
export function hearingSelf(atMs = performance.now()) {
  return atMs < quietUntil
}

// Keep the window open for as long as this element is playing. timeupdate
// fires several times a second, so playback that dies without ever saying so
// just lets the window lapse.
export function followAudio(el) {
  if (!el) return el
  const mark = () => markSpeaking()
  for (const ev of ['play', 'playing', 'timeupdate', 'ended', 'pause']) {
    el.addEventListener(ev, mark)
  }
  return el
}

// Tests only — forget that she ever spoke.
export function resetSelfVoice() {
  quietUntil = 0
}
