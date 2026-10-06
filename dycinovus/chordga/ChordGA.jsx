import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FUNCTION,
  WEIGHTS,
  barCongruence,
  chordsFrom,
  evolveSteps,
  fitness,
  keyOf,
  toBars,
} from '../src/chordGA'
import { PITCH_CLASSES } from '../src/harmonyBrain'
import { PRESETS, parseMelody } from '../src/melodyText'
import { ChordSynth } from '../src/chordSynth'

// =============================================================================
// CHORD FINDER — a genetic algorithm looking for the chords under a melody.
// =============================================================================
// Type a tune; watch a few hundred random progressions breed themselves into
// one that works; hear it.
//
// The page is built around showing the search rather than only its answer,
// because the answer alone is indistinguishable from a lookup table. So the
// generations are stepped one animation frame at a time instead of being run in
// a single blocking call — the whole thing takes about a second either way, and
// a second of watching a progression assemble itself out of noise is the only
// part of this that explains what a genetic algorithm is.
//
// The other half of the page is the fitness function, exposed as six sliders.
// That is where all the musical opinion lives, and the sliders are here so the
// opinion can be argued with: pull IDIOM to zero and the diminished chords come
// straight back.
//
// Runs on nothing. No backend, no API key, no recordings, no network.

// Chord function, coloured. Tonic is home, subdominant is the journey out,
// dominant is the tension — three colours is enough to see the shape of a
// progression at a glance, which seven chord names are not.
const FUNCTION_COLOR = { T: '#34d399', S: '#38bdf8', D: '#fbbf24' }
const FUNCTION_NAME = { T: 'tonic', S: 'subdominant', D: 'dominant' }
const MELODY_COLOR = '#fbbf24'

const TERMS = {
  congruence: 'melody notes are chord tones, weighted by length and stress',
  flow: 'tonic → subdominant → dominant → tonic, and V never falls back to IV',
  cadence: 'it opens at home and, above all, closes properly',
  variety: 'not the same chord twelve times',
  motion: 'roots that move by fifths and steps rather than sitting still',
  idiom: 'chords people actually play — diminished triads are rare',
}

const GENERATIONS = 80
const PER_FRAME = 2 // generations per animation frame: ~1.3s for the full run

