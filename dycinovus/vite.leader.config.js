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
 * Same plugin as vite.harmonizer.config.js, and for the same reason: this
 * program needs the recordings and nothing else the backend does, so with
 * these it runs on its own — no Python, no API key, no camera.
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

// "Harmonise With Me" — the ORIGINAL interaction, kept as its own program.
//
// She sounds the starting note, counts four beats, and begins; the singer comes
// in with her. That is the reverse of the sing-back harmoniser on 5180, where
// the singer starts and she finds her place — both are wanted, so both exist,
// and neither is a mode of the other.
//
//   npm run leader      -> http://localhost:5181
//
// Three ports, three programs, all able to run at once:
//   5173  the ALZONA console      (camera, chat, coin, Baybayin)
//   5180  sing back — she follows you
//   5181  harmonise with me — she leads
//
// A second config rather than a second npm project, so it reuses the
// node_modules already here; react and vite are slow to duplicate.
export default defineConfig({
  root: 'leader',
  plugins: [react(), tailwindcss(), harmonyMedia()],
  server: {
    // Deliberately not 5173 or 5180 — those belong to the other two.
    port: Number(process.env.PORT) || 5181,
    // A phone or another laptop on the same network should be able to reach it.
    // Note that over a plain http network address the browser blocks the
    // microphone — for singing, open it on localhost or put it behind https.
    host: true,
    fs: {
      // pitch.js lives in ../src and is imported from there rather than copied,
      // so the detector fixes are shared by all three programs. The chart and
      // the player ARE copied, because this program needs the original pair
      // that sound a reference note and count in — behaviour the console's
      // versions no longer have.
      allow: ['..'],
    },
  },
  build: {
    outDir: '../dist-leader',
    emptyOutDir: true,
  },
})
