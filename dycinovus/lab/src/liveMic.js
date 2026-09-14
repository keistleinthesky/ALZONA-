// =============================================================================
// Opening a microphone that is actually producing audio.
// =============================================================================
// Lifted from Sing.jsx, which learned all of this the hard way on this
// hardware. Kept as its own module so the live-harmony panel does not have to
// import from the anthem panel -- those two exist on diverging branches, and
// the harmony must not break because the other one was restored from an older
// version.
//
// Sing.jsx still carries its own copy on purpose: it is the panel that works
// today and it is deliberately being left untouched. If you fix something here,
// look there too.

// A microphone muted in Windows, or a stale default still pointing at a device
// that has been unplugged, hands the page a perfectly flat zero. Downstream
// that is indistinguishable from "nobody is singing", so the feature dies
// silently and looks broken. This threshold separates digital silence from any
// real signal at all -- room noise with AGC on sits orders of magnitude above
// it, so a quiet singer is never mistaken for a dead device.
export const SILENT_RMS = 0.00002
const PROBE_MS = 700

export const MIC_AUDIO = {
  // Both off deliberately. Echo cancellation treats the harmony coming out of
  // the speakers as an echo and subtracts the very thing we are generating;
  // noise suppression chews up sustained sung vowels, which is the entire
  // signal here.
  echoCancellation: false,
  noiseSuppression: false,
  // Left ON deliberately: without it this hardware delivered an RMS of 0.002
  // for real singing, ten times too quiet to detect at all.
  autoGainControl: true,
}

/**
 * Open a microphone and confirm sound is coming out of it.
 *
 * Tries the Windows default first -- that is the one the user chose -- and only
 * if it proves silent does it walk the other inputs. Returns the level it
 * measured, so the caller can say so plainly when every device is dead rather
 * than sitting there looking like it is listening.
 *
 * @returns {Promise<{stream: MediaStream, peak: number, label: string}>}
 */
export async function openLiveMic(ctx) {
  const probe = async (audio) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio })
    const src = ctx.createMediaStreamSource(stream)
    const an = ctx.createAnalyser()
    an.fftSize = 2048
    src.connect(an)
    const bufr = new Float32Array(an.fftSize)
    let peak = 0
    const until = performance.now() + PROBE_MS
    while (performance.now() < until) {
      await new Promise((r) => setTimeout(r, 50))
      an.getFloatTimeDomainData(bufr)
      let sum = 0
      for (let i = 0; i < bufr.length; i += 1) sum += bufr[i] * bufr[i]
      peak = Math.max(peak, Math.sqrt(sum / bufr.length))
    }
    src.disconnect()
    const track = stream.getAudioTracks()[0]
    return { stream, peak, label: track?.label || 'default microphone' }
  }

  const first = await probe(MIC_AUDIO)
  if (first.peak > SILENT_RMS) return first

  let inputs = []
  try {
    inputs = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default')
  } catch { /* label enumeration can be refused; the default is all we have */ }

  for (const d of inputs) {
    let cand
    try {
      cand = await probe({ ...MIC_AUDIO, deviceId: { exact: d.deviceId } })
    } catch { continue }
    if (cand.peak > SILENT_RMS) {
      first.stream.getTracks().forEach((t) => t.stop())
      return cand
    }
    cand.stream.getTracks().forEach((t) => t.stop())
  }
  return first   // everything is silent; the caller reports it rather than hiding it
}
