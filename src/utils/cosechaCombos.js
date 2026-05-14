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

// Piso = bono fijo asignable a un trabajador en un día cuando la producción
// fue baja. Vive como un workday separado con `comboKey: "_piso"` y
// `pisoOnly: true`. Opt-in por día: se configura solo en los días que
// realmente lo necesitan (boton "+ piso" en el panel de Precios).
export const PISO_COMBO_KEY = "_piso";

export const getDayPiso = (dayPrices, laborId, date) => {
  const entry = dayPrices?.[laborId]?.[date];
  if (!entry || typeof entry !== "object") return null;
  const raw = entry.piso;
  return raw == null ? null : Number(raw) || 0;
};

export const effectivePiso = (labor, dayPrices, date) =>
  Number(getDayPiso(dayPrices, labor?.id, date)) || 0;

export const tratoTypeLabel = (catalogs, t) => {
  const cat = catalogs?.tratoTypes || [];
  return cat.find((e) => e.value === t)?.label || `Trato ${t}`;
};

// Unidad de medida de un workday de trato (Metro / Polín / Planta / etc.). La
// unidad vive en el config de precios del día (`dayPrices[labor][date].tN.unit`)
// junto al precio. Devuelve el índice si está, o `null` si no fue configurada
// — el display puede caer a "Unidad" o simplemente omitirla.
export const tratoUnitLabel = (catalogs, u) => {
  if (u == null) return null;
  const cat = catalogs?.tratoUnits || [];
  return cat.find((e) => e.value === u)?.label || `Unidad ${u}`;
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
    .map(([k, v]) => ({
      key: k,
      index: Number(k.slice(1)),
      price: Number(v?.price) || 0,
      mode: v?.mode || defaultMode,
      // Unidad de medida del trato para ese día/tier. `null` o `undefined` =
      // sin unidad configurada (display ocultará la etiqueta).
      unit: v?.unit ?? null,
    }))
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

// Formato compacto del precio configurado para (labor, día). Devuelve un
// string corto tipo "$300/árbol" para mostrar bajo el header de la fecha en
// los resúmenes / comprobantes. Para cosecha cubre combos calidad×envase.
// Para trato prioriza la `unit` del tier (Árbol/Metro/…) sobre el tratoType
// (Poda/Amarre/…). Devuelve "" si no hay precio configurado.
//
// Convención: el resultado NO incluye prefijo de moneda mas allá del $ — se
// pega tal cual a una etiqueta visual sin necesitar reformatear.
const _fmtMoneyShort = (v) => "$" + (Number(v) || 0).toLocaleString("es-CL");

export function formatLaborDayPrice(labor, date, dayPrices, catalogs = {}) {
  if (!labor) return "";
  if (labor.type === "cosecha") {
    const combos = getDayCombos(dayPrices, labor.id, date, "unit");
    if (!combos.length) return "";
    if (combos.length === 1) {
      const c = combos[0];
      if (!c.price) return "";
      if (c.mode === "flat") return `${_fmtMoneyShort(c.price)}/día`;
      const unit = containerLabel(catalogs, c.y).toLowerCase();
      return `${_fmtMoneyShort(c.price)}/${unit}`;
    }
    return combos
      .filter((c) => c.price)
      .map((c) => {
        const lbl = comboLabel(catalogs, c.x, c.y);
        if (c.mode === "flat") return `${lbl}: ${_fmtMoneyShort(c.price)}/día`;
        return `${lbl}: ${_fmtMoneyShort(c.price)}`;
      })
      .join(" · ");
  }
  if (labor.type === "trato") {
    const tiers = getTratoTiers(dayPrices, labor.id, date, "unit");
    const used = tiers.filter((t) => t.price);
    if (!used.length) return "";
    const unitFor = (t) => {
      const u = t.unit;
      const label = u == null ? null : tratoUnitLabel(catalogs, u);
      if (label) return label.toLowerCase();
      return tratoTypeLabel(catalogs, labor.tratoType ?? 0).toLowerCase();
    };
    if (used.length === 1) {
      const t = used[0];
      if (t.mode === "flat") return `${_fmtMoneyShort(t.price)}/día`;
      return `${_fmtMoneyShort(t.price)}/${unitFor(t)}`;
    }
    return used.map((t) => `T${t.index + 1}: ${_fmtMoneyShort(t.price)}/${unitFor(t)}`).join(" · ");
  }
  if (labor.type === "main" || labor.type === "supervision" || labor.type === "extra") {
    const cfg = getDaySingle(dayPrices, labor.id, date, "normal");
    const price = Number(cfg?.price) || Number(labor.baseDayDefault) || 0;
    if (!price) return "";
    return _fmtMoneyShort(price) + "/día";
  }
  return "";
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
