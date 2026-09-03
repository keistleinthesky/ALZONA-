import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NoiseFloor, detectPitch, midiFromHz, noteLabel } from './pitch'
import HarmonyChart from './HarmonyChart'
import { PART_COLORS } from './partColors'
import { HarmonyPlayer, PARTS, SINGER_PARTS, loadHarmony } from './harmonyPlayer'
import {
  MIN_DISTINCT_TO_MATCH,
  MIN_NOTES_TO_MATCH,
  counterpart,
  describePosition,
  framesToNotes,
  identifyPart,
} from './scoreMatch'
import { lyricWindow } from './lyricsMatch'

// =============================================================================
// LUPANG HINIRANG — harmony that answers a live singer
// =============================================================================
// ALZONA listens continuously. Sing any part of the anthem and she works out
// the song, the words, where you are and which line you are on, then comes in
// with the OTHER line from the recordings — real singing, with the lyrics.
//
// Two ways in, one engine:
//   Sing back  - nothing to press or say. She picks the part herself: sing the
//                melody and she takes alto, sing alto and she takes the melody.
//   Harmonise  - you choose the parts, by button or by spoken command.
//
// Pitch tracking runs here in the browser so the display and the sync logic are
// immediate. The WORDS go to the backend, which also decides whether a clip was
// singing or a question — that is what lets one always-open microphone serve
// both the harmony and the conversation. The browser's SpeechRecognition can't
// share a microphone, and using it made both features fail at once.

// Stop singing for this long and the recording WAITS for you. Above a normal
// breath (~0.5s) so ordinary phrasing does not pause it.
const SILENCE_PAUSE = 1.2
// Only after this much continuous silence is the take finished.
const SILENCE_END = 10.0
// A note held this long counts as a sustain worth waiting for at a phrase end.
const SUSTAIN_HOLD = 0.5
// While paused she is not playing, so nothing counts as her own voice and a
// single stray frame used to restart her — which then paused again a moment
// later. Resuming needs this much CONTINUOUS singing, so a cough or the tail of
// her own last note cannot start the music.
const RESUME_VOICE = 0.18

// Seconds between pitch analyses while waiting for someone to sing. Detection
// is O(n^2) per call and this loop runs continuously, so every frame would
// compete with the face detector for CPU. Sung notes last well over 50ms.
const IDLE_ANALYSIS_INTERVAL = 0.05

// Auto-start retries for as long as the panel is open, backing off so a denied
// microphone is not a hot loop. It must never give up permanently: a listener
// that stops trying looks exactly like a broken robot, and the failures that
// get it there are usually transient (the backend restarting, the microphone
// briefly held by something else). The delay climbs to this ceiling and stays.
const ARM_RETRY_MIN = 600
const ARM_RETRY_MAX = 8000

// How long to trust a lyric hint that is not producing a match. Beyond this the
// hint was wrong, and keeping it would block matching for good.
const LYRIC_HINT_TIMEOUT = 5000

// How much recent pitch history to keep. Long enough for a phrase, short enough
// that a stray sound ages out instead of poisoning every later match.
const CONTOUR_MEMORY = 12

// Clip length sent for word recognition. Enough for a line of the anthem
// without the answer arriving too late to be useful.
const CLIP_MS = 4000

// Standard choral shorthand. Truncating the names instead gave "sopr"/"teno",
// which reads like a glitch on a projector.
const PART_LABEL = { soprano: 'Sop', alto: 'Alto', tenor: 'Ten', bass: 'Bass' }

// A microphone muted in Windows, or a stale default still pointing at a device
// that has been unplugged, hands the page a perfectly flat zero. Downstream
// that is indistinguishable from "nobody is singing", so both the harmony and
// the conversation die silently and look like broken features. It has to be
// caught at the source. This threshold separates digital silence from any real
// signal at all — room noise with AGC on sits orders of magnitude above it, so
// a quiet singer is never mistaken for a dead device.
const SILENT_RMS = 0.00002
const PROBE_MS = 700