export default function ChordGA() {
  const [preset, setPreset] = useState(PRESETS[0].name)
  const [text, setText] = useState(PRESETS[0].text)
  const [beatsPerBar, setBeatsPerBar] = useState(PRESETS[0].beatsPerBar)
  const [weights, setWeights] = useState(WEIGHTS)
  const [seed, setSeed] = useState(7)
  const [bpm, setBpm] = useState(96)
  const [hear, setHear] = useState({ melody: true, chords: true })

  const [step, setStep] = useState(null) // the latest generation, or null
  const [searching, setSearching] = useState(false)
  const [playhead, setPlayhead] = useState(null) // in beats, while sounding

  const frameRef = useRef(0)
  const genRef = useRef(null)
  const synthRef = useRef(null)
  const tickRef = useRef(0)

  // --- what the text currently means -----------------------------------------
  const { melody, errors } = useMemo(() => parseMelody(text), [text])
  const bars = useMemo(() => toBars(melody, beatsPerBar), [melody, beatsPerBar])
  const key = useMemo(() => (melody.length ? keyOf(melody) : null), [melody])

  // Emptying the text box should clear the chart. Derived rather than done from
  // an effect, because an effect would mean a render whose only job is to undo
  // the render before it — and one frame of chords belonging to a melody that
  // is no longer on screen.
  const shown = melody.length ? step : null

  const chords = useMemo(
    () => (shown && key ? chordsFrom(shown.genome, key, { beatsPerBar }) : []),
    [shown, key, beatsPerBar],
  )
  const parts = useMemo(
    () => (shown && key ? fitness(shown.genome, bars, key, { beatsPerBar, weights }).parts : null),
    [shown, bars, key, beatsPerBar, weights],
  )

  // The best each bar could possibly do, so the congruence readout can say
  // "0.55 of a possible 0.62" instead of implying 1.0 was ever available. On a
  // stepwise tune it very much is not, and without this the number looks like a
  // failure when it is the melody talking.
  const ceiling = useMemo(() => {
    if (!key || !bars.length) return null
    let sum = 0
    let n = 0
    for (const bar of bars) {
      const best = Math.max(...[0, 1, 2, 3, 4, 5, 6].map((d) => barCongruence(bar, d, key, beatsPerBar) ?? 0))
      if (bar.length) { sum += best; n += 1 }
    }
    return n ? sum / n : null
  }, [bars, key, beatsPerBar])

  // --- the search ------------------------------------------------------------
  const stopSearch = useCallback(() => {
    cancelAnimationFrame(frameRef.current)
    genRef.current = null
    setSearching(false)
  }, [])

  const search = useCallback(() => {
    if (!key || !bars.length) return
    cancelAnimationFrame(frameRef.current)
    genRef.current = evolveSteps(bars, key, {
      beatsPerBar,
      weights,
      seed,
      generations: GENERATIONS,
    })

    // Nothing here sets state. The search is kicked off from an effect, and a
    // synchronous setState there is a render whose only purpose is to schedule
    // the next one; every update below happens inside an animation frame
    // instead, which is where the work is happening anyway.
    const frame = () => {
      const gen = genRef.current
      if (!gen) return
      let latest = null
      let finished = false
      for (let i = 0; i < PER_FRAME; i += 1) {
        const next = gen.next()
        if (next.done) { finished = true; break }
        latest = next.value
      }
      // Draw whatever this frame produced BEFORE reacting to the generator
      // ending. Several generations run per frame, so the last one is usually
      // yielded in the same frame that then runs out — dropping it on the floor
      // left the page reporting generation 79 of 80 forever.
      if (latest) {
        setSearching(true)
        // The generator yields its live history array; copying it here keeps
        // React's identity check honest without the generator allocating one
        // array per generation for callers that do not draw anything.
        setStep({ ...latest, history: [...latest.history] })
      }
      if (finished) { setSearching(false); genRef.current = null; return }
      frameRef.current = requestAnimationFrame(frame)
    }
    frameRef.current = requestAnimationFrame(frame)
  }, [bars, key, beatsPerBar, weights, seed])

  // Re-run whenever the question changes. The search is deterministic, so this
  // is not a fidget: the same melody, weights and seed always give the same
  // chart back, and a slider that only took effect on a button press would look
  // like it had done nothing.
  useEffect(() => {
    if (!melody.length) return undefined
    search()
    return () => cancelAnimationFrame(frameRef.current)
  }, [search, melody.length])

  // --- sound -----------------------------------------------------------------
  const synth = useCallback(() => {
    if (!synthRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      synthRef.current = new ChordSynth(new Ctx())
    }
    const s = synthRef.current
    if (s.ctx.state === 'suspended') s.ctx.resume()
    return s
  }, [])

  const stopSound = useCallback(() => {
    cancelAnimationFrame(tickRef.current)
    synthRef.current?.stop()
    setPlayhead(null)
  }, [])

  const play = useCallback(() => {
    if (!melody.length) return
    const s = synth()
    s.play(melody, chords, { bpm, parts: hear, onEnded: () => { setPlayhead(null) } })
    const tick = () => {
      if (!s.playing) { setPlayhead(null); return }
      setPlayhead(s.beat)
      tickRef.current = requestAnimationFrame(tick)
    }
    tickRef.current = requestAnimationFrame(tick)
  }, [melody, chords, bpm, hear, synth])

  useEffect(() => () => { stopSound(); cancelAnimationFrame(frameRef.current) }, [stopSound])

  const loadPreset = (p) => {
    stopSound()
    setPreset(p.name)
    setText(p.text)
    setBeatsPerBar(p.beatsPerBar)
  }

  const totalBeats = melody.reduce((sum, n) => sum + (n.beats ?? 1), 0)

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-5 px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.2em] text-emerald-400/70">
            ALZONA · generative harmony
          </div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-white">
            Chord finder
          </h1>
          <p className="mt-1.5 max-w-xl text-sm text-white/45">
            A genetic algorithm searching for the chords under a melody. It
            knows no songs — only six opinions about what makes a progression
            good, and several million progressions to try them on.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Stat label="Key" value={key ? `${PITCH_CLASSES[key.tonic]} ${key.mode}` : '—'} />
          <Stat label="Bars" value={bars.length || '—'} />
          <Stat
            label="Fitness"
            value={shown ? shown.score.toFixed(3) : '—'}
            tone={searching ? 'searching' : 'done'}
          />
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => loadPreset(p)}
            className={`rounded-xl border px-3.5 py-2 text-sm transition ${
              preset === p.name && text === p.text
                ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
                : 'border-white/10 bg-white/5 text-white/60 hover:border-white/20 hover:text-white/90'
            }`}
          >
            {p.name}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 text-xs text-white/40">
          <span>Beats per bar</span>
          {[2, 3, 4, 6].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setBeatsPerBar(n)}
              className={`h-8 w-8 rounded-lg border text-sm transition ${
                beatsPerBar === n
                  ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
                  : 'border-white/10 bg-white/5 text-white/50 hover:text-white/80'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </section>

      <section>
        <textarea
          value={text}
          onChange={(e) => { stopSound(); setText(e.target.value) }}
          spellCheck={false}
          rows={3}
          className="w-full resize-y rounded-2xl border border-white/10 bg-black/40 px-4 py-3
                     font-mono text-sm leading-relaxed text-white/85 outline-none
                     placeholder:text-white/25 focus:border-emerald-400/40"
          placeholder="C4 C4 G4 G4 | A4 A4 G4:2"
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="text-white/30">
            Note plus octave. <span className="font-mono text-white/45">:2</span> for a
            two-beat note, <span className="font-mono text-white/45">-</span> for a rest.
            Barlines are ignored — type them wherever they help you read.
          </span>
          {errors.length > 0 && (
            <span className="text-amber-300/80">
              skipping {errors.map((e) => `“${e.token}”`).join(', ')}
            </span>
          )}
          <span className="ml-auto font-mono text-white/25">
            {melody.length} notes · {totalBeats} beats
          </span>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      <Chart
        melody={melody}
        chords={chords}
        bars={bars}
        beatsPerBar={beatsPerBar}
        totalBeats={totalBeats}
        playhead={playhead}
        onStrike={(chord) => synth().strike(chord.midi)}
      />

      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={playhead === null ? play : stopSound}
          disabled={!melody.length}
          className={`rounded-2xl px-7 py-3.5 text-base font-semibold text-white shadow-lg transition
            disabled:cursor-not-allowed disabled:opacity-30
            ${playhead === null
              ? 'bg-emerald-500 shadow-emerald-500/20 hover:bg-emerald-400'
              : 'bg-rose-500 shadow-rose-500/20 hover:bg-rose-400'}`}
        >
          {playhead === null ? 'Play' : 'Stop'}
        </button>

        <div className="flex items-center gap-1.5">
          {['melody', 'chords'].map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setHear((h) => ({ ...h, [k]: !h[k] }))}
              className={`rounded-xl border px-3 py-2 text-sm capitalize transition ${
                hear[k]
                  ? 'border-white/20 bg-white/10 text-white/90'
                  : 'border-white/5 bg-transparent text-white/30'
              }`}
            >
              {k}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-xs text-white/40">
          <span className="w-10">{bpm} bpm</span>
          <input
            type="range" min={50} max={160} value={bpm}
            onChange={(e) => setBpm(Number(e.target.value))}
            className="w-32 accent-emerald-400"
          />
        </label>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => { setSeed((s) => s + 1) }}
            className="rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-sm
                       text-white/60 transition hover:border-white/20 hover:text-white/90"
          >
            Search again
          </button>
          <button
            type="button"
            onClick={searching ? stopSearch : search}
            className="rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-sm
                       text-white/60 transition hover:border-white/20 hover:text-white/90"
          >
            {searching ? 'Halt' : 'Re-run'}
          </button>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
        <Search step={shown} searching={searching} />
        <Weights
          weights={weights}
          parts={parts}
          ceiling={ceiling}
          onChange={(k, v) => setWeights((w) => ({ ...w, [k]: v }))}
          onReset={() => setWeights(WEIGHTS)}
        />
      </section>

      <footer className="text-[11px] leading-relaxed text-white/25">
        The chords are diatonic triads only — no sevenths, no borrowed chords,
        no key changes. Everything the search believes about music is in the six
        sliders above, and nothing else is consulted: it has never heard this
        tune or any other.
      </footer>
    </main>
  )
}

// -----------------------------------------------------------------------------
// The chart
// -----------------------------------------------------------------------------
/**
 * Melody above, chords below, on one shared timeline.
 *
 * The detail that makes it worth drawing rather than listing: a melody note is
 * filled when it belongs to the chord under it and hollow when it does not. The
 * congruence term is the one the search spends most of its effort on and the
 * one whose number means least on its own — hollow notes show you exactly where
 * the compromises landed, and usually show that they landed on passing notes,
 * which is what a musician would have done too.
 */
function Chart({ melody, chords, bars, beatsPerBar, totalBeats, playhead, onStrike }) {
  const PPB = 30 // pixels per beat
  const TOP = 18
  const STAVE = 190 // height given to the melody
  const CHORDS = 76
  const width = Math.max(640, totalBeats * PPB)
  const height = TOP + STAVE + CHORDS

  const pitches = melody.filter((n) => n.midi != null).map((n) => n.midi)
  const lo = pitches.length ? Math.min(...pitches) - 2 : 59
  const hi = pitches.length ? Math.max(...pitches) + 2 : 72
  const y = (midi) => TOP + STAVE - ((midi - lo) / Math.max(1, hi - lo)) * (STAVE - 24) - 12

  // Which chord is sounding at a given beat, so a note can ask whether it fits.
  const chordAt = (beat) => chords[Math.min(chords.length - 1, Math.floor(beat / beatsPerBar))]

  const notes = melody.reduce((acc, note, i) => {
    const previous = acc[acc.length - 1]
    acc.push({
      ...note,
      i,
      at: previous ? previous.at + previous.beats : 0,
      beats: note.beats ?? 1,
    })
    return acc
  }, [])

  return (
    <section className="overflow-x-auto rounded-2xl border border-white/10 bg-black">
      <svg width={width} height={height} className="block">
        {/* bars */}
        {bars.map((_, i) => (
          <g key={i}>
            <rect
              x={i * beatsPerBar * PPB} y={0}
              width={beatsPerBar * PPB} height={TOP + STAVE}
              fill={i % 2 ? 'rgba(255,255,255,0.022)' : 'transparent'}
            />
            <line
              x1={i * beatsPerBar * PPB} y1={0}
              x2={i * beatsPerBar * PPB} y2={TOP + STAVE}
              stroke="rgba(255,255,255,0.09)" strokeWidth={1}
            />
          </g>
        ))}

        {/* melody */}
        {notes.map((note) => {
          if (note.midi == null) return null
          const chord = chordAt(note.at + 0.001)
          const fits = chord ? chord.pitchClasses.includes(((note.midi % 12) + 12) % 12) : true
          return (
            <rect
              key={note.i}
              x={note.at * PPB + 2}
              y={y(note.midi) - 5}
              width={Math.max(6, note.beats * PPB - 4)}
              height={10}
              rx={5}
              fill={fits ? MELODY_COLOR : 'transparent'}
              stroke={MELODY_COLOR}
              strokeWidth={fits ? 0 : 1.5}
              strokeDasharray={fits ? undefined : '3 2'}
              opacity={fits ? 0.95 : 0.55}
            />
          )
        })}

        {/* chords */}
        {chords.map((chord) => {
          const colour = FUNCTION_COLOR[FUNCTION[chord.degree]]
          const x = chord.startBeat * PPB
          const w = chord.beats * PPB
          return (
            <g
              key={chord.bar}
              onClick={() => onStrike(chord)}
              style={{ cursor: 'pointer' }}
            >
              <rect
                x={x + 2} y={TOP + STAVE + 6}
                width={w - 4} height={CHORDS - 18} rx={10}
                fill={colour} fillOpacity={0.13}
                stroke={colour} strokeOpacity={0.35}
              />
              <text
                x={x + w / 2} y={TOP + STAVE + 34}
                textAnchor="middle" fill={colour}
                fontSize={17} fontWeight={600}
              >
                {chord.name}
              </text>
              <text
                x={x + w / 2} y={TOP + STAVE + 50}
                textAnchor="middle" fill="rgba(255,255,255,0.4)"
                fontSize={12} fontFamily="Georgia, 'Times New Roman', serif"
                letterSpacing={0.5}
              >
                {chord.roman}
              </text>
            </g>
          )
        })}

        {/* playhead */}
        {playhead !== null && playhead >= 0 && (
          <line
            x1={playhead * PPB} y1={0} x2={playhead * PPB} y2={height}
            stroke="#fff" strokeOpacity={0.55} strokeWidth={1.5}
          />
        )}
      </svg>
    </section>
  )
}

// -----------------------------------------------------------------------------
// The search, as it happens
// -----------------------------------------------------------------------------
function Search({ step, searching }) {
  const history = step?.history ?? []
  const W = 100
  const H = 34
  const lo = history.length ? Math.min(...history) : 0
  const hi = history.length ? Math.max(...history) : 1
  const span = Math.max(1e-6, hi - lo)
  const path = history
    .map((v, i) => {
      const x = (i / Math.max(1, history.length - 1)) * W
      return `${i ? 'L' : 'M'}${x.toFixed(2)},${(H - ((v - lo) / span) * H).toFixed(2)}`
    })
    .join(' ')

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-white/80">The search</h2>
        <span className="font-mono text-xs text-white/35">
          {step ? `generation ${step.generation} / ${step.generations}` : 'idle'}
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-3 h-16 w-full">
        <path d={path} fill="none" stroke="#34d399" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
      </svg>

      <p className="mt-1 text-[11px] text-white/30">
        Best fitness in the population, generation by generation. It only ever
        climbs — the best few progressions are copied into the next generation
        untouched, so a good one can never be lost to the same mutation that was
        meant to be exploring.
      </p>

      <div className="mt-4 grid grid-cols-3 gap-2 font-mono text-[11px]">
        <Cell label="best" value={step ? step.score.toFixed(3) : '—'} />
        <Cell label="this gen" value={step ? step.thisGeneration.toFixed(3) : '—'} />
        <Cell
          label="distinct"
          value={step ? step.spread : '—'}
          hint="different progressions left in the population"
        />
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-white/30">
        {searching
          ? 'Breeding…'
          : !step
            ? 'Type a melody to start.'
            : step.spread <= 4
              ? 'Converged — the population has collapsed onto a single answer. '
                + '"Search again" re-seeds it and looks somewhere else.'
              : `Settled: ${step.spread} different progressions are still alive, but `
                + 'none of them has beaten the best one for a while. "Search again" '
                + 'starts over from a different random crowd.'}
      </p>
    </div>
  )
}

// -----------------------------------------------------------------------------
// The fitness function, as six arguments you can have
// -----------------------------------------------------------------------------
function Weights({ weights, parts, ceiling, onChange, onReset }) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0)
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-white/80">What it is looking for</h2>
        <button
          type="button"
          onClick={onReset}
          className="text-xs text-white/35 underline-offset-2 hover:text-white/70 hover:underline"
        >
          reset
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-3">
        {Object.keys(TERMS).map((k) => {
          const scored = parts?.[k]
          const share = total > 0 ? weights[k] / total : 0
          return (
            <div key={k}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm capitalize text-white/75">{k}</span>
                <span className="font-mono text-[11px] text-white/35">
                  {scored != null ? scored.toFixed(2) : '—'}
                  {k === 'congruence' && ceiling != null && (
                    <span className="text-white/20"> / {ceiling.toFixed(2)} possible</span>
                  )}
                  <span className="text-white/20"> · weight {Math.round(share * 100)}%</span>
                </span>
              </div>
              <input
                type="range" min={0} max={0.6} step={0.01} value={weights[k]}
                onChange={(e) => onChange(k, Number(e.target.value))}
                className="mt-1 w-full accent-emerald-400"
              />
              <p className="mt-0.5 text-[11px] leading-snug text-white/30">{TERMS[k]}</p>
            </div>
          )
        })}
      </div>

      <div className="mt-4 flex gap-3 text-[11px] text-white/30">
        {Object.entries(FUNCTION_NAME).map(([f, name]) => (
          <span key={f} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: FUNCTION_COLOR[f] }}
            />
            {name}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-3 rounded-full border border-dashed"
            style={{ borderColor: MELODY_COLOR }}
          />
          note outside the chord
        </span>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
function Stat({ label, value, tone }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-2">
      <div className="text-[10px] uppercase tracking-widest text-white/35">{label}</div>
      <div
        className={`mt-0.5 font-mono text-lg ${
          tone === 'searching' ? 'text-emerald-300' : 'text-white/85'
        }`}
      >
        {value}
      </div>
    </div>
  )
}

function Cell({ label, value, hint }) {
  return (
    <div className="rounded-lg bg-white/5 px-3 py-2" title={hint}>
      <div className="text-white/35">{label}</div>
      <div className="mt-0.5 text-white">{value}</div>
    </div>
  )
}
