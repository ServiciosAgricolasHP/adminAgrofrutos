// Parser de archivos CSV exportados del Registro de Compras y Ventas (RCV)
// del portal del SII. Estos archivos vienen con:
// - Separador: `;`
// - Encoding: UTF-8 con BOM (moderno) o ISO-8859-1 (legacy).
// - Primera fila: headers en español.
// - Una fila por documento.
//
// Detectamos automáticamente si es de ventas o compras inspeccionando los
// headers ("Rut cliente" vs "Rut Proveedor"). Devolvemos registros normalizados
// con el shape de `dteDocuments`. El doc id es determinístico (rutEmisor+tipo
// +folio) para que importar el mismo mes dos veces sea idempotente.

// Mapeo de tipos de DTE del SII. No cubre absolutamente todos los códigos
// existentes pero sí los más comunes para una operación agrícola/servicios.
export const DTE_TYPES = {
  29: "Factura de Inicio Electrónica",
  30: "Factura",
  32: "Factura No Afecta",
  33: "Factura Electrónica",
  34: "Factura Exenta Electrónica",
  35: "Boleta",
  38: "Boleta Exenta",
  39: "Boleta Electrónica",
  41: "Boleta Exenta Electrónica",
  43: "Liquidación Factura Electrónica",
  45: "Factura de Compra",
  46: "Factura de Compra Electrónica",
  48: "Pago Electrónico",
  50: "Guía de Despacho",
  52: "Guía de Despacho Electrónica",
  55: "Nota de Débito",
  56: "Nota de Débito Electrónica",
  60: "Nota de Crédito",
  61: "Nota de Crédito Electrónica",
  103: "Liquidación",
  110: "Factura de Exportación Electrónica",
  111: "Nota de Débito de Exportación Electrónica",
  112: "Nota de Crédito de Exportación Electrónica",
};

export function dteTypeLabel(tipo) {
  const t = Number(tipo);
  return DTE_TYPES[t] || `Tipo ${tipo}`;
}

// Tabla de "Códigos Otros Impuestos" del SII. La lista oficial cubre decenas
// de códigos (alcoholes, tabacos, bebidas, etc.); nos quedamos con los que
// efectivamente se ven en compras agrícolas + los de combustible (que son
// los que el usuario quería detectar para taggear automáticamente como
// "petróleo"). Para los códigos no mapeados, el helper devuelve solo el
// número crudo y la categoría queda en null.
//
// Códigos de combustibles (foco del usuario):
//   28  → Gasolinas automotrices
//   35  → Petróleo diésel (vehicular)
//   271 → Petróleo diésel (industrial)
//   272 → Otros petróleos
export const OTRO_IMP_CODES = {
  14: { label: "Bebidas analcohólicas",         category: "bebidas" },
  15: { label: "Cervezas, vinos, sidras",       category: "alcohol" },
  17: { label: "Bebidas analcohólicas azucar.", category: "bebidas" },
  19: { label: "Licores fina destilación",      category: "alcohol" },
  23: { label: "Pisco",                          category: "alcohol" },
  24: { label: "Licores",                        category: "alcohol" },
  25: { label: "Vinos",                          category: "alcohol" },
  26: { label: "Tabaco cigarrillos",             category: "tabaco" },
  27: { label: "Tabaco elaborado",               category: "tabaco" },
  28: { label: "Gasolinas automotrices",         category: "combustible" },
  29: { label: "Impuesto adicional",             category: "otros" },
  35: { label: "Petróleo diésel",                category: "combustible" },
  271: { label: "Petróleo diésel industrial",    category: "combustible" },
  272: { label: "Otros petróleos",               category: "combustible" },
};

