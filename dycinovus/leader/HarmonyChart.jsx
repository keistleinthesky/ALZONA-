import { useEffect, useRef } from 'react'

// =============================================================================
// Live pitch chart: your voice against each harmony part, colour-coded.
// =============================================================================
// Canvas rather than SVG because this redraws every frame — a few hundred DOM
// nodes per frame would drop the framerate and make the singer's line stutter.

export const PART_COLORS = {
  soprano: '#f472b6', // pink
  alto: '#a78bfa', // violet
  tenor: '#38bdf8', // sky
  bass: '#34d399', // emerald
}
export const USER_COLOR = '#fbbf24' // amber — deliberately unlike the parts

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const midiName = (m) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`

// Seconds of history on screen. ~6s is enough to see the shape of a phrase
// without squashing the notes together.
const WINDOW = 6
// Part of the window sits AHEAD of the playhead so notes appear a moment before
// you have to sing them — the display is a cue, not just a record.
const LOOKAHEAD = 1.5

/**
 * @param {number|null} userMidi   the singer's current pitch, as a MIDI number
 * @param {string[]}    parts      which harmony parts are sounding
 * @param {object}      contours   {part: {notes: [{t, d, midi, name}]}}
 * @param {number}      playhead   position in the recording, seconds
 * @param {boolean}     running    whether to keep collecting history
 */
export default function HarmonyChart({
  userMidi,
  parts,
  contours,
  playhead,
  running,
  // Contour note times are measured from the START OF THE FILE, but playhead is
  // measured from the FIRST SUNG NOTE. Without this the chart sits ~0.6s out of
  // step with what you actually hear.
  leadIn = 0,
}) {
  const canvasRef = useRef(null)
  const historyRef = useRef([]) // [{t, midi}] of the singer, t = playhead seconds
  const rafRef = useRef(null)
  const drawRef = useRef(null)
  const stateRef = useRef({ userMidi, parts, contours, playhead, running })

  // Keep the draw loop reading fresh values without restarting it every render.
  stateRef.current = { userMidi, parts, contours, playhead, running, leadIn }

  useEffect(() => {
    if (!running) historyRef.current = []
  }, [running])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d')

    const draw = () => {
      const s = stateRef.current
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      if (s.running && s.userMidi) {
        historyRef.current.push({ t: s.playhead, midi: s.userMidi })
        // Drop anything scrolled off the left edge.
        const cutoff = s.playhead + LOOKAHEAD - WINDOW
        while (historyRef.current.length && historyRef.current[0].t < cutoff) {
          historyRef.current.shift()
        }
      }

      const t1 = s.playhead + LOOKAHEAD
      const t0 = t1 - WINDOW

      // Vertical range: cover every active part plus the singer, with padding,
      // so nothing is ever drawn off the top or bottom of the box.
      let lo = 127
      let hi = 0
      for (const p of s.parts) {
        const notes = s.contours?.[p]?.notes
        if (!notes) continue
        for (const n of notes) {
          const ns = n.t - s.leadIn
          if (ns + n.d < t0 || ns > t1) continue
          lo = Math.min(lo, n.midi)
          hi = Math.max(hi, n.midi)
        }
      }
      for (const pt of historyRef.current) {
        lo = Math.min(lo, pt.midi)
        hi = Math.max(hi, pt.midi)
      }
      if (lo > hi) {
        lo = 55
        hi = 79
      }
      lo -= 3
      hi += 3
      if (hi - lo < 12) {
        const mid = (hi + lo) / 2
        lo = mid - 6
        hi = mid + 6
      }

      const padL = 34
      const x = (t) => padL + ((t - t0) / WINDOW) * (w - padL - 6)
      const y = (m) => h - 14 - ((m - lo) / (hi - lo)) * (h - 26)

      // Octave gridlines with note labels down the left.
      ctx.font = '9px ui-monospace, monospace'
      ctx.textBaseline = 'middle'
      for (let m = Math.ceil(lo); m <= hi; m += 1) {
        if (m % 12 !== 0) continue // C of each octave
        ctx.strokeStyle = 'rgba(255,255,255,0.10)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(padL, y(m))
        ctx.lineTo(w - 6, y(m))
        ctx.stroke()
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.fillText(midiName(m), 4, y(m))
      }

      // Harmony parts: each note is a horizontal bar for its duration, which
      // reads more like a score than a connected line would.
      for (const p of s.parts) {
        const notes = s.contours?.[p]?.notes
        if (!notes) continue
        ctx.strokeStyle = PART_COLORS[p] ?? '#888'
        ctx.lineWidth = 4
        ctx.lineCap = 'round'
        for (const n of notes) {
          const ns = n.t - s.leadIn
          const ne = ns + n.d
          if (ne < t0 || ns > t1) continue
          ctx.globalAlpha = ns > s.playhead ? 0.45 : 1 // notes not yet reached are dimmer
          ctx.beginPath()
          ctx.moveTo(x(Math.max(ns, t0)), y(n.midi))
          ctx.lineTo(x(Math.min(ne, t1)), y(n.midi))
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }

      // The singer's line, drawn last so it sits on top.
      const hist = historyRef.current
      if (hist.length > 1) {
        ctx.strokeStyle = USER_COLOR
        ctx.lineWidth = 2.5
        ctx.lineJoin = 'round'
        ctx.beginPath()
        hist.forEach((pt, i) => {
          const px = x(pt.t)
          const py = y(pt.midi)
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        })
        ctx.stroke()
        const last = hist[hist.length - 1]
        ctx.fillStyle = USER_COLOR
        ctx.beginPath()
        ctx.arc(x(last.t), y(last.midi), 4, 0, Math.PI * 2)
        ctx.fill()
      }

      // Playhead
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x(s.playhead), 4)
      ctx.lineTo(x(s.playhead), h - 4)
      ctx.stroke()

      // Only keep animating while a take is running. Idling on rAF pins a core
      // for nothing, and on the robot that competes with face detection.
      if (stateRef.current.running) {
        rafRef.current = requestAnimationFrame(draw)
      } else {
        rafRef.current = null
      }
    }

    drawRef.current = draw
    draw() // paint once so the empty chart (gridlines, legend) is visible
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Kick the loop back off whenever a take starts, and repaint once on the
  // trailing edge so the final frame isn't left half-drawn.
  useEffect(() => {
    if (running && !rafRef.current && drawRef.current) {
      rafRef.current = requestAnimationFrame(drawRef.current)
    } else if (!running && drawRef.current) {
      drawRef.current()
    }
  }, [running, parts, contours])

  return (
    <div>
      <canvas ref={canvasRef} className="h-40 w-full rounded-xl bg-black/40" />
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded" style={{ background: USER_COLOR }} />
          <span className="font-semibold text-white/80">You</span>
        </span>
        {['soprano', 'alto', 'tenor', 'bass'].map((p) => (
          <span
            key={p}
            className={`flex items-center gap-1.5 ${
              parts.includes(p) ? 'opacity-100' : 'opacity-25'
            }`}
          >
            <span
              className="inline-block h-2 w-4 rounded"
              style={{ background: PART_COLORS[p] }}
            />
            <span className="capitalize text-white/70">{p}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
