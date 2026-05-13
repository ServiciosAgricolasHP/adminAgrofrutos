// Combo = (calidad, envase). Stored as `${qualityX}_${containerY}` keys.
// Catalogs come from the global catalogs collection (via CatalogsContext).

export const COSECHA_MODES = [
  { value: "unit", label: "Por unidad (qty × precio/día)" },
  { value: "flat", label: "Por día fijo (mismo monto, qty informativo)" },
];

export const comboKey = (x, y) => `${x}_${y}`;

export const parseComboKey = (key) => {
  const [x, y] = String(key).split("_").map(Number);
  return { x: x || 0, y: y || 0 };
};

export const qualityLabel = (catalogs, x) => {
  const cat = catalogs?.qualities || [];
  return cat.find((q) => q.value === x)?.label || `Calidad ${x}`;
};

export const containerLabel = (catalogs, y) => {
  const cat = catalogs?.containers || [];
  return cat.find((c) => c.value === y)?.label || `Envase ${y}`;
};

// Unidad a mostrar para totales/métricas de cosecha. Si todos los workdays
// usaron el mismo envase (saco, caja, kilo…), usamos su label del catálogo;
// si hay mezcla devolvemos un genérico para no sumar unidades distintas.
export const cosechaUnit = (catalogs, containersSet) => {
  if (!containersSet || containersSet.size === 0) return "Unid.";
  if (containersSet.size === 1) return containerLabel(catalogs, [...containersSet][0]);
  return "Unid.";
};

export const tratoTypeLabel = (catalogs, t) => {
  const cat = catalogs?.tratoTypes || [];
  return cat.find((e) => e.value === t)?.label || `Trato ${t}`;
};

export const comboLabel = (catalogs, x, y) =>
  `${qualityLabel(catalogs, x)} / ${containerLabel(catalogs, y)}`;

// Returns active combos for a (laborId, date), with backward compat:
// - old format dayPrices[laborId][date] = { price, mode } → treat as 0_0
// - missing entry → fallback single 0_0 with price 0 + default mode
export function getDayCombos(dayPrices, laborId, date, defaultMode = "unit") {
  const entry = dayPrices?.[laborId]?.[date];
  if (!entry || typeof entry !== "object") {
    return [{ key: "0_0", x: 0, y: 0, price: 0, mode: defaultMode }];
  }
  if ("price" in entry || "mode" in entry) {
    return [{
      key: "0_0", x: 0, y: 0,
      price: Number(entry.price) || 0,
      mode: entry.mode || defaultMode,
    }];
  }
  const out = [];
  for (const [k, v] of Object.entries(entry)) {
    if (!/^\d+_\d+$/.test(k)) continue;
    const { x, y } = parseComboKey(k);
    out.push({
      key: k, x, y,
      price: Number(v?.price) || 0,
      mode: v?.mode || defaultMode,
    });
  }
  if (!out.length) return [{ key: "0_0", x: 0, y: 0, price: 0, mode: defaultMode }];
  out.sort((a, b) => a.x - b.x || a.y - b.y);
  return out;
}

// Returns the single per-day price config for a non-combo labor (trato).
// Reads dayPrices[laborId][date]["0_0"] or legacy {price,mode}.
export function getDaySingle(dayPrices, laborId, date, defaultMode = "unit") {
  const entry = dayPrices?.[laborId]?.[date];
  if (!entry || typeof entry !== "object") return { price: 0, mode: defaultMode };
  if ("price" in entry || "mode" in entry) {
    return { ...entry, price: Number(entry.price) || 0, mode: entry.mode || defaultMode };
  }
  const v = entry["0_0"];
  if (!v) return { price: 0, mode: defaultMode };
  return { ...v, price: Number(v.price) || 0, mode: v.mode || defaultMode };
}

export function normalizeDayPricesEntry(entry) {
  if (!entry || typeof entry !== "object") return {};
  if ("price" in entry || "mode" in entry) {
    return { "0_0": { price: Number(entry.price) || 0, mode: entry.mode || "unit" } };
  }
  return entry;
}

export const workdayDocId = (cycleId, laborId, rut, date, ck = "0_0") =>
  ck === "0_0"
    ? `${cycleId}__${laborId}__${rut}__${date}`
    : `${cycleId}__${laborId}__${rut}__${date}__${ck}`;

export const workdayMapKey = (rut, date, ck = "0_0") =>
  `${rut}__${date}__${ck}`;

// ============================================================
// Multi-price tier helpers for "trato" labors
// ============================================================

// Normalize legacy dayPrices entry to tier-based format.
// Legacy: { price, mode } or { "0_0": { price, mode } }
// New: { t0: { price, mode }, t1: { price, mode }, ... }
export function normalizeTratoDayPrices(entry, defaultMode = "unit") {
  if (!entry || typeof entry !== "object") return { t0: { price: 0, mode: defaultMode } };
  // Already has tier keys (t0, t1, etc.)
  if (Object.keys(entry).some((k) => k.startsWith("t") && /^\d+$/.test(k.slice(1)))) return entry;
  // Legacy { price, mode }
  if ("price" in entry || "mode" in entry) {
    return { t0: { price: Number(entry.price) || 0, mode: entry.mode || defaultMode } };
  }
  // Legacy { "0_0": { price, mode } }
  const single = entry["0_0"];
  if (single) return { t0: { price: Number(single.price) || 0, mode: single.mode || defaultMode } };
  return { t0: { price: 0, mode: defaultMode } };
}

// Get price tiers for a labor+date from dayPrices.
// Returns [{key: "t0", index: 0, price, mode}, ...]
export function getTratoTiers(dayPrices, laborId, date, defaultMode = "unit") {
  const entry = dayPrices?.[laborId]?.[date];
  const normalized = normalizeTratoDayPrices(entry, defaultMode);
  return Object.entries(normalized)
    .filter(([k]) => k.startsWith("t") && /^\d+$/.test(k.slice(1)))
    .map(([k, v]) => ({ key: k, index: Number(k.slice(1)), price: Number(v?.price) || 0, mode: v?.mode || defaultMode }))
    .sort((a, b) => a.index - b.index);
}

// Normalize legacy workday record to tier-based format.
// Legacy: { qty, amount }
// New: { tiers: { "0": { qty, amount } }, totalAmount }
export function normalizeTratoWorkday(wd) {
  if (!wd) return wd;
  if (wd.tiers) return wd;
  const qty = Number(wd.qty) || 0;
  const amount = Number(wd.amount) || 0;
  return { ...wd, tiers: { "0": { qty, amount } }, totalAmount: amount };
}

// Get total qty and amount from a workday record (supports both legacy and new format)
export function getTratoTierTotals(wd) {
  if (!wd) return { qty: 0, amount: 0 };
  if (wd.tiers) {
    let qty = 0, amount = 0;
    for (const t of Object.values(wd.tiers)) {
      qty += Number(t?.qty) || 0;
      amount += Number(t?.amount) || 0;
    }
    return { qty, amount };
  }
  return { qty: Number(wd.qty) || 0, amount: Number(wd.amount) || 0 };
}
