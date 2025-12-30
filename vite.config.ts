import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client'
  },
  server: {
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:3001'
    }
  }
})