const MIC_AUDIO = {
  echoCancellation: false,  // would fight the harmony from the speakers
  noiseSuppression: false,  // would chew up sustained sung vowels
  // Left ON deliberately: without it this hardware delivered an RMS of
  // 0.002 for real singing, ten times too quiet to detect at all.
  autoGainControl: true,
}

/**
 * Open a microphone that is actually producing audio.
 *
 * Tries the Windows default first — that is the one the user chose — and only
 * if it proves silent does it walk the other inputs. Returns the level it
 * measured so the caller can say so plainly when every device is dead.
 */
async function openLiveMic(ctx) {
  const probe = async (audio) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio })
    const src = ctx.createMediaStreamSource(stream)
    const an = ctx.createAnalyser()
    an.fftSize = 2048
    src.connect(an)
    const buf = new Float32Array(an.fftSize)
    let peak = 0
    const until = performance.now() + PROBE_MS
    while (performance.now() < until) {
      await new Promise((r) => setTimeout(r, 50))
      an.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i]
      peak = Math.max(peak, Math.sqrt(sum / buf.length))
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
    let cand = null
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

export default function Sing({ baseUrl, armed, onClear, onHeardSpeech }) {
  const [listening, setListening] = useState(false)
  const [mode, setMode] = useState('imitate')      // 'imitate' = sing back
  // Empty means decide automatically. A part can still be forced, by button or
  // by spoken command — but only in Harmonise.
  const [parts, setParts] = useState([])
  const [autoPart, setAutoPart] = useState(null)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [pitch, setPitch] = useState({ hz: 0, clarity: 0 })
  const [status, setStatus] = useState('Listening…')
  const [playhead, setPlayhead] = useState(0)
  const [holding, setHolding] = useState(false)
  const [manifest, setManifest] = useState(null)
  const [contours, setContours] = useState(null)
  const [matched, setMatched] = useState(null)
  const [heardLyric, setHeardLyric] = useState(null)
  const [heardSong, setHeardSong] = useState(null)
  const [diag, setDiag] = useState(null)
  const [device, setDevice] = useState(null)
  // Bumped on every failed arm so the retry effect actually re-runs.
  const [armTick, setArmTick] = useState(0)

  const ctxRef = useRef(null)
  const streamRef = useRef(null)
  const rafRef = useRef(null)
  const bufRef = useRef(null)
  const analyserRef = useRef(null)
  const playerRef = useRef(null)
  const cacheRef = useRef({})
  const contourRef = useRef([])
  const startedAtRef = useRef(0)
  const lastVoicedRef = useRef(0)
  const hasSungRef = useRef(false)
  const floorRef = useRef(new NoiseFloor())
  const matchRef = useRef(null)
  const joiningRef = useRef(false)
  const holdingRef = useRef(false)
  const boundsRef = useRef([])
  const sustainRef = useRef({ midi: null, since: 0 })
  const voiceSinceRef = useRef(0)
  const lyricsRef = useRef(null)
  const lyricWindowRef = useRef(null)
  const lyricHintAtRef = useRef(0)
  const clipRecorderRef = useRef(null)
  const clipTimerRef = useRef(null)
  const startingRef = useRef(false)
  const listeningRef = useRef(false)
  const armFailuresRef = useRef(0)
  const autoStartedRef = useRef(false)
  const modeRef = useRef(mode)
  const partsRef = useRef(parts)
  const activePartsRef = useRef([])

  // The line ALZONA is on: a forced choice in Harmonise, else the counterpart
  // of whatever the singer was identified as. Memoised so the effect mirroring
  // it into a ref does not fire on every frame.
  const activeParts = useMemo(
    () => (mode === 'harmonize' && parts.length
      ? parts
      : autoPart ? [counterpart(autoPart, SINGER_PARTS)] : []),
    [mode, parts, autoPart],
  )

  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { partsRef.current = parts }, [parts])
  useEffect(() => { listeningRef.current = listening }, [listening])
  useEffect(() => { activePartsRef.current = activeParts }, [activeParts])

  // A spoken command selects parts and switches to Harmonise.
  useEffect(() => {
    if (!armed) return
    if (armed.parts?.length) {
      setParts(armed.parts)
      setMode('harmonize')
    }
    onClear?.()
  }, [armed, onClear])

  // Reference data, fetched once.
  useEffect(() => {
    let alive = true
    const get = (name) =>
      fetch(`${baseUrl}/media/harmony/${name}`).then((r) => (r.ok ? r.json() : null))
    get('manifest.json').then((m) => {
      if (alive && m) { setManifest(m); cacheRef.current.manifest = m; boundsRef.current = m.phrase_boundaries ?? [] }
    }).catch(() => {})
    get('contours.json').then((c) => {
      if (alive && c) { setContours(c); cacheRef.current.contours = c }
    }).catch(() => {})
    get('lyrics.json').then((l) => { if (alive && l?.lines) lyricsRef.current = l.lines }).catch(() => {})
    return () => { alive = false }
  }, [baseUrl])

  const setHold = (v) => { holdingRef.current = v; setHolding(v) }

  const togglePart = (p) =>
    setParts((cur) => {
      const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]
      return PARTS.filter((x) => next.includes(x))   // empty = automatic
    })

  const teardown = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    if (clipTimerRef.current) clearTimeout(clipTimerRef.current)
    clipTimerRef.current = null
    const rec = clipRecorderRef.current
    clipRecorderRef.current = null
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null
      try { rec.stop() } catch { /* already stopped */ }
    }
    if (playerRef.current) {
      playerRef.current.fadeOutAndStop(0.4)
      playerRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    setListening(false)
    setHold(false)
    setPitch({ hz: 0, clarity: 0 })
  }, [])

  // ---- come in at the point the singer has reached -------------------------
  const joinAt = useCallback((player, match, elapsed, now, chosen, singerPart) => {
    if (!playerRef.current) return
    player.offset = match.time + elapsed
    player.start(chosen)
    lastVoicedRef.current = now
    setAutoPart(singerPart)
    setStatus(`Harmonising — ${describePosition(match, boundsRef.current)}`)
  }, [])

  // ---- clips: words, and questions -----------------------------------------
  const startClips = useCallback(() => {
    if (!streamRef.current || clipRecorderRef.current) return
    const send = async (blob) => {
      if (blob.size < 3000) return
      try {
        const fd = new FormData()
        fd.append('file', blob, 'clip.webm')
        const data = await fetch(`${baseUrl}/listen`, { method: 'POST', body: fd })
          .then((r) => r.json())

        if (data.kind === 'speech' && data.reply) {
          onHeardSpeech?.(data)          // a question — answer it, leave singing alone
          return
        }
        if (data.kind !== 'singing') return
        if (data.song) setHeardSong(data.song)
        if (data.index == null || lyricWindowRef.current || matchRef.current) return
        const line = lyricsRef.current?.[data.index]
        if (!line) return
        lyricWindowRef.current = lyricWindow({ line })
        lyricHintAtRef.current = performance.now()
        setHeardLyric(line.text)
      } catch { /* no hint; the melody matcher is unaffected */ }
    }
    try {
      const rec = new MediaRecorder(streamRef.current)
      const chunks = []
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      rec.onstop = () => {
        if (chunks.length) send(new Blob(chunks, { type: chunks[0].type }))
        chunks.length = 0
        if (clipRecorderRef.current === rec) {
          try { rec.start() } catch { return }
          clipTimerRef.current = setTimeout(() => {
            try { rec.stop() } catch { /* already stopped */ }
          }, CLIP_MS)
        }
      }
      rec.start()
      clipRecorderRef.current = rec
      clipTimerRef.current = setTimeout(() => {
        try { rec.stop() } catch { /* already stopped */ }
      }, CLIP_MS)
    } catch {
      clipRecorderRef.current = null   // no words; the melody still works
    }
  }, [baseUrl, onHeardSpeech])

  const start = useCallback(async () => {
    if (startingRef.current || listeningRef.current) return
    startingRef.current = true
    try {
      const ctx = ctxRef.current ?? new (window.AudioContext || window.webkitAudioContext)()
      ctxRef.current = ctx
      await ctx.resume()

      const mic = await openLiveMic(ctx)
      streamRef.current = mic.stream
      setDevice({ label: mic.label, silent: mic.peak <= SILENT_RMS })
      // Autoplay policy: a context created without a gesture stays suspended.
      // Listening works regardless, but the harmony would be silent.
      setAudioBlocked(ctx.state !== 'running')

      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      ctx.createMediaStreamSource(mic.stream).connect(analyser)
      analyserRef.current = analyser
      bufRef.current = new Float32Array(analyser.fftSize)

      contourRef.current = []
      startedAtRef.current = ctx.currentTime
      lastVoicedRef.current = ctx.currentTime
      hasSungRef.current = false
      matchRef.current = null
      joiningRef.current = false
      lyricWindowRef.current = null
      floorRef.current = new NoiseFloor()
      sustainRef.current = { midi: null, since: 0 }
      setMatched(null)
      setAutoPart(null)
      setHeardLyric(null)
      setHeardSong(null)
      setPlayhead(0)

      const loaded = await loadHarmony(
        baseUrl, ctx, [...new Set([...SINGER_PARTS, ...partsRef.current])], cacheRef.current,
      )
      cacheRef.current = loaded
      setManifest(loaded.manifest)
      setContours(loaded.contours)
      boundsRef.current = loaded.manifest.phrase_boundaries ?? []

      playerRef.current = new HarmonyPlayer(ctx, loaded.manifest, loaded.buffers, {
        onEnded: () => { setStatus('Finished.'); teardown() },
      })

      startClips()
      setListening(true)
      setStatus(mic.peak <= SILENT_RMS
        ? 'Microphone is silent — check it is not muted in Windows, then reload.'
        : 'Listening — just start singing.')
      armFailuresRef.current = 0

      let lastAnalysis = 0
      let lastDiag = 0
      let lastSent = 0

      const tick = () => {
        const engaged = !!matchRef.current
        const nowMs = performance.now()
        if (!engaged && nowMs - lastAnalysis < IDLE_ANALYSIS_INTERVAL * 1000) {
          rafRef.current = requestAnimationFrame(tick)
          return
        }
        lastAnalysis = nowMs

        const buffer = bufRef.current
        analyserRef.current.getFloatTimeDomainData(buffer)
        // Measure the level, let the floor adapt, then detect against it rather
        // than a hardcoded threshold.
        let lvl = 0
        for (let i = 0; i < buffer.length; i += 1) lvl += buffer[i] * buffer[i]
        lvl = Math.sqrt(lvl / buffer.length)
        const gate = floorRef.current.update(lvl)
        const { hz, clarity } = detectPitch(buffer, ctx.sampleRate, gate)
        const now = ctx.currentTime
        const player = playerRef.current

        // Self-hearing guard. Without headphones the microphone picks up
        // ALZONA's own harmony, which is sustained and steady — exactly what
        // the tracking is looking for. Left unchecked she locks onto herself
        // and harmonises with her own voice instead of the singer's.
        let selfHeard = false
        if (hz > 0 && player?.playing && matchRef.current) {
          const head = player.playhead
          const lead = cacheRef.current.manifest?.lead_in ?? 0
          const semis = matchRef.current.semitoneOffset || 0
          for (const part of activePartsRef.current) {
            const notes = cacheRef.current.contours?.[part]?.notes
            if (!notes) continue
            const cur = notes.find((n) => {
              const ns = n.t - lead
              return head >= ns && head < ns + n.d
            })
            if (!cur) continue
            // Within a third of a semitone of what she is singing right now.
            // A singer would have to be in exact unison to be mistaken for it,
            // and in unison there is no harmony to track anyway.
            if (Math.abs(midiFromHz(hz) - (cur.midi + semis)) < 0.35) {
              selfHeard = true
              break
            }
          }
        }

        const singerVoiced = hz > 0 && !selfHeard
        if (!singerVoiced) voiceSinceRef.current = 0
        else if (!voiceSinceRef.current) voiceSinceRef.current = now

        if (singerVoiced) {
          setPitch({ hz, clarity })
          lastVoicedRef.current = now
          hasSungRef.current = true
          const at = now - startedAtRef.current
          contourRef.current.push({ t: at, hz })
          const cutoff = at - CONTOUR_MEMORY
          while (contourRef.current.length && contourRef.current[0].t < cutoff) {
            contourRef.current.shift()
          }
          const midi = Math.round(midiFromHz(hz))
          if (sustainRef.current.midi !== midi) sustainRef.current = { midi, since: now }
        } else {
          setPitch((p) => ({ ...p, clarity: 0 }))
          sustainRef.current = { midi: null, since: 0 }
        }

        // ---- find where they are, and come in --------------------------------
        if (player && !matchRef.current && !joiningRef.current) {
          const sung = framesToNotes(contourRef.current)
          if (sung.length >= MIN_NOTES_TO_MATCH) {
            if (lyricWindowRef.current
                && nowMs - lyricHintAtRef.current > LYRIC_HINT_TIMEOUT) {
              lyricWindowRef.current = null
              setHeardLyric(null)
            }
            const opts = lyricWindowRef.current ? { window: lyricWindowRef.current } : {}
            const cs = cacheRef.current.contours
            // Match on a RECENT window, not the whole take: matching everything
            // meant one stray sound poisoned the sequence permanently.
            let id = null
            if (cs) {
              for (const take of [10, 14, 20, 8]) {
                const recent = sung.slice(-take)
                if (recent.length < MIN_DISTINCT_TO_MATCH) continue
                id = identifyPart(recent, cs, SINGER_PARTS, opts)
                if (id) break
              }
            }
            if (id) {
              joiningRef.current = true
              matchRef.current = id.match
              setMatched(id.match)
              // Never sing the line the singer is already on. A commanded part
              // is honoured, EXCEPT where it turns out to be their own part —
              // that is doubling, not harmony, and it sounds like ALZONA
              // singing to herself. Soprano and alto swap, as agreed.
              let chosen = [counterpart(id.part, SINGER_PARTS)]
              if (modeRef.current === 'harmonize' && partsRef.current.length) {
                const others = partsRef.current.filter((p) => p !== id.part)
                chosen = others.length
                  ? others
                  : [counterpart(id.part, SINGER_PARTS)]
              }
              const elapsed = (now - startedAtRef.current) - sung[0].start
              joinAt(player, id.match, elapsed, now, chosen, id.part)
            }
          }
        }

        // ---- follow: wait when they pause, resume when they carry on ---------
        if (player && matchRef.current) {
          setPlayhead(player.playhead)
          const quiet = now - lastVoicedRef.current
          if (player.playing) {
            const head = player.playhead
            const atBoundary = boundsRef.current.some((b) => head >= b && head < b + 0.35)
            const sustaining = sustainRef.current.midi !== null
              && now - sustainRef.current.since > SUSTAIN_HOLD
            if (hasSungRef.current && quiet > SILENCE_PAUSE) {
              player.hold(); setHold(true); setStatus('Paused — sing again to carry on.')
            } else if (atBoundary && sustaining) {
              player.hold(); setHold(true); setStatus('Holding for you…')
            }
          } else if (holdingRef.current) {
            const singingAgain = voiceSinceRef.current
              && now - voiceSinceRef.current >= RESUME_VOICE
            if (singingAgain) {
              player.resume(); setHold(false); setStatus('Carrying on.')
            } else if (quiet > SILENCE_END) {
              setStatus('Finished — you stopped singing.')
              setTimeout(() => teardown(), 200)
            }
          }
        }

        if (nowMs - lastDiag > 200) {
          lastDiag = nowMs
          const notes = framesToNotes(contourRef.current)
          const distinct = notes.filter((n, i) => i === 0 || n.midi !== notes[i - 1].midi)
          setDiag({
            level: lvl.toFixed(4), gate: gate.toFixed(4),
            hz: hz > 0 ? hz.toFixed(0) : '—', clarity: clarity.toFixed(2),
            distinct: distinct.length, need: MIN_DISTINCT_TO_MATCH,
            lyric: lyricWindowRef.current ? 'yes' : 'no',
            matched: matchRef.current ? `${matchRef.current.time.toFixed(1)}s` : 'no',
            self: selfHeard,
          })
          if (nowMs - lastSent > 1000) {
            lastSent = nowMs
            const fd = new FormData()
            // The note sequence itself, not just how many there were. Whether a
            // failed match is a bad detector or simply someone talking is not
            // decidable from a count, and guessing between those two has cost
            // more rounds of this than anything else.
            const seq = notes.slice(-10).map((nt) => nt.midi).join(',')
            fd.append('line',
              `lvl=${lvl.toFixed(4)} gate=${gate.toFixed(4)} ` +
              `hz=${hz > 0 ? hz.toFixed(0) : '-'} clar=${clarity.toFixed(2)} ` +
              `distinct=${distinct.length}/${MIN_DISTINCT_TO_MATCH} ` +
              `lyric=${lyricWindowRef.current ? 'Y' : 'n'} ` +
              `matched=${matchRef.current ? matchRef.current.time.toFixed(1) + 's' : 'no'} ` +
              `self=${selfHeard ? 'Y' : 'n'} ` +
              `mode=${modeRef.current} parts=${partsRef.current.join('+') || '-'} ` +
              `notes=[${seq}]`)
            fetch(`${baseUrl}/debug_log`, { method: 'POST', body: fd }).catch(() => {})
          }
        }

        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (err) {
      console.error('Sing: start failed', err)
      armFailuresRef.current += 1
      setStatus(err?.name === 'NotAllowedError'
        ? 'Microphone blocked — allow it in the browser, then reload.'
        : `Could not start (${err.name || 'error'}) — retrying.`)
      // Send it: a silent arm failure was indistinguishable from a working
      // listener that simply never heard anything.
      try {
        const fd = new FormData()
        fd.append('line', `ARM FAILED #${armFailuresRef.current} `
          + `${err?.name || 'error'}: ${String(err?.message || '').slice(0, 120)}`)
        fetch(`${baseUrl}/debug_log`, { method: 'POST', body: fd }).catch(() => {})
      } catch { /* telemetry must never break the retry */ }
      teardown()
      setArmTick((t) => t + 1)
    } finally {
      startingRef.current = false
    }
  }, [baseUrl, joinAt, startClips, teardown])

  // ALWAYS listening. Detecting singing on its own is the whole feature, so
  // there is nothing to press and nothing to say first.
  useEffect(() => {
    if (listening) return undefined
    const n = armFailuresRef.current
    const delay = autoStartedRef.current
      ? Math.min(ARM_RETRY_MIN * 2 ** n, ARM_RETRY_MAX)
      : ARM_RETRY_MIN
    autoStartedRef.current = true
    const id = setTimeout(() => { start() }, delay)
    return () => clearTimeout(id)
  }, [listening, start, armTick])

  // Any interaction is enough to let audio play; take the first one we get.
  useEffect(() => {
    if (!audioBlocked) return undefined
    const unlock = async () => {
      try {
        await ctxRef.current?.resume()
        if (ctxRef.current?.state === 'running') setAudioBlocked(false)
      } catch { /* wait for the next interaction */ }
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [audioBlocked])

  useEffect(() => () => teardown(), [teardown])

  const info = noteLabel(pitch.hz)
  const inTune = Math.abs(info.cents) <= 15 && pitch.hz > 0
  const userMidi = pitch.hz > 0 ? midiFromHz(pitch.hz) : null

  return (
    <section className="rounded-2xl border border-white/10 bg-[rgba(255,255,255,0.06)] p-4 shadow-2xl shadow-black/20 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-white/50">Lupang Hinirang</p>
          <h2 className="mt-1 text-lg font-bold text-white">Sing &amp; Harmonise</h2>
        </div>
        {listening ? (
          <div className="rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-3 py-1 text-xs font-semibold text-fuchsia-200">
            listening
          </div>
        ) : (
          // Always-listening is the feature, but when arming fails there has to
          // be something to press. Without it the only cure was a page reload.
          <button
            type="button"
            onClick={() => { armFailuresRef.current = 0; start() }}
            className="rounded-full border border-amber-400/40 bg-amber-400/15 px-3 py-1 text-xs font-semibold text-amber-200 transition hover:bg-amber-400/25"
          >
            Start listening
          </button>
        )}
      </div>

      <div className="mt-3 flex gap-2">
        {[['imitate', 'Sing back'], ['harmonize', 'Harmonise']].map(([m, lbl]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`flex-1 rounded-xl px-3 py-2 text-sm font-semibold transition ${
              mode === m ? 'bg-fuchsia-500/80 text-white' : 'bg-white/10 text-white/70 hover:bg-white/20'
            }`}
          >
            {lbl}
          </button>
        ))}
      </div>

      {/* Part selection is for Harmonise only. Sing back deliberately shows
          nothing about which line is being sung — it decides for itself. */}
      {mode === 'harmonize' && (
        <div className="mt-3">
          <div className="flex items-baseline justify-between">
            <p className="text-[10px] uppercase tracking-widest text-white/40">Voices</p>
            <p className="text-[10px] text-white/30">none = automatic</p>
          </div>
          <div className="mt-1.5 grid grid-cols-4 gap-1.5">
            {PARTS.map((p) => {
              const on = parts.includes(p)
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => togglePart(p)}
                  style={on ? { background: PART_COLORS[p], color: '#171457' } : undefined}
                  className={`rounded-lg px-1 py-2 text-xs font-bold capitalize transition ${
                    on ? '' : 'bg-white/10 text-white/60 hover:bg-white/20'
                  }`}
                >
                  {PART_LABEL[p]}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="mt-3">
        <HarmonyChart
          userMidi={userMidi}
          parts={activeParts}
          contours={contours}
          playhead={playhead}
          leadIn={manifest?.lead_in ?? 0}
          running={listening}
        />
      </div>

      <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 p-3 text-center">
        <div className="flex items-baseline justify-center gap-1">
          <span className={`text-4xl font-extrabold tabular-nums ${
            pitch.hz > 0 ? (inTune ? 'text-emerald-300' : 'text-[#ffe8b6]') : 'text-white/25'
          }`}>
            {info.name}
          </span>
          <span className="text-xl font-bold text-white/50">{info.octave}</span>
        </div>
        <p className="mt-1 text-xs tabular-nums text-white/60">
          {pitch.hz > 0 ? `${pitch.hz.toFixed(1)} Hz` : 'no pitch'}
        </p>
      </div>

      {listening && diag && (
        <div className="mt-2 rounded-lg border border-white/10 bg-black/25 px-2 py-1.5">
          <div className="grid grid-cols-4 gap-1 text-center text-[9px] leading-tight">
            {[
              ['level', diag.level, Number(diag.level) > Number(diag.gate)],
              ['pitch', `${diag.hz} Hz`, diag.hz !== '—'],
              ['notes', `${diag.distinct}/${diag.need}`, diag.distinct >= diag.need],
              ['joined', diag.matched, diag.matched !== 'no'],
            ].map(([k, v, good]) => (
              <div key={k}>
                <p className="uppercase tracking-wider text-white/35">{k}</p>
                <p className={good ? 'font-bold text-emerald-300' : 'text-white/50'}>{v}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {(heardSong || heardLyric) && (
        <p className="mt-2 text-[10px] text-sky-300/80">
          {heardSong ? `${heardSong} · ` : ''}
          {heardLyric ? `“${heardLyric}”` : ''}
        </p>
      )}

      {audioBlocked && (
        <p className="mt-2 text-xs text-amber-300">
          Click anywhere on the page once so the browser will let ALZONA sing.
        </p>
      )}
      <p className={`mt-2 text-xs ${holding ? 'text-amber-300' : 'text-white/50'}`}>{status}</p>
      <p className="mt-1 text-[10px] text-white/30">
        Just start singing — ALZONA finds your place and joins in. Use headphones,
        or the microphone hears her instead of you.
      </p>
    </section>
  )
}
