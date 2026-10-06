import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './harmonizer.css'
import Harmonizer from './Harmonizer.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Harmonizer />
  </StrictMode>,
)
