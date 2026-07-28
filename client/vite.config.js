import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The FastAPI app in ../api serves its routes at the root (/emails, /summarize,
// /health), so the client's /api prefix is stripped on the way through. Going
// via the proxy also keeps the browser on one origin, so CORS never applies.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  }
})
