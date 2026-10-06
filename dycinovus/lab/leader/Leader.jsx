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
// HARMONY — recorded SATB parts for any of the songs, words on screen
// =============================================================================
// One panel, several songs. Which songs exist is read from
// source/harmony/songs.json, so adding one is a folder of recordings and an
// entry in that file; nothing here changes. A song listed without recordings
// is shown greyed out rather than hidden, because "it is coming" is more use
// to someone looking at the screen than a name that simply is not there.
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

// How far ahead of a line being sung its words appear.
//
// Showing a line exactly as it starts is too late to be read: by the time the
// eye has found it the phrase is under way, which reads as the screen lagging
// the singing. A short lead puts the words there just before they are wanted.
const LYRIC_LEAD = 0.4

// Every take writes what it did to static/sing_debug.log through the backend.
// The singing runs entirely in the browser, so without this there is no record
// afterwards of why a take stopped — and "it stopped singing" is not a thing
// anyone can answer from the room.
function say(baseUrl, line) {
  try {
    const fd = new FormData()
    fd.append('line', `HARMONY ${line}`)
    fetch(`${baseUrl}/debug_log`, { method: 'POST', body: fd }).catch(() => {})
  } catch { /* telemetry must never break a take */ }
}

const SILENCE_PAUSE = 1.2
// Only after this much continuous silence do we call the take finished and
// release the microphone.
const SILENCE_END = 10.0
// A note held this long counts as a sustain worth waiting for at a phrase end.
const SUSTAIN_HOLD = 0.5
// If the count-in finishes and no singing arrives at all, stop rather than
// playing all 72 seconds to an empty room.
const NO_SHOW_STOP = 12.0
// The count-in tempo when a manifest does not name one, which so far is
// every manifest: analyze_harmony.py measures pitch and timing, not tempo.
const DEFAULT_BPM = 84


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
  // Handed the line being sung, so the page can put it on the screen itself
  // rather than only in this panel. Null when nothing is being sung.
  onLyric,
} = {}) {
  const [listening, setListening] = useState(false)
  const [songs, setSongs] = useState([])
  const [songId, setSongId] = useState(null)
  const [parts, setParts] = useState(['alto'])
  const [pitch, setPitch] = useState({ hz: 0, clarity: 0 })
  const [status, setStatus] = useState('Idle')
  const [playhead, setPlayhead] = useState(0)
  const [holding, setHolding] = useState(false)
  // Which line is showing, purely for the readout below. The panel already
  // re-renders every frame from `playhead`, so this costs nothing extra.
  const [lineNo, setLineNo] = useState(0)
  const [manifest, setManifest] = useState(null)
  const [contours, setContours] = useState(null)

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
  const songRef = useRef(null)
  // Which lyric line is on screen. Read inside the animation frame, which
  // would otherwise set state sixty times a second to say nothing changed.
  const lineRef = useRef(-1)
  // Through a ref: the animation frame is created once per take and would
  // otherwise hold the callback the page had when singing started.
  const onLyricRef = useRef(onLyric)
  // A stop is decided in the animation frame but carried out on a timer, so
  // the branch keeps being true until teardown actually runs. Without this
  // the reason was written to the log sixty times a second - thirty copies of
  // the same line, which buries whatever came before it.
  const stoppingRef = useRef(false)
  // The words. Held in a ref rather than state on purpose: nothing in this
  // panel draws them, and start() is memoised without them, so a loop reading
  // state would capture whatever they were when the take began — usually
  // null, the fetch not yet having finished.
  const lyricsRef = useRef(null)

  useEffect(() => { partsRef.current = parts }, [parts])
  useEffect(() => {
    songRef.current = songs.find((x) => x.id === songId) ?? null
  }, [songs, songId])

  // A song is only recorded in the parts its manifest lists, and a song part
  // way through being recorded has some of the four. The panel used to offer
  // all four regardless — picking one nobody had sung failed at the moment of
  // singing, which is the worst place to find out. Unrecorded parts are shown
  // greyed instead.
  const available = manifest?.parts ? PARTS.filter((p) => manifest.parts[p]) : PARTS

  // Keep the selection inside what exists. The default is alto, which Ama
  // Namin does not have; without this, choosing that song left the panel
  // pointing at a part it could never sing.
  useEffect(() => {
    if (!manifest?.parts) return
    setParts((cur) => {
      const keep = cur.filter((p) => manifest.parts[p])
      if (keep.length) return keep.length === cur.length ? cur : keep
      const first = PARTS.find((p) => manifest.parts[p])
      return first ? [first] : cur
    })
  }, [manifest])
  useEffect(() => { onLyricRef.current = onLyric }, [onLyric])

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

    // "alzona harmonize with me in silent night in alto" — one command carrying
    // both. A song with no recordings is refused here rather than started and
    // then found to be silent.
    if (armed.song) {
      if (armed.song_ready === false) {
        setStatus(`I don't have ${armed.song_title ?? 'that song'} recorded yet.`)
        onClear?.()
        return
      }
      setSongId(armed.song)
    }

    if (armed.parts?.length) setParts(armed.parts)
    else if (armed.part) setParts([armed.part])
    // "harmonize me in alto" is already the instruction to begin. Arming the
    // panel and then waiting for a button press asks for the same thing twice.
    autoStartRef.current = true
    onClear?.()
  }, [armed, onClear])


  // Which songs there are. First one with recordings is the one selected.
  useEffect(() => {
    let alive = true
    fetch(`${baseUrl}/media/harmony/songs.json`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d?.songs?.length) return
        setSongs(d.songs)
        setSongId((cur) => cur ?? (d.songs.find((x) => x.ready) ?? d.songs[0]).id)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [baseUrl])

  // That song's manifest and words, so the panel can show its tempo and the
  // overlay has something to display before a note is played.
  useEffect(() => {
    const song = songs.find((x) => x.id === songId)
    if (!song) return undefined
    const dir = song.dir ? `${song.dir}/` : ''
    let alive = true

    // Belongs to the previous song. Clearing stops its tempo and its words
    // showing against this one while the new files are on their way.
    setManifest(null)
    setContours(null)
    lyricsRef.current = null
    cacheRef.current = { dir: song.dir ?? '' }

    fetch(`${baseUrl}/media/harmony/${dir}manifest.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (alive && m) { setManifest(m); cacheRef.current.manifest = m } })
      .catch(() => {})
    fetch(`${baseUrl}/media/harmony/${dir}contours.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => { if (alive && c) { setContours(c); cacheRef.current.contours = c } })
      .catch(() => {})
    // The words, in both languages.
    //
    // The Filipino file carries the timings, measured from the recording. The
    // English is a PLAIN TEXT file — one line per sung line, blank lines
    // ignored — so the pairing is rearranged by moving lines around in a text
    // editor. No JSON to break, nothing to rebuild: save it, reload the page.
    //
    // Either one missing just means fewer words on screen. The harmony does
    // not depend on any of this.
    // Never from the cache.
    //
    // lyrics_en.txt is edited by hand and the whole point of it is that a
    // change shows up on the next page load. It does not: the browser cached
    // the first copy it ever fetched and served that instead, for days. Three
    // rounds of corrected timings were written, served correctly by the
    // backend, and never once seen by this page - the copy in the browser
    // still had no times in it at all. Whatever is on disk is what the singer
    // should get, so ask for it properly.
    const fresh = { cache: 'no-store' }
    const bust = `?v=${Date.now()}`
    Promise.all([
      fetch(`${baseUrl}/media/harmony/${dir}lyrics.json${bust}`, fresh)
        .then((r) => (r.ok ? r.json() : null)),
      fetch(`${baseUrl}/media/harmony/${dir}lyrics_en.txt${bust}`, fresh)
        .then((r) => (r.ok ? r.text() : '')),
    ])
      .then(([fil, en]) => {
        if (!alive || !fil?.lines?.length) return
        // A line may carry its own start time in seconds — "12.62 Land dear
        // and holy" — which overrides the time measured for the Filipino line
        // it sits against. That is the way to fix a line that comes up at the
        // wrong moment without touching anything else.
        const english = (en || '')
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean)
          .map((raw) => {
            const m = raw.match(/^(\d+(?:\.\d+)?)\s+(.+)$/)
            return m ? { at: parseFloat(m[1]), text: m[2] } : { at: null, text: raw }
          })

        lyricsRef.current = fil.lines.map((l, i) => ({
          t: english[i]?.at ?? l.t,
          end: l.end,
          fil: l.text,
          en: english[i]?.text ?? '',
        }))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [baseUrl, songs, songId])

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
    setLineNo(0)
    onLyricRef.current?.(null)
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
      // Ask for the microphone BEFORE taking it.
      //
      // This used to open the mic first and announce it afterwards, so for
      // the length of a getUserMedia call the recogniser still held the
      // device - and on the take in the log it never let go at all: the
      // stream carried silence for twelve seconds and the harmony stopped
      // saying nobody sang. Announcing first gives recognition the chance to
      // abort, and the pause below is long enough for it to actually happen.
      onActiveChange?.(true)
      setStatus('Taking the microphone…')
      await new Promise((r) => setTimeout(r, 250))

      setStatus('Opening the microphone…')
      const ctx = await openMic()
      startedAtRef.current = ctx.currentTime
      lastVoicedRef.current = ctx.currentTime
      hasSungRef.current = false
      stoppingRef.current = false
      lineRef.current = -1
      playbackStartedRef.current = 0
      holdingRef.current = false
      sustainRef.current = { midi: null, since: 0 }
      setPlayhead(0)

      {
        const song = songRef.current
        setStatus(`Loading ${song?.title ?? 'the harmony'}…`)
        const chosen = partsRef.current
        const loaded = await loadHarmony(baseUrl, ctx, chosen,
                                         cacheRef.current, song?.dir ?? '')
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

        const bpm = loaded.manifest.tempo_bpm ?? DEFAULT_BPM
        const { endsAt } = countIn(ctx, bpm, 4, ctx.currentTime + refLen + 0.25)

        const player = new HarmonyPlayer(ctx, loaded.manifest, loaded.buffers, {
          onEnded: () => {
            say(baseUrl, 'STOP recording-ended')
            setStatus('Harmony finished.')
            teardown()
          },
        })
        playerRef.current = player

        // A song may finish before its recording does. Silent Night was
        // recorded with three verses and is sung with two, so ends_at in
        // songs.json stops it at the end of the second rather than leaving
        // a verse nobody wants playing to the room. Without one the take
        // runs on and ends when the singer stops, which is what every song
        // did before this.
        const endAfter = songRef.current?.ends_at ?? null

        const waitMs = Math.max(0, (endsAt - ctx.currentTime) * 1000)
        setTimeout(() => {
          if (!playerRef.current) return
          playerRef.current.start(chosen, { stopAfter: endAfter })
          // The clock for "have they stopped singing?" starts HERE, not when
          // the mic opened — everything before this was count-in.
          lastVoicedRef.current = ctx.currentTime
          playbackStartedRef.current = ctx.currentTime
          setStatus(`${song?.title ?? 'Harmonising'} in `
            + `${chosen.join(' + ')} — sing!`)
        }, waitMs)
        setStatus(`Count-in… (${bpm} BPM)`)
      }
      setListening(true)
      say(baseUrl, `start song=${songRef.current?.id ?? '?'} `
        + `parts=${partsRef.current.join('+')} `
        + `lead_in=${cacheRef.current.manifest?.lead_in ?? '?'}`)

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
          const words = lyricsRef.current
          if (words) {
            const at = head + (cacheRef.current.manifest?.lead_in ?? 0)

            // The latest line whose turn has come, rather than the line whose
            // window contains this instant.
            //
            // Matching the window meant the words vanished in the rests
            // BETWEEN lines - a third of a second of nothing, twenty times a
            // song - and only appeared once a line was already being sung.
            // Both read as the screen running late. This holds a line until
            // the next one is due, and brings each one up a little early.
            let idx = -1
            for (let k = 0; k < words.length; k += 1) {
              if (at >= words[k].t - LYRIC_LEAD) idx = k
            }

            // Clear once the singing is over, rather than leaving the closing
            // line on screen for as long as the panel stays open.
            if (idx === words.length - 1 && at > words[idx].end + 1.5) idx = -1

            if (idx !== lineRef.current) {
              lineRef.current = idx
              setLineNo(idx + 1)
              onLyricRef.current?.(idx >= 0 ? words[idx] : null)
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
              say(baseUrl, `pause at=${head.toFixed(2)}s quiet=${quiet.toFixed(2)}s`)
              player.hold()
              setHold(true)
              setStatus('Paused — sing again to carry on.')
            } else if (atBoundary && sustaining) {
              // Still singing, but holding a note past the end of the phrase.
              say(baseUrl, `hold-at-boundary at=${head.toFixed(2)}s`)
              player.hold()
              setHold(true)
              setStatus('Holding for you…')
            } else if (waitedTooLong && !stoppingRef.current) {
              stoppingRef.current = true
              // The input level distinguishes the two ways this happens: a
              // level of zero means something else has the microphone, and a
              // small non-zero one means the singer is too far from it.
              let peak = 0
              for (let k = 0; k < buffer.length; k += 8) {
                const v = Math.abs(buffer[k])
                if (v > peak) peak = v
              }
              say(baseUrl, `STOP nobody-sang after=${NO_SHOW_STOP}s `
                + `at=${head.toFixed(2)}s peak=${peak.toFixed(4)}`)
              setStatus("I didn't hear any singing — stopped.")
              player.fadeOutAndStop(0.6)
              setTimeout(() => teardown(), 700)
            }
          } else if (holdingRef.current) {
            if (hz > 0) {
              // Any note brings the harmony straight back in.
              say(baseUrl, `resume at=${player.playhead.toFixed(2)}s hz=${hz.toFixed(1)}`)
              player.resume()
              setHold(false)
              setStatus('Carrying on.')
            } else if (quiet > SILENCE_END && !stoppingRef.current) {
              stoppingRef.current = true
              say(baseUrl, `STOP silence quiet=${quiet.toFixed(1)}s `
                + `at=${player.playhead.toFixed(2)}s`)
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
  }, [baseUrl, onActiveChange, openMic, teardown])

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
    say(baseUrl, 'STOP button')
    teardown()
    setStatus('Stopped.')
  }, [baseUrl, teardown])

  useEffect(() => () => teardown(), [teardown])

  const info = noteLabel(pitch.hz)
  const inTune = Math.abs(info.cents) <= 15 && pitch.hz > 0
  const needle = Math.max(-50, Math.min(50, info.cents))
  const userMidi = pitch.hz > 0 ? midiFromHz(pitch.hz) : null

  return (
    <section className="rounded-2xl border border-white/10 bg-[rgba(255,255,255,0.06)] p-4 shadow-2xl shadow-black/20 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-white/50">
            {songs.find((x) => x.id === songId)?.title ?? 'Harmony'}
          </p>
          <h2 className="mt-1 text-lg font-bold text-white">Sing &amp; Harmonise</h2>
        </div>
        <div className="rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-3 py-1 text-xs font-semibold text-fuchsia-200">
          {manifest ? `${manifest.tempo_bpm ?? DEFAULT_BPM} BPM` : 'pitch'}
        </div>
      </div>

      {/* Song. One panel for all of them, rather than a panel each. */}
      {songs.length > 1 && (
        <div className="mt-3">
          <p className="text-[10px] uppercase tracking-widest text-white/40">Song</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {songs.map((sg) => {
              const on = sg.id === songId
              // Listed but not recorded yet: shown, and plainly not pickable.
              const waiting = !sg.ready
              return (
                <button
                  key={sg.id}
                  type="button"
                  disabled={listening || waiting}
                  title={waiting ? 'No recordings for this one yet' : undefined}
                  onClick={() => setSongId(sg.id)}
                  className={`rounded-lg px-3 py-2 text-xs font-bold transition ${
                    on ? 'bg-fuchsia-500/80 text-white'
                       : 'bg-white/10 text-white/60 hover:bg-white/20'
                  } disabled:opacity-30`}
                >
                  {sg.title}
                  {waiting && <span className="ml-1 font-normal">· soon</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Parts — any combination */}
          <div className="mt-3">
            <p className="text-[10px] uppercase tracking-widest text-white/40">Voices</p>
            {/* Only the parts this song was recorded in. A part that cannot
                be sung is not a choice, and showing it greyed asks the
                singer to work out why it is there. Bahay Kubo has two, so
                the row is two wide rather than four with half of it dead. */}
            <div
              className="mt-1.5 grid gap-1.5"
              style={{
                gridTemplateColumns:
                  `repeat(${Math.max(1, available.length)}, minmax(0, 1fr))`,
              }}
            >
              {available.map((p) => {
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

      {/* Live chart */}
      <div className="mt-3">
        <HarmonyChart
          userMidi={userMidi}
          // Yours and hers. The chart shows the PITCHES, not the words.
          parts={parts}
          available={available}
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
        {listening
          ? 'Stop'
          : `Harmonise ${songs.find((x) => x.id === songId)?.title ?? ''} `
            + `in ${parts.join(' + ')}`}
      </button>

      <p className={`mt-2 text-xs ${holding ? 'text-amber-300' : 'text-white/50'}`}>{status}</p>

      {/* Where the recording is, and which line that is.
          This is how a line that comes up at the wrong moment gets fixed:
          sing, watch the number at the instant the line actually starts, and
          put that number in front of that line in lyrics_en.txt. */}
      {listening && (
        <p className="mt-1 font-mono text-[11px] tabular-nums text-white/40">
          {(playhead + (manifest?.lead_in ?? 0)).toFixed(2)}s
          {lineNo > 0 ? `  ·  line ${lineNo}` : ''}
        </p>
      )}
      <p className="mt-1 text-[10px] text-white/30">
        Use headphones — otherwise the mic hears the harmony and tracks that instead of you.
      </p>
    </section>
  )
}