// Mapeo categoría → display (emoji + color) usado en chips de la UI.
export const OTRO_IMP_CATEGORIES = {
  combustible: { emoji: "⛽", label: "Combustible", color: "danger" },
  alcohol:     { emoji: "🍷", label: "Alcohol",      color: "warning" },
  tabaco:      { emoji: "🚬", label: "Tabaco",       color: "warning" },
  bebidas:     { emoji: "🥤", label: "Bebidas",      color: "accent" },
  otros:       { emoji: "•",  label: "Otro impuesto", color: "muted" },
};

export function otroImpuestoLabel(code) {
  if (code == null || code === "") return null;
  const n = Number(code);
  if (!Number.isFinite(n) || n <= 0) return null;
  return OTRO_IMP_CODES[n]?.label || `Código ${n}`;
}

export function otroImpuestoCategory(code) {
  if (code == null || code === "") return null;
  const n = Number(code);
  if (!Number.isFinite(n) || n <= 0) return null;
  return OTRO_IMP_CODES[n]?.category || null;
}

// Decodifica el ArrayBuffer del archivo intentando UTF-8 primero. Si el
// resultado tiene caracteres de reemplazo (U+FFFD) que sugieren mojibake,
// reintenta con ISO-8859-1 (latin-1). Cubre los dos formatos comunes del SII.
function decodeFileBytes(buffer) {
  // Quitar BOM UTF-8 si está presente.
  const u8 = new Uint8Array(buffer);
  const hasBom = u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf;
  const body = hasBom ? u8.subarray(3) : u8;
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(body);
    // Heurística: si vemos el char de reemplazo es probable mojibake. Reintentar.
    if (utf8.includes("�")) {
      return new TextDecoder("iso-8859-1").decode(body);
    }
    return utf8;
  } catch {
    return new TextDecoder("iso-8859-1").decode(body);
  }
}

