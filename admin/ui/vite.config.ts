import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 4301,
    proxy: { '/api': 'http://localhost:4300' },   // dev: hit the running admin server
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
})
