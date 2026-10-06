import { useCallback, useEffect, useRef, useState } from 'react'
import { NoiseFloor, detectPitch, midiFromHz } from '../src/pitch'
import { framesToNotes, identifyPart, counterpart, describePosition } from '../src/scoreMatch'
import { lyricWindow } from '../src/lyricsMatch'
import { HarmonyPlayer, SINGER_PARTS, loadHarmony } from '../src/harmonyPlayer'
import { openLiveMic, SILENT_RMS } from '../src/liveMic'
import HarmonyChart from '../src/HarmonyChart'
import { PART_COLORS, USER_COLOR } from '../src/partColors'

// =============================================================================
// SING BACK — you sing a part, she sings the other one.
// =============================================================================
// You start singing Lupang Hinirang. She works out from the PITCH which of the
// two sung lines you are on and where in the song you are, narrows that down
// with the WORDS you are singing, and then plays the recording of the other
// part against you. Start on the soprano and you get the alto; start on the
// alto and you get the soprano.
//
// She plays the real recorded take, not a harmony invented from your voice.
// That is the point: Lupang Hinirang has written parts, and a generated
// interval is not the alto line however well it is chosen.
//
// The recordings are served at /media/harmony by the dev server itself (see
// vite.harmonizer.config.js), so this runs with no backend at all. The one
// thing that does need the backend is hearing the WORDS — a supporting signal,
// and without it the matching runs on pitch alone and says so on screen.

// Stop singing for this long and the recording waits for you. Above a normal
// breath (~0.5s) so ordinary phrasing does not pause it.
const SILENCE_PAUSE = 1.2
// This much continuous silence ends the take.
const SILENCE_END = 10
// How much sung history to keep for matching. Long enough for a phrase, short
// enough that a stray sound ages out instead of poisoning every later attempt.
const CONTOUR_MEMORY = 12
// Enough distinct notes to be worth testing against the score.
const MIN_NOTES = 4
// A lyric hint that has not produced a match by now was the wrong hint, and
// keeping it would block matching for good.
const LYRIC_TIMEOUT = 5000
// Length of the clip sent for word recognition.
const CLIP_MS = 4000

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const nameOf = (m) => (m == null ? '—'
  : `${NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`)
const titled = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '—')

/** The note a recorded part is on at this playhead, transposed to the singer. */
function noteAt(contours, part, playhead, leadIn, semis) {
  const notes = contours?.[part]?.notes
  if (!notes) return null
  for (const n of notes) {
    const start = n.t - leadIn
    if (playhead >= start && playhead < start + n.d) return n.midi + semis
  }
  return null
}

/** Record one clip and resolve with it, or null if the recorder refused. */
function recordClip(stream, ms) {
  return new Promise((resolve) => {
    let rec
    try {
      rec = new MediaRecorder(stream, { mimeType: 'audio/webm' })
    } catch { resolve(null); return }
    const chunks = []
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    rec.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm' }))
    rec.onerror = () => resolve(null)
    rec.start()
    setTimeout(() => { if (rec.state !== 'inactive') rec.stop() }, ms)
  })
}

