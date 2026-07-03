import { toBlob, toPng } from "html-to-image";

// Captura un nodo a PNG (Blob o dataUrl) sin que el resultado quede cortado
// por el scroll horizontal del contenedor visible. Especialmente importante
// en mobile o cuando el modal contiene una tabla más ancha que la pantalla.
//
// Estrategia: clonar el nodo a un wrapper off-screen (position: fixed a
// -99999px), sacar el overflow de TODOS los descendientes para que las
// tablas se rendereen en su ancho natural, capturar el clon expandido,
// remover el wrapper. El nodo original queda intacto — cero flicker visual.
//
// Acepta options que se pasan a html-to-image (backgroundColor, pixelRatio,
// cacheBust, etc). Los defaults son white bg + pixelRatio 2 (nítido en HDPI).
async function _captureExpanded(node, captureFn, options = {}) {
  if (!node) throw new Error("captureFullWidth: node vacío");
  const clone = node.cloneNode(true);
  const wrapper = document.createElement("div");
  wrapper.style.cssText =
    "position: fixed; left: -99999px; top: 0; pointer-events: none; background: #ffffff; z-index: -1;";
  // Background explícito por si el nodo original heredaba de un padre oscuro.
  clone.style.background = options.backgroundColor || "#ffffff";
  clone.style.maxWidth = "none";
  clone.style.width = "max-content";
  wrapper.appendChild(clone);
  document.body.appendChild(wrapper);
  try {
    // Todos los descendientes: overflow visible + sin max-width. Cubre divs
    // con overflow-x-auto, tablas dentro de contenedores estrechos, etc.
    const all = clone.querySelectorAll("*");
    all.forEach((el) => {
      el.style.overflow = "visible";
      el.style.overflowX = "visible";
      el.style.overflowY = "visible";
      el.style.maxWidth = "none";
    });
    // Un frame para que el reflow del clon se aplique antes de medir.
    await new Promise((r) => requestAnimationFrame(r));
    const w = clone.scrollWidth;
    const h = clone.scrollHeight;
    return await captureFn(clone, {
      backgroundColor: "#ffffff",
      pixelRatio: 2,
      ...options,
      width: w,
      height: h,
    });
  } finally {
    if (wrapper.parentNode) document.body.removeChild(wrapper);
  }
}

// Variante que devuelve Blob — pensada para navigator.clipboard.write().
export function captureFullWidthBlob(node, options) {
  return _captureExpanded(node, toBlob, options);
}

// Variante que devuelve dataUrl string — pensada para descargar como archivo
// via link.href = dataUrl + link.click().
export function captureFullWidthDataUrl(node, options) {
  return _captureExpanded(node, toPng, options);
}
