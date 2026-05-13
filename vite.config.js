import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/adminAgrofrutos/',   // ← ESTO ES CLAVE
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
        orientation: 'portrait',
        scope: '/adminAgrofrutos/',
        start_url: '/adminAgrofrutos/',
        icons: [
          { src: 'logo.png', sizes: '192x192', type: 'image/png' },
          { src: 'logo.png', sizes: '512x512', type: 'image/png' },
          { src: 'logo.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // Precachea todos los assets del build (JS/CSS/HTML/imgs).
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // El bundle de exceljs es >2MB, sube el limite para que entre.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // No interceptamos llamadas a Firestore — el SDK ya maneja su propio
        // cache en IndexedDB. Tampoco el navigation fallback para no romper
        // el truco 404.html → index.html?/... de GitHub Pages.
        navigateFallback: null,
        runtimeCaching: [
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