export default function Harmonizer() {
  const [on, setOn] = useState(false)
  const [status, setStatus] = useState('Press start and sing Lupang Hinirang.')
  const [yourPart, setYourPart] = useState(null)
  const [herPart, setHerPart] = useState(null)
  const [where, setWhere] = useState(null)
  const [lyric, setLyric] = useState(null)
  const [lyricsUp, setLyricsUp] = useState(null)   // null = not tried yet
  const [holding, setHolding] = useState(false)
  // Bumped when she comes in. The chart's time axis is wall-clock until then
  // and song time afterwards, and remounting is the honest way to drop the
  // history drawn against the old clock rather than let it sit there skewed.
  const [epoch, setEpoch] = useState(0)
  // Deliberately NOT throttled: the chart's time axis has to advance smoothly,
  // and everything else on screen is cheap text.
  const [live, setLive] = useState({ userMidi: null, herMidi: null, playhead: 0 })
  // The score, once fetched. In state and not just the cache ref because
  // the chart renders from it, and a ref read during render is invisible to
  // React — the grid would stay empty until something else forced a repaint.
  const [score, setScore] = useState({ contours: null, leadIn: 0 })
  // What she is hearing, on screen.
  //
  // "She is not harmonising with me" has at least four different causes —
  // no signal, signal below the gate, pitch but no steady notes, notes but
  // no match — and from the outside they look identical: nothing happens.
  // The console needed a 5,757-line log file to tell them apart. This is
  // the same information, in the room, while it is happening.
  const [meter, setMeter] = useState(
    { rms: 0, gate: 0, hz: 0, clarity: 0, notes: 0, distinct: 0, fps: 0 })

  const ctxRef = useRef(null)
  const streamRef = useRef(null)
  const analyserRef = useRef(null)
  const bufRef = useRef(null)
  const floorRef = useRef(null)
  // A TIMER, not requestAnimationFrame.
  //
  // rAF only fires while the page is actually being painted. Hidden behind
  // another window, on a tab you have clicked away from, or in a pane the
  // compositor has parked, it stops dead — and with it the listening, the
  // matching and the following, silently, mid-song. Caught exactly that
  // way: zero rAF callbacks in a second and a half while a timer ticked 30
  // times on the same page. Watching the singer is not a drawing job and
  // must not be scheduled like one. The chart still draws on rAF, which is
  // right — there is no point painting a frame nobody sees.
  const loopRef = useRef(null)
  const playerRef = useRef(null)
  const cacheRef = useRef({})
  const framesRef = useRef([])       // [{t, hz}] recent pitch history
  const matchRef = useRef(null)
  const herPartRef = useRef(null)
  const lyricRef = useRef(null)
  const lyricAtRef = useRef(0)
  const startedAtRef = useRef(0)
  const lastVoicedRef = useRef(0)
  const sangRef = useRef(false)
  const holdingRef = useRef(false)
  const meterAtRef = useRef(0)
  // How fast the loop is really going. A starved loop is the one fault with
  // no symptom of its own: the level is fine, the pitch is fine, and notes
  // simply never form because the frames are too far apart to join up.
  // Worth a number on screen rather than another afternoon of guessing.
  const fpsRef = useRef({ count: 0, at: 0 })

  const teardown = useCallback(() => {
    if (loopRef.current) clearInterval(loopRef.current)
    loopRef.current = null
    playerRef.current?.stop()
    playerRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    analyserRef.current = null
    const ctx = ctxRef.current
    ctxRef.current = null
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {})
    framesRef.current = []
    matchRef.current = null
    herPartRef.current = null
    lyricRef.current = null
    sangRef.current = false
    holdingRef.current = false
    setOn(false)
    setYourPart(null)
    setHerPart(null)
    setWhere(null)
    setLyric(null)
    setHolding(false)
    setLive({ userMidi: null, herMidi: null, playhead: 0 })
    // The score itself is left in place: it is the same song next time, and
    // re-decoding four MP3s to start again is a two-second stare at nothing.
  }, [])

  /**
   * Send clips of singing for word recognition, until she has come in.
   *
   * A supporting signal only. Knowing you are somewhere around "Alab ng puso"
   * turns matching from a search of the whole song into a search of a few
   * seconds of it, which is the difference between locking on within a phrase
   * and never quite locking on. If the backend is not running this simply
   * never succeeds and pitch does the whole job.
   */
  const listenForWords = useCallback(async (stream) => {
    if (typeof MediaRecorder === 'undefined') { setLyricsUp(false); return }
    // A loop rather than a function that calls itself again at the end: the
    // recursive shape is the one that leaks recorders when the take stops.
    while (ctxRef.current && !matchRef.current) {
      const clip = await recordClip(stream, CLIP_MS)
      if (!clip || !ctxRef.current || matchRef.current) return
      try {
        const fd = new FormData()
        fd.append('file', clip, 'clip.webm')
        const data = await fetch('/listen', { method: 'POST', body: fd })
          .then((r) => r.json())
        setLyricsUp(true)
        const lines = cacheRef.current.lyrics?.lines
        if (data?.index != null && lines?.[data.index] && !matchRef.current) {
          lyricRef.current = lyricWindow({ line: lines[data.index] })
          lyricAtRef.current = performance.now()
          setLyric(lines[data.index].text)
        }
      } catch {
        // Backend down, or it could not make out the words. Neither is fatal:
        // pitch alone finds the singer, just more slowly.
        setLyricsUp(false)
        return
      }
    }
  }, [])

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('The browser will not give this page a microphone. Open it on '
        + 'http://localhost, or over https — on a plain http network address '
        + 'the microphone is blocked before we are even asked.')
      return
    }
    setStatus('Opening the microphone…')
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      const ctx = new Ctx()
      ctxRef.current = ctx
      if (ctx.state === 'suspended') await ctx.resume()

      // Both sung lines, because she has to be able to answer either one.
      setStatus('Loading the recordings…')
      const loaded = await loadHarmony('', ctx, SINGER_PARTS, cacheRef.current)
      Object.assign(cacheRef.current, loaded)
      if (!cacheRef.current.lyrics) {
        cacheRef.current.lyrics = await fetch('/media/harmony/lyrics.json')
          .then((r) => r.json()).catch(() => null)
      }
      const { manifest } = loaded
      const leadIn = manifest.lead_in ?? 0
      setScore({ contours: loaded.contours, leadIn })

      const mic = await openLiveMic(ctx)
      streamRef.current = mic.stream
      if (mic.peak <= SILENT_RMS) {
        setStatus(`"${mic.label}" is delivering silence — check it is not muted `
          + 'in Windows, then try again.')
        teardown()
        return
      }
      const source = ctx.createMediaStreamSource(mic.stream)
      const an = ctx.createAnalyser()
      an.fftSize = 2048
      source.connect(an)
      analyserRef.current = an
      bufRef.current = new Float32Array(an.fftSize)
      floorRef.current = new NoiseFloor()

      playerRef.current = new HarmonyPlayer(ctx, manifest, loaded.buffers, {
        onEnded: () => { setStatus('That is the end of the song.'); teardown() },
      })

      startedAtRef.current = ctx.currentTime
      lastVoicedRef.current = ctx.currentTime
      setOn(true)
      setStatus('Listening — start singing.')
      listenForWords(mic.stream)

      const tick = () => {
        const ctxNow = ctx.currentTime
        const nowMs = performance.now()
        const buf = bufRef.current
        an.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i]
        const rms = Math.sqrt(sum / buf.length)
        const gate = floorRef.current.update(rms)
        const { hz, clarity } = detectPitch(buf, ctx.sampleRate, gate)
        const player = playerRef.current
        const semis = matchRef.current?.semitoneOffset ?? 0

        // What she is singing this instant, read straight off the contour of
        // the part being played rather than analysed back off the speakers.
        const herMidi = player?.playing && herPartRef.current
          ? noteAt(cacheRef.current.contours, herPartRef.current,
                   player.playhead, leadIn, semis)
          : null

        // Without headphones the microphone hears her too, and her line is
        // steady and sustained — exactly what the tracking is looking for.
        // Left unchecked she locks onto herself and follows her own recording.
        const selfHeard = hz > 0 && herMidi != null
          && Math.abs(midiFromHz(hz) - herMidi) < 0.35
        const voiced = hz > 0 && !selfHeard

        if (voiced) {
          lastVoicedRef.current = ctxNow
          sangRef.current = true
          framesRef.current.push({ t: ctxNow - startedAtRef.current, hz })
          const cutoff = (ctxNow - startedAtRef.current) - CONTOUR_MEMORY
          while (framesRef.current.length && framesRef.current[0].t < cutoff) {
            framesRef.current.shift()
          }
        }

        // ---- find the singer, then come in ---------------------------------
        if (player && !matchRef.current) {
          if (lyricRef.current && nowMs - lyricAtRef.current > LYRIC_TIMEOUT) {
            lyricRef.current = null
            setLyric(null)
          }
          const sung = framesToNotes(framesRef.current)
          diag.notes = sung.length
          diag.midis = sung.map((n) => n.midi)
          if (sung.length >= MIN_NOTES) {
            const opts = lyricRef.current ? { window: lyricRef.current } : {}
            let found = null
            // Where the MATCHED window began, on the singer's own clock.
            // Not the same thing as where their singing began, and the
            // difference is the whole bug below.
            let windowStart = 0
            // Try a few window lengths: matching against everything means one
            // stray sound poisons the sequence permanently.
            for (const take of [10, 14, 20, 8]) {
              const recent = sung.slice(-take)
              if (recent.length < MIN_NOTES) continue
              const got = identifyPart(recent, cacheRef.current.contours, SINGER_PARTS, opts)
              if (got) { found = got; windowStart = recent[0].start; break }
            }
            if (found) {
              matchRef.current = found.match
              const hers = counterpart(found.part, SINGER_PARTS)
              herPartRef.current = hers
              setYourPart(found.part)
              setHerPart(hers)
              setEpoch((e) => e + 1)
              // Where they are NOW: where the match said they were, plus the
              // time that has passed since.
              //
              // Measured from the start of the MATCHED WINDOW, not the start
              // of everything sung. `match.time` is the score position of
              // the window's first note, so pairing it with the whole
              // buffer's start double-counts every note that was dropped
              // off the front — and the ladder drops plenty. Measured: 1.4
              // to 2.1s too far ahead for a soprano, and 3.4 to 4.5s for an
              // alto, who needs more notes and so loses a longer prefix.
              // Four seconds into this anthem is a whole phrase: she came in
              // confidently, in time, singing a different line of the song.
              const elapsed = (ctxNow - startedAtRef.current) - windowStart
              player.offset = leadIn + Math.max(0, found.match.time + elapsed)
              player.start([hers], {
                detuneCents: Math.round((found.match.semitoneOffset || 0) * 100),
              })
              setStatus(`You are on the ${found.part}. Singing the ${hers} with you.`)
            }
          }
        }

        // ---- follow: wait when they pause, carry on when they do ------------
        if (player && matchRef.current) {
          const quiet = ctxNow - lastVoicedRef.current
          if (player.playing && sangRef.current && quiet > SILENCE_PAUSE) {
            player.hold()
            holdingRef.current = true
            setHolding(true)
          } else if (!player.playing && holdingRef.current && voiced) {
            player.resume()
            holdingRef.current = false
            setHolding(false)
          }
          if (sangRef.current && quiet > SILENCE_END) {
            setStatus('You stopped, so I did too.')
            teardown()
            return
          }
          setWhere(describePosition(matchRef.current,
            cacheRef.current.manifest?.phrase_boundaries ?? []))
        }

        fpsRef.current.count += 1
        if (nowMs - meterAtRef.current > 120) {
          const f = fpsRef.current
          const fps = f.at ? (f.count * 1000) / (nowMs - f.at) : 0
          fpsRef.current = { count: 0, at: nowMs }
          meterAtRef.current = nowMs
          const heard = framesToNotes(framesRef.current)
          setMeter({
            rms, gate, hz, clarity,
            notes: heard.length,
            distinct: new Set(heard.map((n) => n.midi)).size,
            fps,
          })
        }

        setLive({
          userMidi: voiced ? midiFromHz(hz) : null,
          herMidi,
          playhead: player?.playing
            ? player.playhead
            : ctxNow - startedAtRef.current,
        })

        // Live diagnostics. The console's version of this feature was debugged
        // through a 5,757-line log file for exactly this reason: when it does
        // not come in, the only useful question is what it was hearing, and
        // that is invisible from the outside. Cheap, and worth keeping.
        diag.frames += 1
        diag.hz = hz
        diag.gate = gate
        diag.voiced = voiced
        diag.kept = framesRef.current.length
        diag.matched = !!matchRef.current
        window.__singback = diag

      }
      const diag = { frames: 0, hz: 0, gate: 0, voiced: false, kept: 0, notes: 0, matched: false }
      window.__singback = diag
      // ~60Hz. The detector needs a 2048-sample window anyway, so going
      // faster buys nothing but CPU.
      loopRef.current = setInterval(tick, 16)
    } catch (err) {
      console.error('sing back failed to start:', err)
      setStatus(err?.name === 'NotAllowedError'
        ? 'The microphone was refused. Allow it for this page and try again.'
        : `Could not start: ${err?.message || err}`)
      teardown()
    }
  }, [teardown, listenForWords])

  useEffect(() => () => teardown(), [teardown])

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-5 px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.2em] text-emerald-400/70">
            ALZONA · Lupang Hinirang
          </div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-white">
            Sing back
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <Badge label="You" part={yourPart} note={nameOf(live.userMidi)}
                 colour={USER_COLOR} />
          <div className="text-xl text-white/25">→</div>
          <Badge label="She sings" part={herPart} note={nameOf(live.herMidi)}
                 colour={herPart ? PART_COLORS[herPart] : null} />
        </div>
      </header>

      <div className="h-[420px] w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
        <HarmonyChart
          key={epoch}
          userMidi={live.userMidi}
          parts={herPart ? [herPart] : []}
          contours={score.contours}
          playhead={live.playhead}
          running={on}
          leadIn={score.leadIn}
        />
      </div>

      {on && <Hearing m={meter} matched={!!yourPart} />}

      <div className="flex flex-wrap items-center gap-5">
        <button
          type="button"
          onClick={on ? teardown : start}
          className={`rounded-2xl px-7 py-3.5 text-base font-semibold text-white shadow-lg transition
            ${on ? 'bg-rose-500 shadow-rose-500/20 hover:bg-rose-400'
                 : 'bg-emerald-500 shadow-emerald-500/20 hover:bg-emerald-400'}`}
        >
          {on ? 'Stop' : 'Start singing'}
        </button>

        <div className="min-w-0 flex-1">
          <p className={`text-sm ${holding ? 'text-amber-300' : 'text-white/70'}`}>
            {holding ? 'Waiting for you…' : status}
          </p>
          <p className="mt-1 text-xs text-white/35">
            {where && <span className="text-white/50">{where}</span>}
            {where && lyric && ' · '}
            {lyric && <span className="italic">“{lyric}”</span>}
            {lyricsUp === false && !lyric
              && 'Matching on pitch alone — the backend is not running, so the '
               + 'words are not being heard.'}
          </p>
        </div>
      </div>

      <footer className="text-[11px] leading-relaxed text-white/25">
        Use headphones. Through speakers the microphone hears the recording as
        well as you — she ignores her own line, but your pitch gets harder to read.
      </footer>
    </main>
  )
}

