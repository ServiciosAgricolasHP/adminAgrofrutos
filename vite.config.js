import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { execSync } from 'node:child_process'

// Auto-bump del patch a partir del count de commits en HEAD. Cada commit que
// llega a main suma uno. Si la build corre fuera de un repo git (ej: CI con
// shallow clone), caemos a "0" para que el build no falle.
const commitCount = (() => {
  try {
    return execSync('git rev-list --count HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || '0'
  } catch {
    return '0'
  }
})()
const APP_VERSION = `v1.0.${commitCount}`

export default defineConfig({
  base: '/adminAgrofrutos/',   // ← ESTO ES CLAVE
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler']],
      },
    }),
    tailwindcss(),
    VitePWA({
      // autoUpdate: el service worker se actualiza solo cuando se hace deploy
      // de una version nueva. Sin prompt al usuario.
      registerType: 'autoUpdate',
      includeAssets: ['logo.png', '404.html'],
      manifest: {
        name: 'Agrofrutos',
        short_name: 'Agrofrutos',
        description: 'Admin Agrofrutos — faenas, calendario, nomina',
        theme_color: '#16a34a',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'any',
        scope: '/adminAgrofrutos/',
        start_url: '/adminAgrofrutos/',
        icons: [
          { src: 'logo.png', sizes: '192x192', type: 'image/png' },
          { src: 'logo.png', sizes: '512x512', type: 'image/png' },
          { src: 'logo.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // Precachea SOLO assets estables (imgs, fonts, íconos). NO incluimos
        // js/css/html porque esos son los que cambian cada deploy (con hash
        // en el nombre) y eran los que dejaban al usuario atascado con
        // chunks borrados — el SW servía un index.js viejo que apuntaba a
        // un exceljs.min-XXXX.js que el deploy nuevo ya borró.
        // Ahora esos archivos van por NetworkFirst (ver runtimeCaching), así
        // siempre que haya red el navegador trae lo último.
        globPatterns: ['**/*.{ico,png,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // Que el SW nuevo tome control de los tabs abiertos en cuanto activa,
        // sin esperar a que se cierren — sino los usuarios con la pestaña
        // abierta pueden quedar con el SW viejo controlando.
        skipWaiting: true,
        clientsClaim: true,
        navigateFallback: null,
        runtimeCaching: [
          {
            // HTML / JS / CSS de la app: NetworkFirst. Si la red anda, trae
            // lo último (cierra el bug de chunks borrados). Si la red falla
            // o tarda más de 3s, usa el cache para mantener offline parcial.
            urlPattern: ({ request }) =>
              request.destination === 'document' ||
              request.destination === 'script' ||
              request.destination === 'style',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'app-shell',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
          {
            // Logo y otros assets externos (firebase storage, etc.) si los hay.
            urlPattern: /^https:\/\/firebasestorage\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'firebase-storage',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      devOptions: {
        // No habilitamos el SW en dev — interfiere con HMR.
        enabled: false,
      },
    }),
  ],
})