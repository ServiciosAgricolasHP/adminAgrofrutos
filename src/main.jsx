import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

// Auto-reload cuando un import() dinámico falla porque el chunk al que apunta
// el `index.js` cacheado ya no existe en el server. Pasa después de cada
// deploy con PWA: el SW sirve `index.js` viejo que referencia hashes de
// chunks (ej. exceljs.min-XXXX.js) que el deploy nuevo ya reemplazó.
// Vite emite `vite:preloadError` en ese caso — un reload trae el index nuevo
// que apunta a los hashes vigentes.
if (typeof window !== "undefined") {
  let reloaded = false;
  const sessionKey = "__preload_reload_at";
  window.addEventListener("vite:preloadError", (event) => {
    if (reloaded) return;
    // Evitar loop infinito si el reload no resuelve (ej. el server realmente
    // está caído). Solo recargamos una vez por minuto.
    const last = Number(sessionStorage.getItem(sessionKey) || 0);
    if (Date.now() - last < 60_000) return;
    reloaded = true;
    sessionStorage.setItem(sessionKey, String(Date.now()));
    event.preventDefault?.();
    window.location.reload();
  });
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
