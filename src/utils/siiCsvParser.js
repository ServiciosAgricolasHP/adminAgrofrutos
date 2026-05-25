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

// RUT sin guión ni DV — sirve como prefijo del doc id para que dos formatos
// del mismo RUT no creen dos docs distintos.
function rutNumeric(rawRut) {
  const s = String(rawRut || "").replace(/\./g, "").replace(/-/g, "").toUpperCase();
  return s.length > 1 ? s.slice(0, -1) : s;
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
      const total = parseAmount(cols[iTotal]);

      // En ventas el emisor somos nosotros (companyRut si lo pasaron, sino vacío
      // y se completa después en la UI); el receptor es la contraparte.
      // En compras es al revés.
      const rutEmisor = kind === "venta" ? (companyRut || "") : rutContraparte;
      const razonSocialEmisor = kind === "venta" ? "" : razon;
      const rutReceptor = kind === "venta" ? rutContraparte : (companyRut || "");
      const razonSocialReceptor = kind === "venta" ? razon : "";

      // Doc id determinístico — clave natural del documento desde el lado del
      // emisor. Si no hay rutEmisor (porque no nos pasaron companyRut en venta),
      // usamos un fallback con el RUT del receptor — no es ideal, pero permite
      // distinguir docs entre sí dentro del mismo período.
      const idPrefix = rutNumeric(rutEmisor) || `R${rutNumeric(rutReceptor)}`;
      const id = `${idPrefix}_${tipo}_${folio}`;

      const periodo = fecha ? fecha.slice(0, 7) : "";

      const rec = {
        id,
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
