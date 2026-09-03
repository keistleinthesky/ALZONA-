import { useState } from 'react'

// =============================================================================
// COIN IDENTIFICATION
// =============================================================================
// Hold a coin up to the camera; the backend grabs the current frame, sends it to
// Gemini vision, and returns five one-sentence fields. Rendering them as fixed
// rows (rather than free prose) keeps the demo readable at a glance and makes a
// missing field obvious.

const FIELD_ORDER = [
  { key: 'country', label: 'Nationality / Country', emoji: '🇵🇭🇭🇷' },
  { key: 'denomination', label: 'Currency & Denomination', emoji: '💰' },
  { key: 'featured', label: 'Person / Symbol Featured', emoji: '👤' },
  { key: 'significance', label: 'Historical & Cultural Significance', emoji: '🏛️' },
  // Judgements about the coin rather than descriptions of it, so they sit
  // apart from the four categories above.
  { key: 'authenticity', label: 'Real or Fake', emoji: '🔎' },
  { key: 'other_countries', label: 'Used Elsewhere', emoji: '🌍' },
]

export default function Coin({ baseUrl, fields, onResult }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const identify = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`${baseUrl}/identify_coin`, { method: 'POST' })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || 'Could not identify the coin.')
        onResult?.(null, null)
        return
      }
      onResult?.(data.fields, data.tts_url ? `${baseUrl}${data.tts_url}` : null)
    } catch (err) {
      console.error('Coin identify failed:', err)
      setError('Backend unreachable.')
    } finally {
      setBusy(false)
    }
  }

  // Show whatever the backend returned, falling back to the fixed order so the
  // five rows are always visible even before the first scan.
  const byKey = Object.fromEntries((fields || []).map((f) => [f.key, f]))

  return (
    <section className="rounded-2xl border border-white/10 bg-[rgba(255,255,255,0.06)] p-4 shadow-2xl shadow-black/20 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-white/50">Camera</p>
          <h2 className="mt-1 text-lg font-bold text-white">Coin Identification</h2>
        </div>
        <div className="rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-xs font-semibold text-amber-200">
          /identify_coin
        </div>
      </div>

      <button
        type="button"
        onClick={identify}
        disabled={busy}
        className="mt-3 w-full rounded-xl bg-amber-500 px-4 py-3 text-sm font-bold text-[#171457] transition hover:bg-amber-400 disabled:opacity-50"
      >
        {busy ? 'Reading the coin…' : 'Identify coin in view'}
      </button>

      {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}

      <div className="mt-3 space-y-2">
        {FIELD_ORDER.map(({ key, label, emoji }) => {
          const got = byKey[key]
          return (
            <div key={key} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
              <p className="text-[10px] uppercase tracking-widest text-white/40">
                {emoji} {label}
              </p>
              <p className={`mt-1 text-sm ${got ? 'text-white' : 'text-white/25'}`}>
                {got?.text || '—'}
              </p>
            </div>
          )
        })}
      </div>
    </section>
  )
}
