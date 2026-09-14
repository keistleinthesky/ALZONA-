import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './src/index.css'
import App from './src/App.jsx'
import Leader from './leader/Leader.jsx'

// A COPY of the console on 5174, for trying things out.
//
// Everything it uses lives under lab/ — its own src/, its own leader/. That is
// the whole point: the consoles on 5173 and 5174 share one src/, so a change
// made to try something there would land in both of them mid-demo. Nothing
// edited in here can reach either.
//
// The cost is the usual cost of a copy: a fix made out there does not arrive in
// here. When something in this folder is worth keeping, move it into src/
// rather than leaving the two to drift.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App SingPanel={Leader} />
  </StrictMode>,
)