// Split de una línea CSV con separador `;`. El RCV del SII no usa quoting —
// los campos no contienen `;` ni `"`. Mantengo igual un parser que respeta
// quotes por si en algún caso aparecen comillas en razones sociales.
function splitCsvLine(line, sep = ";") {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === sep && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// El SII exporta montos como enteros sin separador de miles (ej. "119000")
// o con separador de miles "." y decimales con "," (ej. "1.234.567" o
// "1.234,50"). Normalizamos a Number.
function parseAmount(raw) {
  if (raw == null || raw === "") return 0;
  let s = String(raw).trim();
  if (s === "" || s === "-") return 0;
  // Si tiene coma decimal: tratar puntos como miles y coma como decimal.
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    // Si solo tiene puntos: si hay un solo punto y 1-2 dígitos después, es decimal;
    // sino son separadores de miles → removerlos.
    const m = s.match(/^-?\d+\.(\d{1,2})$/);
    if (!m) s = s.replace(/\./g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// Intenta extraer un RUT del nombre del archivo. El SII suele incluir el RUT
// del contribuyente en el filename de los exports del RCV (ej.
// `Detalle_VENTA_76123456-7_202405.csv`). Devuelve "" si no encuentra nada.
// Es heurística: si el usuario renombró el archivo no vamos a detectar nada,
// pero la mayoría de las veces el nombre original se preserva.
export function extractRutFromFilename(name) {
  if (!name) return "";
  // Captura `12345678-9` o `1234567-K` con o sin puntos.
  const m = String(name).match(/\b(\d{1,3}(?:\.\d{3}){0,2})-([\dKk])\b/) ||
            String(name).match(/\b(\d{7,8})-([\dKk])\b/);
  if (!m) return "";
  const num = m[1].replace(/\./g, "");
  return `${num}-${m[2].toUpperCase()}`;
}

// RUT chileno: normaliza a formato "12345678-9" (sin puntos, con guión).
// Si viene con DV separado por guión o pegado, lo dejamos consistente.
export function normalizeRut(rawRut) {
  if (!rawRut) return "";
  const s = String(rawRut).replace(/\./g, "").replace(/\s/g, "").toUpperCase();
  if (s.includes("-")) {
    const [num, dv] = s.split("-");
    return `${num}-${dv}`;
  }
  if (s.length < 2) return s;
  return `${s.slice(0, -1)}-${s.slice(-1)}`;
}

// RUT sin guión ni DV — sirve como parte del doc id para que dos formatos
// del mismo RUT no creen dos docs distintos.
export function rutNumeric(rawRut) {
  const s = String(rawRut || "").replace(/\./g, "").replace(/-/g, "").toUpperCase();
  return s.length > 1 ? s.slice(0, -1) : s;
}

// Builder del doc id de un DTE en Firestore. Combina companyId + kind + tipo +
// folio + (proveedor en compras) para que cada documento sea único globalmente
// dentro de la empresa. Reimportar el mismo período sobreescribe sin duplicar.
export function buildDteDocId({ companyId, kind, tipo, folio, rutEmisor, rutReceptor }) {
  if (!companyId) throw new Error("buildDteDocId requiere companyId");
  if (kind === "venta") {
    return `${companyId}_V_${tipo}_${folio}`;
  }
  // Compras: incluir proveedor (rutEmisor) porque dos proveedores pueden
  // tener el mismo folio en su propia secuencia.
  return `${companyId}_C_${rutNumeric(rutEmisor)}_${tipo}_${folio}`;
}

// Detecta si el header corresponde a ventas o compras. Estrategia:
// busca columnas distintivas. Si no detecta, devuelve null.
function detectKind(headers) {
  const h = headers.map((x) => x.toLowerCase());
  if (h.some((x) => x.includes("rut cliente"))) return "venta";
  if (h.some((x) => x.includes("rut proveedor"))) return "compra";
  // Fallback secundario: algunos exports usan "Tipo Venta" o "Tipo Compra".
  if (h.some((x) => x.includes("tipo venta"))) return "venta";
  if (h.some((x) => x.includes("tipo compra"))) return "compra";
  return null;
}

// Busca el índice de una columna por nombre (case-insensitive, contiene).
// Devuelve -1 si no la encuentra.
function colIdx(headers, ...needles) {
  const h = headers.map((x) => x.toLowerCase().trim());
  for (const n of needles) {
    const idx = h.findIndex((x) => x === n.toLowerCase() || x.includes(n.toLowerCase()));
    if (idx !== -1) return idx;
  }
  return -1;
}

// Parsea el ArrayBuffer del archivo y devuelve:
//   { kind: "venta"|"compra", records: [...], errors: [...], stats: {...} }
// Lanza si el header no se reconoce. Filas mal formadas pasan a `errors`.
export function parseSiiRcvCsv(buffer, { companyRut } = {}) {
  const text = decodeFileBytes(buffer);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error("El archivo está vacío.");
  }
  const headers = splitCsvLine(lines[0]);
  const kind = detectKind(headers);
  if (!kind) {
    throw new Error(
      "No se reconocen los encabezados del CSV. Esperado: archivo del RCV del SII (Registro de Compras y Ventas). " +
      `Headers encontrados: ${headers.slice(0, 5).join(", ")}...`,
    );
  }

  // Mapeo de columnas — el SII varía entre exports. Aceptamos varios nombres.
  const iTipo = colIdx(headers, "tipo doc", "tipo dte");
  const iFolio = colIdx(headers, "folio");
  const iFecha = colIdx(headers, "fecha docto", "fecha emision");
  const iRutContraparte = kind === "venta"
    ? colIdx(headers, "rut cliente")
    : colIdx(headers, "rut proveedor");
  const iRazon = colIdx(headers, "razon social");
  const iExento = colIdx(headers, "monto exento");
  const iNeto = colIdx(headers, "monto neto");
  const iIvaRec = colIdx(headers, "monto iva recuperable", "monto iva");
  const iIvaNoRec = colIdx(headers, "monto iva no recuperable");
  const iOtroImp = colIdx(headers, "valor otro imp");
  // Código del "Otro Impuesto" (ej. 28 gasolina, 35 diésel). Sirve para
  // taggear automáticamente compras de combustible — ver `OTRO_IMP_CODES`.
  const iOtroImpCod = colIdx(headers, "codigo otro imp", "código otro imp", "cod otro imp");
  const iTotal = colIdx(headers, "monto total");

  if (iTipo < 0 || iFolio < 0 || iFecha < 0 || iRutContraparte < 0 || iTotal < 0) {
    throw new Error(
      "Faltan columnas requeridas en el CSV (Tipo Doc, Folio, Fecha Docto, RUT, Monto Total).",
    );
  }

  const records = [];
  const errors = [];
  const stats = { byTipo: {}, totalAmount: 0, count: 0 };

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    try {
      const tipo = Number(cols[iTipo]);
      const folio = Number(cols[iFolio]);
      if (!Number.isFinite(tipo) || tipo <= 0) continue; // línea vacía / footer
      if (!Number.isFinite(folio) || folio <= 0) continue;
      const fechaRaw = cols[iFecha] || "";
      const fecha = normalizeFecha(fechaRaw);
      const rutContraparte = normalizeRut(cols[iRutContraparte] || "");
      const razon = (cols[iRazon] || "").trim();
      const exento = iExento >= 0 ? parseAmount(cols[iExento]) : 0;
      const neto = iNeto >= 0 ? parseAmount(cols[iNeto]) : 0;
      const ivaRec = iIvaRec >= 0 ? parseAmount(cols[iIvaRec]) : 0;
      const ivaNoRec = iIvaNoRec >= 0 ? parseAmount(cols[iIvaNoRec]) : 0;
      const otroImp = iOtroImp >= 0 ? parseAmount(cols[iOtroImp]) : 0;
      const otroImpCodRaw = iOtroImpCod >= 0 ? cols[iOtroImpCod] : "";
      const otroImpCod = otroImpCodRaw ? Number(String(otroImpCodRaw).trim()) || null : null;
      const total = parseAmount(cols[iTotal]);

      // En ventas el emisor somos nosotros (companyRut si lo pasaron, sino vacío
      // y se completa después en la UI); el receptor es la contraparte.
      // En compras es al revés.
      const rutEmisor = kind === "venta" ? (companyRut || "") : rutContraparte;
      const razonSocialEmisor = kind === "venta" ? "" : razon;
      const rutReceptor = kind === "venta" ? rutContraparte : (companyRut || "");
      const razonSocialReceptor = kind === "venta" ? razon : "";

      const periodo = fecha ? fecha.slice(0, 7) : "";

      // Sin id — el caller arma el id final cuando sabe el companyId
      // (vía `buildDteDocId`).
      const rec = {
        kind,
        tipo,
        tipoLabel: dteTypeLabel(tipo),
        folio,
        fechaEmision: fecha,
        periodo,
        rutEmisor,
        razonSocialEmisor,
        rutReceptor,
        razonSocialReceptor,
        exento,
        neto,
        iva: ivaRec + ivaNoRec,
        otrosImpuestos: otroImp,
        otroImpuestoCodigo: otroImpCod,
        otroImpuestoCategory: otroImpuestoCategory(otroImpCod),
        total,
        source: "sii_import",
      };
      records.push(rec);
      stats.byTipo[tipo] = (stats.byTipo[tipo] || 0) + 1;
      stats.totalAmount += total;
      stats.count++;
    } catch (err) {
      errors.push({ line: i + 1, raw: lines[i], message: err.message || String(err) });
    }
  }

  return { kind, headers, records, errors, stats };
}

// El SII a veces exporta fechas como YYYY-MM-DD, otras como DD/MM/YYYY o
// DD-MM-YYYY. Normalizamos siempre a YYYY-MM-DD (string).
function normalizeFecha(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return s; // dejamos lo que vino — la UI lo va a mostrar tal cual
}
