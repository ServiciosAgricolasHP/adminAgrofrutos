// Helpers del tipo de labor "tratoEtapas" (trato por etapas).
//
// Un labor por etapas define una lista fija de etapas (solo nombre + si cuenta
// para producción). El PRECIO de cada etapa es variable por día, igual que en
// trato: se configura en la barra de precios por día. Ejemplo (carpas):
//   stages: [
//     { id, name: "Preparación", counts: false },
//     { id, name: "Instalación", counts: true  },
//     { id, name: "Completo",    counts: true  },
//   ]
//   dayPrices[laborId][date] = { [stageId]: { price, mode } }   // "unit" | "flat"
//
// La regla de oro (viven las dos sumas acá para que ningún consumidor la
// reinvente y el conteo no se descontrole):
//   • PAGO      = Σ (qty × precio del día) de TODAS las etapas.
//   • UNIDADES  = Σ qty solo de las etapas con `counts === true`.
//
// Preparación paga pero no suma unidades; instalación y completo sí. Cada
// unidad física se carga una sola vez (por etapas o como completo), así que no
// hay doble conteo.

export function newStageId() {
  // Id único y estable: se genera en handlers (agregar etapa / abrir modal),
  // no en render, así que Date.now + random es seguro y evita colisiones con
  // ids ya persistidos entre recargas de página.
  return `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function defaultStages() {
  return [
    { id: newStageId(), name: "Preparación", counts: false },
    { id: newStageId(), name: "Instalación", counts: true },
  ];
}

// Normaliza la lista de etapas: descarta entradas sin nombre y garantiza al
// menos una marcada como `counts` (si ninguna lo está, marca la última — no
// tiene sentido un labor por etapas donde nada cuenta para producción).
export function normalizeStages(stages) {
  const list = (Array.isArray(stages) ? stages : [])
    .map((s) => ({
      id: s.id || newStageId(),
      name: String(s.name || "").trim(),
      counts: !!s.counts,
    }))
    .filter((s) => s.name);
  if (list.length > 0 && !list.some((s) => s.counts)) {
    list[list.length - 1].counts = true;
  }
  return list;
}

export function stageById(labor, stageId) {
  const stages = Array.isArray(labor?.stages) ? labor.stages : [];
  return stages.find((s) => String(s.id) === String(stageId)) || null;
}

export function countingStageIds(labor) {
  const stages = Array.isArray(labor?.stages) ? labor.stages : [];
  return new Set(stages.filter((s) => s.counts).map((s) => String(s.id)));
}

// Precio configurado de una etapa en un día. Devuelve { price, mode }.
export function getStageDayPrice(dayPrices, laborId, date, stageId) {
  const entry = dayPrices?.[laborId]?.[date]?.[stageId];
  return { price: Number(entry?.price) || 0, mode: entry?.mode === "flat" ? "flat" : "unit" };
}

// Monto de un día para una etapa: qty × precio (o precio fijo si mode === flat).
export function computeStageDayAmount(mode, price, qty) {
  const q = Number(qty) || 0;
  const p = Number(price) || 0;
  if (mode === "flat") return q > 0 ? p : 0;
  return q * p;
}

// Etapas de un día con su precio/modo resueltos: [{ id, name, counts, price, mode }].
// El orden respeta el de las etapas del labor.
export function getDayStages(labor, dayPrices, date) {
  const stages = normalizeStages(labor?.stages);
  return stages.map((s) => {
    const p = getStageDayPrice(dayPrices, labor.id, date, s.id);
    return { ...s, price: p.price, mode: p.mode };
  });
}

// Totales de un conjunto de workdays de un labor por etapas.
// `workdays`: array de workday docs (con `stageId`, `qty`, `amount`).
// Devuelve { pago, unidades }.
export function getEtapasTotals(labor, workdays) {
  const counting = countingStageIds(labor);
  let pago = 0;
  let unidades = 0;
  for (const wd of workdays || []) {
    pago += Number(wd?.amount) || 0;
    if (counting.has(String(wd?.stageId ?? ""))) {
      unidades += Number(wd?.qty) || 0;
    }
  }
  return { pago, unidades };
}
