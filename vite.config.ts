import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// WebGPU + transformers.js need a crossOriginIsolated context for WASM
// threads/SharedArrayBuffer. These headers turn that on for both `vite dev`
// and `vite preview` — matching prod exactly (public/_headers sets the same
// COOP/COEP trio for Cloudflare Pages, plus a Cache-Control: no-cache on
// /index.html and /sw.js that dev doesn't need, since the dev/preview
// servers don't cache responses the way a CDN edge does):
//
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: credentialless
//
// credentialless (not require-corp) because R2's public bucket doesn't send
// Cross-Origin-Resource-Policy headers — require-corp would hard-block
// those fetches, while credentialless lets cross-origin no-cors loads
// through with credentials stripped (fine: R2/HF CDN assets are public, no
// cookies involved). This used to be require-corp in dev only, which meant
// R2/HF loads could fail locally while working in prod — changed to match
// prod so dev accurately reflects what will actually happen there.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
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
            // pmtiles are consumed via Range requests; a cached 206 is useless
            // and workbox won't cache it anyway. The app "pack warm-up" does a
            // FULL GET once (cacheable 200); rangeRequests then slices that
            // cached full body to answer offline Range reads.
            urlPattern: /\.pmtiles/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-data',
              cacheableResponse: { statuses: [200] },
              rangeRequests: true,
            },
          },
          {
            // onnx_data_1/_2… suffixes: split >2GB weight files (E4B decoder)
            urlPattern: /\.(onnx|onnx_data(_\d+)?|bin|wasm)$/,
            handler: 'CacheFirst',
            options: { cacheName: 'ml-models', expiration: { maxEntries: 60 } },
          },
          {
            // map glyphs + sprites (too many/too big to precache all fontstacks)
            urlPattern: /\/vendor\/(fonts|sprites)\//,
            handler: 'CacheFirst',
            options: { cacheName: 'map-assets', expiration: { maxEntries: 400 } },
          },
          {
            // region-pack metadata (pois/peaks/graph manifests)
            urlPattern: /\/data\/packs\/.*\.(json|geojson)$/,
            handler: 'CacheFirst',
            options: { cacheName: 'pack-data' },
          },
        ],
      },
    }),
  ],
});
