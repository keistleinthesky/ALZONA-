import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/index.css'
import App from '../src/App.jsx'
import Leader from '../leader/Leader.jsx'

// The full ALZONA console — camera, chat, coin, Baybayin — with the ORIGINAL
// singing panel: she sounds the starting note, counts four beats and begins,
// and the singer comes in with her.
//
// The console on 5173 is this same App with the panel that follows the singer
// instead. Nothing else differs, and nothing is copied, so the two cannot
// drift apart as the shared features change.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App SingPanel={Leader} />
  </StrictMode>,
)
