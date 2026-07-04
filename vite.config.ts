import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// WebGPU + transformers.js need a crossOriginIsolated context for WASM
// threads/SharedArrayBuffer. These headers turn that on for both `vite dev`
// and `vite preview`. Consequence: any cross-origin asset fetched at runtime
// (Hugging Face CDN, Cloudflare R2, etc.) MUST respond with CORS headers
// (Cross-Origin-Resource-Policy / Access-Control-Allow-Origin) or the
// isolated page will refuse to load it.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: crossOriginIsolationHeaders },
  preview: { headers: crossOriginIsolationHeaders },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      // Manual registration (src/main.ts calls navigator.serviceWorker.register
      // directly) instead of the virtual:pwa-register client helper: that
      // helper wraps workbox-window's Workbox class, and Vite 8's Rolldown
      // bundler cannot resolve workbox-window from a virtual module under
      // pnpm's strict node_modules layout (it's a transitive dep of
      // vite-plugin-pwa, not hoisted to the root). Plain registration needs
      // no bundling of that package at all.
      injectRegister: null,
      manifest: {
        name: 'Helius',
        short_name: 'Helius',
        description: 'The AI that works when nothing else does — offline navigation & signaling agent',
        theme_color: '#0a0e14',
        background_color: '#0a0e14',
        display: 'standalone',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\.pmtiles/,
            handler: 'CacheFirst',
            options: { cacheName: 'map-data' },
          },
          {
            urlPattern: /\.(onnx|onnx_data|bin|wasm)$/,
            handler: 'CacheFirst',
            options: { cacheName: 'ml-models', expiration: { maxEntries: 30 } },
          },
        ],
      },
    }),
  ],
});
