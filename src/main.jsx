import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

// Auto-recuperación cuando un import() dinámico falla porque el chunk al que
// apunta el `index.js` cacheado ya no existe en el server. Pasa después de
// cada deploy con PWA: el SW viejo sirve `index.js` cacheado que referencia
// hashes de chunks (ej. exceljs.min-XXXX.js) que el deploy nuevo ya reemplazó.
//
// El primer intento (solo reload) no alcanzaba: el mismo SW se mantenía
// activo en la nueva carga y volvía a servir el index viejo. Ahora antes de
// recargar limpiamos los caches del Workbox **y desregistramos los SW**, así
// la recarga le pega a la red y trae el index actualizado.
//
// Guard de 3 intentos en sessionStorage por si el problema es realmente del
// server (404 genuino) — sino entraríamos en loop infinito.
if (typeof window !== "undefined") {
  let recovering = false;
  const attemptsKey = "__preload_recover_attempts";
  window.addEventListener("vite:preloadError", async (event) => {
    if (recovering) return;
    const attempts = Number(sessionStorage.getItem(attemptsKey) || 0);
    if (attempts >= 3) return; // damos por perdido — el server está caído de verdad
    recovering = true;
    sessionStorage.setItem(attemptsKey, String(attempts + 1));
    event.preventDefault?.();
    try {
      // Borrar todos los caches del Workbox (precache + runtime).
      if ("caches" in window) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      }
      // Desregistrar todos los service workers — fuerza a que la próxima
      // navegación pida los assets directo a la red.
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch {
      /* noop — igual navegamos abajo */
    }
    // CRUCIAL: navegamos con un query param nuevo para bustear el HTTP cache
    // del navegador. `location.reload()` no alcanza porque sirve el index.html
    // cacheado por HTTP que sigue apuntando a los chunks viejos. Cambiar la
    // URL fuerza al browser a pedir el index fresh, y el header `?__v=` no
    // afecta ninguna ruta del router.
    const url = new URL(window.location.href);
    url.searchParams.set("__v", String(Date.now()));
    window.location.replace(url.toString());
  });
  // Cuando la nueva carga termina ok (sin disparar otro preloadError en los
  // primeros 5s), reseteamos el contador y limpiamos el query param. Si
  // llegamos hasta acá el fix anduvo.
  window.addEventListener("load", () => {
    setTimeout(() => {
      try { sessionStorage.removeItem(attemptsKey); } catch { /* noop */ }
      // Sacar el ?__v= de la URL para no dejar basura visible.
      const url = new URL(window.location.href);
      if (url.searchParams.has("__v")) {
        url.searchParams.delete("__v");
        window.history.replaceState({}, "", url.toString());
      }
    }, 5000);
  });
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
