import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// "Chord finder" — the genetic-algorithm harmoniser, as a page.
//
// A third program alongside the console (5173) and the live harmoniser (5180),
// and the only one of the three that needs nothing at all: no backend, no API
// key, no recordings, no microphone, no network. Everything it does is
// arithmetic over ../src/chordGA.js.
//
//   npm run chordga     -> http://localhost:5181
//
// Kept as another config rather than another npm project for the same reason
// the harmoniser is: react and vite are a slow install to duplicate, and the
// musical code in ../src should exist exactly once.
export default defineConfig({
  root: 'chordga',
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.PORT) || 5181,
    host: true,
    fs: {
      // chordGA.js, harmonyBrain.js, melodyText.js and the synth all live in
      // ../src and are imported from there rather than copied.
      allow: ['..'],
    },
  },
  build: {
    outDir: '../dist-chordga',
    emptyOutDir: true,
  },
})
