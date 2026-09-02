import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Respect an assigned port (e.g. from preview tooling); default to 5173.
    port: Number(process.env.PORT) || 5173,
  },
})
