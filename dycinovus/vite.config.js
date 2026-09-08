import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Respect an assigned port (e.g. from preview tooling); default to 5173.
    port: Number(process.env.PORT) || 5173,
    // Listen on every interface so the robot, a phone or a judge's laptop can
    // reach the demo. The backend already binds 0.0.0.0; without this the site
    // itself was the only half that stayed on this machine.
    host: true,
  },
})
