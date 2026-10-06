import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './chordga.css'
import ChordGA from './ChordGA.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ChordGA />
  </StrictMode>,
)
