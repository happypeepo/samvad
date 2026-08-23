import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // noise-protocol / sodium-javascript expect Node's Buffer + process globals
    nodePolyfills({
      globals: { Buffer: true, process: true },
    }),
    react(),
  ],
  server: {
    host: true, // expose on LAN so a phone on the same network can hit the dev server
  },
})
