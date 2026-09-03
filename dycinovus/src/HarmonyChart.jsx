import { useEffect, useRef } from 'react'
import { PART_COLORS, USER_COLOR } from './partColors'

// =============================================================================
// Two voices drawn as pitch curves
// =============================================================================
// The singer's line and ALZONA's, on one note grid, so the interval between
// them is visible directly rather than inferred. Both are smooth continuous
// curves: a sung line is a shape, and two shapes are far easier to read against
// each other than two rows of blocks.
//
// Canvas rather than SVG because this redraws every frame — hundreds of DOM
// nodes per frame would stutter the singer's own line, the one thing that has
// to feel immediate.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12]
// With the octave — "A3" not "A" — so two lines an octave apart are
// distinguishable, which the bare name on the axis cannot show.
const fullName = (m) => `${noteName(m)}${Math.floor(m / 12) - 1}`

// Only name a note that is actually held; labelling every passing pitch turns
// the chart into a wall of text.
const LABEL_MIN_SEC = 0.28

// Seconds on screen, and how much sits AHEAD of the playhead so notes appear a
// moment before they have to be sung — a cue, not just a record.
const WINDOW = 6
const LOOKAHEAD = 1.5

// Keep the vertical range wide enough that a held note does not fill the height,
// and narrow enough that the note labels stay readable.
const MIN_SPAN = 12
const MAX_SPAN = 26

/** Draw a note name with a dark outline so it stays legible over any line. */
function label(ctx, text, x, y) {
  ctx.font = 'bold 15px ui-sans-serif, system-ui, sans-serif'
  ctx.textBaseline = 'bottom'
  ctx.lineWidth = 4
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, x, y)
}

/** Smooth a polyline by curving through the midpoints between samples. */
function strokeSmooth(ctx, pts) {
  if (pts.length < 2) return
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length - 1; i += 1) {
    const mx = (pts[i].x + pts[i + 1].x) / 2
    const my = (pts[i].y + pts[i + 1].y) / 2
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
  }
  const last = pts[pts.length - 1]
  ctx.lineTo(last.x, last.y)
  ctx.stroke()
}

/**
 * Stretches where the live line sits on one note long enough to be worth
 * naming. A singer's pitch wanders, so this groups by rounded semitone rather
 * than looking for exact repeats.
 */
function heldNotes(hist, minSec = LABEL_MIN_SEC) {
  const out = []
  let run = null
  for (const pt of hist) {
    const m = Math.round(pt.midi)
    if (run && run.midi === m) run.end = pt.t
    else {
      if (run && run.end - run.start >= minSec) out.push(run)
      run = { midi: m, start: pt.t, end: pt.t }
    }
  }
  if (run && run.end - run.start >= minSec) out.push(run)
  return out
}

