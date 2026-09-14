import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// A COPY of the console on 5174, to make changes in.
//
//   npm run lab      -> http://localhost:5175
//
// Self-contained on purpose. The consoles on 5173 and 5174 are one App with two
// entry points, sharing src/ — which is right for them, because a fix to the
// camera or the coin panel should reach both. It is wrong for a workbench: a
// change made here to try something would land in both consoles, and the whole
// reason this exists is to leave 5174 alone.
//
// So lab/ carries its own src/ and its own leader/, and nothing in it is
// imported from outside. The cost is the cost of any copy — a fix made out
// there does not arrive in here. When something in this folder is worth
// keeping, move it into src/ rather than letting the two drift apart.
//
// Ports, all able to run at once:
//   5173  console, she follows you
//   5174  console, she leads
//   5175  a copy of 5174 to change      <- this
//   5180  sing back, panel only, no backend
//   5181  harmonise with me, panel only, no backend
export default defineConfig({
  root: 'lab',
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.PORT) || 5175,
    // A phone or another laptop on the same network should be able to reach it.
    // Note that over a plain http network address the browser blocks the
    // microphone — for singing, open it on localhost or put it behind https.
    host: true,
  },
  // The favicon and anything else static still comes from the project root.
  publicDir: '../public',
  build: {
    outDir: '../dist-lab',
    emptyOutDir: true,
  },
})
