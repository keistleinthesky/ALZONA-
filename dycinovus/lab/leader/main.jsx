import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './leader.css'
import Leader from './Leader.jsx'

// One panel, centred, nothing else on the page. The console has the camera and
// the chat; this program does one thing.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <div className="mx-auto w-full max-w-2xl p-4 sm:p-8">
      <header className="mb-4">
        <p className="text-xs uppercase tracking-[0.35em] text-white/40">ALZONA</p>
        <h1 className="mt-1 text-2xl font-bold text-white">Harmonise With Me</h1>
        <p className="mt-1 text-sm text-white/50">
          She sounds your starting note, counts you in, and begins. Come in with
          her and hold your line against hers.
        </p>
      </header>
      <Leader />
    </div>
  </StrictMode>,
)
