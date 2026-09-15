import { useCallback, useEffect, useRef, useState } from 'react'
import { detectPitch, midiFromHz, noteLabel } from '../src/pitch'
import { hearingSelf, whenQuiet } from '../src/selfVoice'
import HarmonyChart, { PART_COLORS } from './HarmonyChart'
import {
  HarmonyPlayer,
  PARTS,
  countIn,
  loadHarmony,
  soundReference,
} from './harmonyPlayer'

// =============================================================================
// LUPANG HINIRANG — recorded SATB harmony, with the English words on screen
// =============================================================================
// One job now. Harmonise plays the real recorded voices: a fixed piece needs
// the actual written parts, and a synth guessing intervals produces parallel
// motion that is musically wrong however accurate the pitch tracking is.
//
// Sing back used to live here too and has been removed from this console. The
// consoles on 5173 and 5174 still have it; they share a different panel.
//
// The English lines are shown as she sings the Filipino ones, so a visitor who
// does not speak Filipino can follow what the anthem is saying. She still
// sings it in Filipino — RA 8491 is about how the anthem is SUNG, and this
// only puts a translation on the screen beside it.
//
// Pitch tracking runs in the browser, so the mic feeds the display and the
// sync logic with no upload round-trip.

// Stop singing for this long and the recording WAITS for you. Set above a
// normal breath (~0.5s) so ordinary phrasing doesn't pause it, but low enough
// that pausing feels immediate when you actually stop.
// How often to check whether she has stopped talking, and how long to keep
// checking. The cap matters: if a reply never reports finishing — a stalled
// element, a tab that lost focus — the harmony must still start rather than
// wait for ever on a sentence that already ended.
const QUIET_POLL_MS = 120
const QUIET_WAIT_MAX_MS = 15000

const SILENCE_PAUSE = 1.2
// Only after this much continuous silence do we call the take finished and
// release the microphone.
const SILENCE_END = 10.0
// A note held this long counts as a sustain worth waiting for at a phrase end.
const SUSTAIN_HOLD = 0.5
// If the count-in finishes and no singing arrives at all, stop rather than
// playing all 72 seconds to an empty room.
const NO_SHOW_STOP = 12.0


// `onActiveChange` is the one addition to this otherwise original panel. Only
// one thing may hold the microphone: Voice.jsx runs speech recognition and
// pauses it while singing is in progress. This panel opens the microphone
// itself, so it has to announce that, or recognition keeps restarting it out of
// the device and neither side hears anything.
/**
 * The original interaction: she sounds the starting note, counts four beats,
 * and begins; the singer comes in with her.
 *
 * Every prop has a default so this mounts in two quite different places. On its
 * own page nothing is passed: baseUrl is empty, so the recordings load from
 * /media/harmony, which that app's dev server serves itself — no backend at
 * all. Inside the full console every prop is supplied, and it behaves exactly
 * as the panel it replaces: armed by a spoken command, handing the microphone
 * back and forth with speech recognition.
 */
