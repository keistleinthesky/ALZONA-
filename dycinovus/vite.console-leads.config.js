import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The ALZONA console, with the ORIGINAL singing panel.
//
// The same full website as the one on 5173 — camera, chat, coin, Baybayin —
// differing in one thing: she sounds the starting note, counts four beats and
// begins, and the singer comes in with her. On 5173 the singer starts and she
// finds her place.
//
//   npm run console-leads   -> http://localhost:5174
//
// Both consoles talk to the SAME backend on 5002, so they can be open side by
// side and swapped between mid-demo without restarting anything. They share
// one App and one src/ — only the entry file differs — so a change to any
// other feature lands in both.
//
// Ports, all able to run at once:
//   5173  console, she follows you
//   5174  console, she leads          <- this
//   5180  sing back, panel only, no backend
//   5181  harmonise with me, panel only, no backend
export default defineConfig({
  root: 'console-leads',
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.PORT) || 5174,
    // A phone or another laptop on the same network should be able to reach it.
    // Note that over a plain http network address the browser blocks the
    // microphone — for singing, open it on localhost or put it behind https.
    host: true,
    fs: {
      // App, the shared panels and the stylesheet all live one level up; they
      // are imported from there rather than copied, so there is one of each.
      allow: ['..'],
    },
  },
  // The favicon and anything else static still comes from the project root.
  publicDir: '../public',
  build: {
    outDir: '../dist-console-leads',
    emptyOutDir: true,
  },
})
