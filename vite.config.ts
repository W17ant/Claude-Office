import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // The built app is always served from an origin root: Vite on 3333 in dev,
  // the office server on 3334 after `vite build` (it mounts dist/ at /, and
  // the packaged desktop app loads http://127.0.0.1:3334/). Sprite and room
  // URLs in src/ are absolute ('/sprites/...'), so a relative base would not
  // make the bundle relocatable anyway — keep the root base explicit.
  base: '/',
  server: {
    port: 3333,
    // Fail instead of drifting to 3335 when 3333 is busy: the Electron dev
    // window, start-office.sh and the server's origin allowlist all expect 3333.
    strictPort: true,
    proxy: {
      '/ws': {
        target: 'ws://localhost:3334',
        ws: true,
      },
    },
  },
})