export default function Leader({
  baseUrl = '',
  armed = null,
  onClear,
  onActiveChange,
} = {}) {
  const [listening, setListening] = useState(false)
  const [parts, setParts] = useState(['alto'])
  const [pitch, setPitch] = useState({ hz: 0, clarity: 0 })
  const [status, setStatus] = useState('Idle')
  const [playhead, setPlayhead] = useState(0)
  const [holding, setHolding] = useState(false)
  const [manifest, setManifest] = useState(null)
  const [contours, setContours] = useState(null)
  // The English words, and which line of them is being sung right now.
  const [lyrics, setLyrics] = useState(null)
  const [lineIndex, setLineIndex] = useState(-1)

  // Set when a command arrives, cleared the moment it has been acted on.
  const autoStartRef = useRef(false)
  const ctxRef = useRef(null)
  const streamRef = useRef(null)
  const rafRef = useRef(null)
  const bufRef = useRef(null)
  const analyserRef = useRef(null)
  const playerRef = useRef(null)      // recorded harmony
  const cacheRef = useRef({})         // decoded buffers survive restarts
  const startedAtRef = useRef(0)
  const lastVoicedRef = useRef(0)
  // The auto-stop must not arm until the singer has actually sung something.
  // The reference note + count-in take ~4.7s, which is longer than the silence
  // threshold — without this the harmony stops itself the instant it starts.
  const hasSungRef = useRef(false)
  const playbackStartedRef = useRef(0)
  // The rAF loop below is created once per take, so it would capture these as
  // stale values if read from state. Refs keep it reading the live ones.
  const holdingRef = useRef(false)
  const boundsRef = useRef([])
  const sustainRef = useRef({ midi: null, since: 0 })
  const partsRef = useRef(parts)
  // Which lyric line is on screen. Read inside the animation frame, which
  // would otherwise set state sixty times a second to say nothing changed.
  const lineRef = useRef(-1)

  useEffect(() => { partsRef.current = parts }, [parts])

  // A spoken command ("harmonize with me in tenor and bass") arms the panel.
  useEffect(() => {
    if (!armed) return

    // Sing back is gone from this console, so a command asking for it is not
    // quietly turned into a harmony — say what happened instead of starting
    // something nobody asked for.
    if (armed.mode && armed.mode !== 'harmonize') {
      setStatus('Sing back has been removed here — say “harmonise with me”.')
      onClear?.()
      return
    }

    if (armed.parts?.length) setParts(armed.parts)
    else if (armed.part) setParts([armed.part])
    // "harmonize me in alto" is already the instruction to begin. Arming the
    // panel and then waiting for a button press asks for the same thing twice.
    autoStartRef.current = true
    onClear?.()
  }, [armed, onClear])


  // Pull the manifest up front so the UI can show the tempo before playing.
  useEffect(() => {
    let alive = true
    fetch(`${baseUrl}/media/harmony/manifest.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (alive && m) { setManifest(m); cacheRef.current.manifest = m } })
      .catch(() => {})
    fetch(`${baseUrl}/media/harmony/contours.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => { if (alive && c) { setContours(c); cacheRef.current.contours = c } })
      .catch(() => {})
    // The English lines, on the same clock as the recording. Missing simply
    // means no words on screen: the harmony itself does not depend on them.
    fetch(`${baseUrl}/media/harmony/lyrics_en.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((l) => { if (alive && l?.lines?.length) setLyrics(l.lines) })
      .catch(() => {})
    return () => { alive = false }
  }, [baseUrl])

  const setHold = (v) => {
    holdingRef.current = v
    setHolding(v)
  }

  const togglePart = (p) =>
    setParts((cur) => {
      const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]
      // Keep canonical SATB order, and never leave the selection empty.
      const ordered = PARTS.filter((x) => next.includes(x))
      return ordered.length ? ordered : cur
    })

  const teardown = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    if (playerRef.current) {
      playerRef.current.fadeOutAndStop(0.4)
      playerRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    setListening(false)
    onActiveChange?.(false)      // recognition may listen again
    lineRef.current = -1
    setLineIndex(-1)
    holdingRef.current = false
    setHolding(false)
    setPitch({ hz: 0, clarity: 0 })
  }, [])

  // ---- shared mic setup -----------------------------------------------------
  const openMic = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false, // would fight the harmony coming out the speakers
        noiseSuppression: false, // would chew up sustained sung vowels
        autoGainControl: false,
      },
    })
    streamRef.current = stream
    const ctx =
      ctxRef.current ?? new (window.AudioContext || window.webkitAudioContext)()
    ctxRef.current = ctx
    await ctx.resume()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    ctx.createMediaStreamSource(stream).connect(analyser)
    analyserRef.current = analyser
    bufRef.current = new Float32Array(analyser.fftSize)
    return ctx
  }, [])

  const start = useCallback(async () => {
    try {
      setStatus('Opening the microphone…')
      const ctx = await openMic()
      startedAtRef.current = ctx.currentTime
      lastVoicedRef.current = ctx.currentTime
      hasSungRef.current = false
      lineRef.current = -1
      setLineIndex(-1)
      playbackStartedRef.current = 0
      holdingRef.current = false
      sustainRef.current = { midi: null, since: 0 }
      setPlayhead(0)

      {
        setStatus('Loading the harmony parts…')
        const chosen = partsRef.current
        const loaded = await loadHarmony(baseUrl, ctx, chosen, cacheRef.current)
        cacheRef.current = loaded
        setManifest(loaded.manifest)
        setContours(loaded.contours)
        boundsRef.current = loaded.manifest.phrase_boundaries ?? []

        const missing = chosen.filter((p) => !loaded.buffers[p])
        if (missing.length === chosen.length) {
          setStatus(`No recording found for ${chosen.join(', ')}.`)
          teardown()
          return
        }

        // Sound the recording's own starting pitch. The takes sit ~21 cents
        // below concert pitch, so tuning to a piano would beat against them —
        // tuning to this note will not.
        const refHz = loaded.manifest.parts.soprano?.start_hz ?? 385.4
        setStatus('Listen for your starting note…')
        const refLen = soundReference(ctx, refHz, 1.6)

        const bpm = loaded.manifest.tempo_bpm ?? 84
        const { endsAt } = countIn(ctx, bpm, 4, ctx.currentTime + refLen + 0.25)

        const player = new HarmonyPlayer(ctx, loaded.manifest, loaded.buffers, {
          onEnded: () => { setStatus('Harmony finished.'); teardown() },
        })
        playerRef.current = player

        // No fixed length: the recording runs on and the take ends when the
        // singer stops (SILENCE_STOP below), so a short demo and a full
        // performance need no different setup.
        const waitMs = Math.max(0, (endsAt - ctx.currentTime) * 1000)
        setTimeout(() => {
          if (!playerRef.current) return
          playerRef.current.start(chosen)
          // The clock for "have they stopped singing?" starts HERE, not when
          // the mic opened — everything before this was count-in.
          lastVoicedRef.current = ctx.currentTime
          playbackStartedRef.current = ctx.currentTime
          setStatus(`Harmonising in ${chosen.join(' + ')} — sing!`)
        }, waitMs)
        setStatus(`Count-in… (${bpm} BPM)`)
      }
      setListening(true)
      onActiveChange?.(true)     // recognition steps aside

      const tick = () => {
        const buffer = bufRef.current
        analyserRef.current.getFloatTimeDomainData(buffer)
        const { hz, clarity } = detectPitch(buffer, ctx.sampleRate)
        const now = ctx.currentTime
        const player = playerRef.current

        if (hz > 0) {
          setPitch({ hz, clarity })
          lastVoicedRef.current = now
          hasSungRef.current = true
          // Track how long the current note has been held — used to decide
          // whether the singer is sustaining through a phrase end.
          const midi = Math.round(midiFromHz(hz))
          if (sustainRef.current.midi !== midi) {
            sustainRef.current = { midi, since: now }
          }
        } else {
          setPitch((p) => ({ ...p, clarity: 0 }))
          sustainRef.current = { midi: null, since: 0 }
        }

        if (player) {
          const head = player.playhead
          setPlayhead(head)

          // The words. Lyric times are measured from the start of the FILE and
          // the playhead from the first sung note, so the lead-in is the
          // difference between the two clocks.
          if (lyrics) {
            const at = head + (cacheRef.current.manifest?.lead_in ?? 0)
            let idx = -1
            for (let k = 0; k < lyrics.length; k += 1) {
              if (at >= lyrics[k].t && at < lyrics[k].end) { idx = k; break }
            }
            if (idx !== lineRef.current) {
              lineRef.current = idx
              setLineIndex(idx)
            }
          }

          const quiet = now - lastVoicedRef.current

          // The recording follows the singer: it waits whenever they are not
          // singing, and picks up again the moment they are. Only a long
          // silence actually finishes the take.
          const waitedTooLong =
            !hasSungRef.current &&
            playbackStartedRef.current > 0 &&
            now - playbackStartedRef.current > NO_SHOW_STOP

          if (player.playing) {
            const bounds = boundsRef.current
            const head = player.playhead
            const atBoundary = bounds.some((b) => head >= b && head < b + 0.35)
            const sustaining =
              sustainRef.current.midi !== null &&
              now - sustainRef.current.since > SUSTAIN_HOLD

            if (hasSungRef.current && quiet > SILENCE_PAUSE) {
              // Stopped mid-song — wait here rather than carrying on alone.
              player.hold()
              setHold(true)
              setStatus('Paused — sing again to carry on.')
            } else if (atBoundary && sustaining) {
              // Still singing, but holding a note past the end of the phrase.
              player.hold()
              setHold(true)
              setStatus('Holding for you…')
            } else if (waitedTooLong) {
              setStatus("I didn't hear any singing — stopped.")
              player.fadeOutAndStop(0.6)
              setTimeout(() => teardown(), 700)
            }
          } else if (holdingRef.current) {
            if (hz > 0) {
              // Any note brings the harmony straight back in.
              player.resume()
              setHold(false)
              setStatus('Carrying on.')
            } else if (quiet > SILENCE_END) {
              setStatus('Finished — you stopped singing.')
              setTimeout(() => teardown(), 200)
            }
          }
        }

        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (err) {
      console.error('Sing: start failed', err)
      setStatus(`Could not start: ${err.message}`)
      teardown()
    }
  }, [baseUrl, openMic, teardown])

  /**
   * Begin once a command's selection has actually been applied.
   *
   * Deliberately separate from the effect that handles `armed`. start() reads
   * the parts through a ref, and that ref is only refreshed after the state has
   * been committed — starting in the same effect would begin with whatever was
   * selected BEFORE the command, the opposite of what was asked for.
   *
   * It also has to sit HERE, below start and teardown: a dependency array is
   * evaluated during render, and naming a const declared further down throws
   * before the component can mount.
   */
  useEffect(() => {
    if (!autoStartRef.current) return undefined
    if (listening) {
      // A fresh command restarts rather than joining the take already running.
      // This effect runs again once listening clears, and starts then.
      teardown()
      return undefined
    }

    // Wait for her to finish answering. A command is acknowledged out loud —
    // "Okay, sing Lupang Hinirang and I'll harmonize with you in alto" — and
    // starting the moment the directive arrives laid the reference note and
    // the count-in straight over the top of that sentence.
    //
    // hearingSelf() is the same window everything else uses to know when she
    // is the one making the sound, so this covers the spoken reply however it
    // is produced: the backend's audio, or the browser's fallback voice.
    // Say so, or the pause between her answer and the count-in reads as a
    // panel that took the command and then did nothing with it.
    if (hearingSelf()) setStatus('Starting when ALZONA finishes speaking…')

    return whenQuiet(() => {
      autoStartRef.current = false
      start()
    }, { pollMs: QUIET_POLL_MS, maxWaitMs: QUIET_WAIT_MAX_MS })
  }, [parts, listening, start, teardown])

  const stop = useCallback(() => {
    teardown()
    setStatus('Stopped.')
  }, [teardown])

  useEffect(() => () => teardown(), [teardown])

  const info = noteLabel(pitch.hz)
  const inTune = Math.abs(info.cents) <= 15 && pitch.hz > 0
  const needle = Math.max(-50, Math.min(50, info.cents))
  const userMidi = pitch.hz > 0 ? midiFromHz(pitch.hz) : null

  return (
    <section className="rounded-2xl border border-white/10 bg-[rgba(255,255,255,0.06)] p-4 shadow-2xl shadow-black/20 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-white/50">Lupang Hinirang</p>
          <h2 className="mt-1 text-lg font-bold text-white">Sing &amp; Harmonise</h2>
        </div>
        <div className="rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-3 py-1 text-xs font-semibold text-fuchsia-200">
          {manifest ? `${manifest.tempo_bpm} BPM` : 'pitch'}
        </div>
      </div>

      {/* Parts — any combination */}
          <div className="mt-3">
            <p className="text-[10px] uppercase tracking-widest text-white/40">Voices</p>
            <div className="mt-1.5 grid grid-cols-4 gap-1.5">
              {PARTS.map((p) => {
                const on = parts.includes(p)
                return (
                  <button
                    key={p}
                    type="button"
                    disabled={listening}
                    onClick={() => togglePart(p)}
                    style={on ? { background: PART_COLORS[p], color: '#171457' } : undefined}
                    className={`rounded-lg px-1 py-2 text-xs font-bold capitalize transition ${
                      on ? '' : 'bg-white/10 text-white/60 hover:bg-white/20'
                    } disabled:opacity-40`}
                  >
                    {p.slice(0, 4)}
                  </button>
                )
              })}
            </div>
          </div>

      {/* The English words, as she sings the Filipino ones */}
      {lyrics && (
        <div className="mt-3 min-h-[4.5rem] rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-center">
          {lineIndex >= 0 ? (
            <>
              <p className="text-base font-semibold leading-snug text-white">
                {lyrics[lineIndex].text}
              </p>
              {/* The line coming next, dimmed: a singer can see it arriving
                  instead of reading each line only once it is already gone. */}
              {lyrics[lineIndex + 1] && (
                <p className="mt-1 text-xs leading-snug text-white/35">
                  {lyrics[lineIndex + 1].text}
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-white/30">
              {listening
                ? '♪'
                : 'The English words appear here as she sings.'}
            </p>
          )}
        </div>
      )}

      {/* Live chart */}
      <div className="mt-3">
        <HarmonyChart
          userMidi={userMidi}
          // Yours and hers. The chart shows the PITCHES, not the words.
          parts={parts}
          nameParts
          contours={contours}
          playhead={playhead}
          leadIn={manifest?.lead_in ?? 0}
          running={listening}
        />
      </div>

      {/* Note readout */}
      <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-3 text-center">
        <div className="flex items-baseline justify-center gap-1">
          <span
            className={`text-4xl font-extrabold tabular-nums ${
              pitch.hz > 0 ? (inTune ? 'text-emerald-300' : 'text-[#ffe8b6]') : 'text-white/25'
            }`}
          >
            {info.name}
          </span>
          <span className="text-xl font-bold text-white/50">{info.octave}</span>
        </div>
        <p className="mt-1 text-xs tabular-nums text-white/60">
          {pitch.hz > 0 ? `${pitch.hz.toFixed(1)} Hz` : 'no pitch'}
          {pitch.hz > 0 && (
            <span className={inTune ? 'text-emerald-300' : 'text-amber-300'}>
              {'  '}
              {info.cents >= 0 ? '+' : ''}
              {info.cents}¢
            </span>
          )}
        </p>
        <div className="relative mt-2 h-2.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-white/40" />
          {pitch.hz > 0 && (
            <div
              className={`absolute top-0 h-full w-2 rounded-full transition-all duration-75 ${
                inTune ? 'bg-emerald-400' : 'bg-amber-400'
              }`}
              style={{ left: `calc(${50 + needle}% - 4px)` }}
            />
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={listening ? stop : start}
        className={`mt-3 w-full rounded-xl px-4 py-3 text-sm font-bold transition ${
          listening
            ? 'bg-rose-500 text-white hover:bg-rose-400'
            : 'bg-emerald-500 text-white hover:bg-emerald-400'
        }`}
      >
        {listening ? 'Stop' : `Harmonise in ${parts.join(' + ')}`}
      </button>

      <p className={`mt-2 text-xs ${holding ? 'text-amber-300' : 'text-white/50'}`}>{status}</p>
      <p className="mt-1 text-[10px] text-white/30">
        Use headphones — otherwise the mic hears the harmony and tracks that instead of you.
      </p>
    </section>
  )
}
