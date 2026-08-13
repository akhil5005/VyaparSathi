import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * No dev proxy, deliberately.
 *
 * It would be easy to proxy /api to localhost:4000 and make development
 * same-origin, but production is not same-origin — the app is served from
 * app.<domain> and the API from api.<domain>. Proxying would hide every CORS
 * and cookie problem until deploy day. Pointing the dev server straight at the
 * API instead means development exercises the same cross-origin path, preflight
 * and all.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
