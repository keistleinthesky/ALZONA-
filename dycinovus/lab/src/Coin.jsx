import { useState } from 'react'

// =============================================================================
// COIN IDENTIFICATION
// =============================================================================
// Hold a coin up to the camera; the backend grabs the current frame, sends it to
// Gemini vision, and returns five one-sentence fields. Rendering them as fixed
// rows (rather than free prose) keeps the demo readable at a glance and makes a
// missing field obvious.

// The placeholder rows shown before the first scan. Authenticity leads: nothing
// below it is worth reading until we know the coin is genuine.
//
// After a scan the panel renders whatever the BACKEND returned instead of this
// list, because a counterfeit deliberately comes back short — describing a
// fake's denomination or history would be describing the real coin it is
// imitating, not the object on the camera.
const FIELD_ORDER = [
  { key: 'authenticity', label: 'Real or Fake', emoji: '\u{1F50E}' },
  { key: 'other_countries', label: 'Used Elsewhere', emoji: '\u{1F30D}' },
  { key: 'country', label: 'Nationality / Country', emoji: '\u{1F4D6}' },
  { key: 'denomination', label: 'Currency & Denomination', emoji: '\u{1F4B0}' },
  { key: 'featured', label: 'Person / Symbol Featured', emoji: '\u{1F464}' },
  { key: 'significance', label: 'Historical & Cultural Significance', emoji: '\u{1F3DB}' },
]

export default function Coin({ baseUrl, fields, verdict, onResult }) {
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
        onResult?.(null, null, null)
        return
      }
      onResult?.(data.fields, data.tts_url ? `${baseUrl}${data.tts_url}` : null,
                 data.verdict)
    } catch (err) {
      console.error('Coin identify failed:', err)
      setError('Backend unreachable.')
    } finally {
      setBusy(false)
    }
  }

  // Follow the backend once it has answered; the fixed list is only the empty
  // state. Rows it leaves out are ones it declined to assess, not missing data.
  const rows = fields?.length ? fields : FIELD_ORDER
  const fake = /^fake$/i.test(verdict || '')

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
        {rows.map(({ key, label, emoji, text }) => {
          const got = text ? { text } : null
          return (
            <div
              key={key}
              className={`rounded-xl border px-3 py-2 ${
                fake && key === 'authenticity'
                  ? 'border-rose-400/40 bg-rose-500/10'
                  : 'border-white/10 bg-black/20'
              }`}
            >
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
