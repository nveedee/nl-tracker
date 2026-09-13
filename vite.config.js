import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite-Dev-Server (Port 5173) mit Proxy auf den Express-API-Server (Port 3001).
// So spricht das Frontend im Dev-Modus einfach mit /api/... und muss keinen
// zweiten Port kennen.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
