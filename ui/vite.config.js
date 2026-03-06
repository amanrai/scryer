import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:7654',
      '/drops': 'http://localhost:7654',
      '/socket.io': {
        target: 'http://localhost:5055',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
})