export default function HarmonyChart({
  userMidi,
  parts,
  contours,
  playhead,
  running,
  // Contour times are measured from the START OF THE FILE, but playhead is
  // measured from the FIRST SUNG NOTE. Without this the chart sits ~0.6s out of
  // step with what is actually heard.
  leadIn = 0,
}) {
  const canvasRef = useRef(null)
  const historyRef = useRef([]) // [{t, midi}] of the singer
  const rafRef = useRef(null)
  const drawRef = useRef(null)
  const stateRef = useRef({})

  // Assigned in an effect rather than during render — writing a ref while
  // rendering is a React anti-pattern, and the loop picks it up next frame.
  useEffect(() => {
    stateRef.current = { userMidi, parts, contours, playhead, running, leadIn }
  })

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
        const cutoff = s.playhead + LOOKAHEAD - WINDOW
        while (historyRef.current.length && historyRef.current[0].t < cutoff) {
          historyRef.current.shift()
        }
      }

      const t1 = (s.playhead ?? 0) + LOOKAHEAD
      const t0 = t1 - WINDOW
      const hist = historyRef.current

      // ---- vertical range covering both voices ----
      let lo = 127
      let hi = 0
      for (const p of s.parts ?? []) {
        for (const n of s.contours?.[p]?.notes ?? []) {
          const ns = n.t - s.leadIn
          if (ns + n.d < t0 || ns > t1) continue
          lo = Math.min(lo, n.midi)
          hi = Math.max(hi, n.midi)
        }
      }
      for (const pt of hist) {
        lo = Math.min(lo, pt.midi)
        hi = Math.max(hi, pt.midi)
      }
      if (lo > hi) { lo = 55; hi = 67 }
      lo -= 2
      hi += 2
      if (hi - lo < MIN_SPAN) {
        const mid = (hi + lo) / 2
        lo = mid - MIN_SPAN / 2
        hi = mid + MIN_SPAN / 2
      }
      if (hi - lo > MAX_SPAN) hi = lo + MAX_SPAN

      const padL = 30
      const x = (t) => padL + ((t - t0) / WINDOW) * (w - padL - 8)
      const y = (m) => h - 10 - ((m - lo) / (hi - lo)) * (h - 20)

      // ---- note grid, every semitone where there is room ----
      ctx.font = '9px ui-monospace, monospace'
      ctx.textBaseline = 'middle'
      const everySemitone = (h - 20) / (hi - lo) > 13
      for (let m = Math.ceil(lo); m <= hi; m += 1) {
        const name = noteName(m)
        const sharp = name.includes('#')
        if (!everySemitone && sharp) continue
        const yy = y(m)
        ctx.strokeStyle = sharp ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.11)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(padL, yy)
        ctx.lineTo(w - 8, yy)
        ctx.stroke()
        ctx.fillStyle = sharp ? 'rgba(255,255,255,0.30)' : 'rgba(255,255,255,0.65)'
        ctx.fillText(name, 4, yy)
      }

      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      // ---- ALZONA's line ----
      // Held notes become flat runs joined by smooth transitions, which is what
      // gives the curve its shape rather than a row of separate bars.
      for (const p of s.parts ?? []) {
        const notes = s.contours?.[p]?.notes ?? []
        const pts = []
        for (const n of notes) {
          const ns = n.t - s.leadIn
          const ne = ns + n.d
          if (ne < t0 || ns > t1) continue
          pts.push({ x: x(Math.max(ns, t0)), y: y(n.midi) })
          pts.push({ x: x(Math.min(ne, t1)), y: y(n.midi) })
        }
        if (pts.length < 2) continue
        ctx.strokeStyle = PART_COLORS[p] ?? '#f472b6'
        ctx.lineWidth = 5
        strokeSmooth(ctx, pts)
        for (const n of notes) {
          const ns = n.t - s.leadIn
          if (ns + n.d < t0 || ns > t1 || n.d < LABEL_MIN_SEC) continue
          label(ctx, fullName(n.midi), x(Math.max(ns, t0)) + 4, y(n.midi) - 8)
        }
      }

      // ---- the singer's line, on top ----
      if (hist.length > 1) {
        ctx.strokeStyle = USER_COLOR
        ctx.lineWidth = 5
        strokeSmooth(ctx, hist.map((pt) => ({ x: x(pt.t), y: y(pt.midi) })))
        for (const n of heldNotes(hist)) {
          label(ctx, fullName(n.midi), x(n.start) + 4, y(n.midi) - 8)
        }
        const last = hist[hist.length - 1]
        ctx.fillStyle = USER_COLOR
        ctx.beginPath()
        ctx.arc(x(last.t), y(last.midi), 5, 0, Math.PI * 2)
        ctx.fill()
      }

      // Only keep animating while a take is running. Idling on rAF pins a core
      // for nothing, and on the robot that competes with face detection.
      if (stateRef.current.running) {
        rafRef.current = requestAnimationFrame(draw)
      } else {
        rafRef.current = null
      }
    }

    drawRef.current = draw
    draw() // paint once so the empty grid is visible
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  useEffect(() => {
    if (running && !rafRef.current && drawRef.current) {
      rafRef.current = requestAnimationFrame(drawRef.current)
    } else if (!running && drawRef.current) {
      drawRef.current()
    }
  }, [running, parts, contours])

  const alzonaColor = parts?.length ? PART_COLORS[parts[0]] : PART_COLORS.alto
  return (
    <div>
      <canvas ref={canvasRef} className="h-56 w-full rounded-xl bg-black" />
      <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-5 rounded-full" style={{ background: USER_COLOR }} />
          <span className="font-semibold text-white/80">You</span>
        </span>
        {parts?.length ? (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-1.5 w-5 rounded-full"
              style={{ background: alzonaColor }}
            />
            <span className="text-white/70">ALZONA</span>
          </span>
        ) : (
          <span className="text-white/30">ALZONA joins once she hears you</span>
        )}
      </div>
    </div>
  )
}