/**
 * What she is hearing, said plainly.
 *
 * Ordered as the signal actually flows — is there sound, is it above the gate,
 * is it a pitch, is it enough notes — so the first thing that is wrong is the
 * first thing you read. NOTES is the one that matters most while waiting: the
 * soprano line takes about a dozen before the score can be placed and the alto
 * about twice that, and without a number on screen a singer has no way to tell
 * "still listening" from "broken".
 */
function Hearing({ m, matched }) {
  const live = m.rms > m.gate
  const cell = 'rounded-lg bg-white/5 px-3 py-1.5'
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-white/50">
      <div className={cell}>
        <span className="text-white/35">mic </span>
        <span className={live ? 'text-emerald-300' : 'text-white/40'}>
          {m.rms.toFixed(3)}
        </span>
        <span className="text-white/25"> / gate {m.gate.toFixed(3)}</span>
      </div>
      <div className={cell}>
        <span className="text-white/35">pitch </span>
        <span className={m.hz > 0 ? 'text-emerald-300' : 'text-white/40'}>
          {m.hz > 0 ? `${Math.round(m.hz)}Hz` : '—'}
        </span>
        <span className="text-white/25"> clarity {m.clarity.toFixed(2)}</span>
      </div>
      <div className={cell}>
        <span className="text-white/35">loop </span>
        <span className={m.fps > 25 ? 'text-emerald-300' : 'text-amber-300'}>
          {Math.round(m.fps)}/s
        </span>
      </div>
      <div className={cell}>
        <span className="text-white/35">notes </span>
        <span className="text-white">{m.notes}</span>
        <span className="text-white/25"> ({m.distinct} distinct)</span>
      </div>
      {!matched && (
        <div className="text-white/30">
          {m.fps > 0 && m.fps < 15 ? 'the loop is being starved — notes cannot form this slowly'
            : m.rms <= m.gate ? 'nothing reaching the microphone'
            : m.hz <= 0 ? 'sound, but no clear pitch in it'
            : m.notes < 12 ? `keep singing — about ${Math.max(1, 12 - m.notes)} more notes`
            : 'enough notes; still looking for the phrase in the score'}
        </div>
      )}
    </div>
  )
}

function Badge({ label, part, note, colour }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-2">
      <div className="text-[10px] uppercase tracking-widest text-white/35">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="text-lg font-medium"
              style={{ color: part ? colour : 'rgba(255,255,255,0.35)' }}>
          {titled(part)}
        </span>
        <span className="font-mono text-sm text-white/45">{note}</span>
      </div>
    </div>
  )
}
