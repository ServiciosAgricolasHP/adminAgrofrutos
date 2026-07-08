// Conectores comunes en nombres propios en español que quedan en minúscula
// cuando aparecen en el medio del nombre ("Juan de la Cruz"). En la primera
// posición sí se capitalizan ("De la Torre").
const CONNECTORS = new Set(["de", "del", "la", "las", "los", "y", "e", "da", "do", "dos", "das"]);

// Convierte un string a "Nombre Propio". Preserva tildes y ñ. Maneja separadores
// comunes: espacio, guión ("Ana-María"), apóstrofe ("D'Angelo").
//
// A diferencia de `normalizeName` en importWorkers.js — que quita tildes para
// matcheo — este helper es para display/persistencia: mantiene lo que el
// usuario tipeó, solo arregla el casing.
export function toProperName(input) {
  if (!input) return "";
  const collapsed = String(input).trim().replace(/\s+/g, " ").toLowerCase();
  if (!collapsed) return "";
  return collapsed
    .split(" ")
    .map((word, idx) => {
      if (idx > 0 && CONNECTORS.has(word)) return word;
      return word.replace(/(^|[\-'])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
    })
    .join(" ");
}
