import { createReadStream, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// The recorded SATB takes, their contours and the lyric timings.
const SOURCE = path.resolve(HERE, '..', 'source')

const TYPES = {
  '.mp3': 'audio/mpeg',
  '.json': 'application/json',
  '.wav': 'audio/wav',
}

/**
 * Serve `source/` at /media, the same path the backend mounts it on.
 *
 * The point is that sing-back needs the recordings but nothing else the
 * backend does, so with this it runs on its own — no Python, no API key. The
 * paths match `main.py`'s mount exactly, so harmonyPlayer.js works unchanged
 * whether it is talking to this or to the real backend.
 */
function harmonyMedia() {
  return {
    name: 'harmony-media',
    configureServer(server) {
      server.middlewares.use('/media', (req, res, next) => {
        const rel = decodeURIComponent((req.url || '').split('?')[0])
        const file = path.join(SOURCE, rel)
        // Never let a crafted path climb out of source/.
        if (!file.startsWith(SOURCE)) { res.statusCode = 403; res.end(); return }
        let stat
        try { stat = statSync(file) } catch { next(); return }
        if (!stat.isFile()) { next(); return }
        res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream')
        res.setHeader('Content-Length', stat.size)
        createReadStream(file).pipe(res)
      })
    },
  }
}

// "Sing with me" — a separate program from the ALZONA console.
//
// Its own root, its own port, its own page. The console keeps 5173 and is not
// touched by this at all; the two share the audio engine in ../src, which is
// why `fs.allow` has to reach one level up.
//
//   npm run harmonizer     -> http://localhost:5180
//
// Kept as a second config rather than a second npm project so it reuses the
// node_modules already here — react and vite are a slow install to duplicate.
export default defineConfig({
  root: 'harmonizer',
  plugins: [react(), tailwindcss(), harmonyMedia()],
  server: {
    // Deliberately NOT 5173. That belongs to the console, and both should be
    // able to run at the same time.
    port: Number(process.env.PORT) || 5180,
    // A phone or another laptop on the same network should be able to reach
    // it. Note that over a plain http network address the browser blocks the
    // microphone — for singing, open it on localhost or put it behind https.
    host: true,
    fs: {
      // The audio engine lives in ../src and is imported from there rather
      // than copied, so there is exactly one of it.
      allow: ['..'],
    },
    proxy: {
      // The one thing this cannot do alone: turning sung words into a lyric
      // line needs the backend's transcription. Proxied rather than called
      // cross-origin so there is no CORS to configure, and entirely optional —
      // if the backend is down the app says so and matches on pitch alone.
      '/listen': {
        target: process.env.ALZONA_BACKEND || 'http://127.0.0.1:5002',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist-harmonizer',
    emptyOutDir: true,
  },
})
