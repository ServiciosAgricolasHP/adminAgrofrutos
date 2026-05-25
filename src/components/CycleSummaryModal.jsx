import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toPng, toBlob } from "html-to-image";
import Modal from "./Modal";
import {
  containerLabel,
  qualityLabel,
  comboLabel,
  getDaySingle,
  getDayCombos,
  getTratoTierTotals,
  getTratoTiers,
  tratoUnitLabel,
  workdayMapKey,
  tratoTypeLabel,
  cosechaUnit,
  formatLaborDayPrice,
} from "../utils/cosechaCombos";
import { isRedDay } from "../utils/tratoHE";
import { tripsService } from "../services/transportsService";
import { cyclesService, workdaysService } from "../services";
import { useCarriers } from "../contexts/CarriersContext";

const fmtCurrency = (v) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 }).format(
    Number(v) || 0,
  );
const fmtNumber = (v) =>
  new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(Number(v) || 0);

const monthShort = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const dateLabel = (dateStr) => {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return dateStr;
  return `${String(d.getDate()).padStart(2, "0")}-${monthShort[d.getMonth()]}`;
};

const LOGO_URL = `${import.meta.env.BASE_URL}logo.png`;

// Mediana — estadístico robusto a outliers (una jornada mensual no la corre
// como sí lo hace el promedio simple). Usado para sugerir la tarifa de cobro
// por día sin que un único día atípico distorsione el resultado.
function medianOf(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// Etiqueta descriptiva de la actividad para mostrar en el editor de cobro y
// resúmenes. Usa los catálogos para describir "qué se está cobrando":
//   - cosecha → "Cosecha — Saco" (envase si todas las filas usan el mismo)
//   - trato   → "Trato — Poda × Árbol" (tratoType × unidad cuando coincide)
//   - tratoHE → "Jornada + HE"
//   - main    → "Jornada simple"
//   - supervision → "Supervisión"
//   - extra   → "Extra"
function activityLabel(labor, catalogs, containers, tratoUnitsSet) {
  const type = labor?.type;
  if (type === "cosecha") {
    if (containers && containers.size === 1) {
      return `Cosecha — ${containerLabel(catalogs, [...containers][0])}`;
    }
    return "Cosecha";
  }
  if (type === "trato") {
    const tt = tratoTypeLabel(catalogs, labor?.tratoType ?? 0);
    if (tratoUnitsSet && tratoUnitsSet.size === 1) {
      const u = [...tratoUnitsSet][0];
      const ul = u == null ? null : tratoUnitLabel(catalogs, u);
      if (ul) return `Trato — ${tt} × ${ul}`;
    }
    return `Trato — ${tt}`;
  }
  if (type === "tratoHE") return "Jornada + HE";
  if (type === "main") return "Jornada simple";
  if (type === "supervision") return "Supervisión";
  if (type === "extra") return "Extra";
  return type || "—";
}

// ============================================================
// Day-by-day aggregation per labor
// ============================================================

// Encabezado de la columna principal según tipo de labor. tratoHE muestra
// "Jornadas / HE" porque agrega dos métricas en la misma columna. Para trato
// y cosecha tomamos la unidad del catálogo en vez de literales fijos.
//
// Para trato: si todos los días del ciclo usan la MISMA unidad configurada
// (ej. "Árbol", "Metro", "Polín"), usamos esa. Si hay mezcla o ningún día
// tiene unidad, caemos al tipo de trato (Poda, Amarre…) como fallback.
function laborQtyUnit(labor, catalogs, containers, tratoUnitsSet) {
  const type = labor?.type;
  if (type === "cosecha") return cosechaUnit(catalogs, containers);
  if (type === "trato") {
    if (tratoUnitsSet && tratoUnitsSet.size === 1) {
      const u = [...tratoUnitsSet][0];
      const label = u == null ? null : tratoUnitLabel(catalogs, u);
      if (label) return label;
    }
    return tratoTypeLabel(catalogs, labor?.tratoType ?? 0);
  }
  // Para tratoHE el unit primario son jornadas. Las horas extras viven
  // adentro de la línea de monto ($amount + Xh), no en una columna aparte.
  if (type === "tratoHE") return "Jornadas";
  return "Jornadas";
}

// Texto a mostrar en la celda de métrica según tipo de labor.
function formatRowMetric(row, type, catalogs) {
  if (type === "cosecha") return fmtNumber(row.qty);
  if (type === "trato") {
    // La unidad sale del config del día (`row.unit`). Si no hay, solo qty.
    if (row.unit != null) {
      const label = tratoUnitLabel(catalogs, row.unit) || "";
      return `${fmtNumber(row.qty)} ${label}`.trim();
    }
    return fmtNumber(row.qty);
  }
  if (type === "tratoHE") {
    const parts = [];
    if (row.qty > 0) parts.push(`${fmtNumber(row.qty)} j`);
    if (row.overtimeHours > 0) parts.push(`${fmtNumber(row.overtimeHours)} HE`);
    return parts.join(" + ");
  }
  return fmtNumber(row.qty);
}

// Total agrupado por unidad para trato: si todos los rows comparten la
// misma unidad, devuelve "20 metros". Si hay mezcla, "12 metros + 8 polines".
// Si nadie tiene unidad configurada, cae al qty plano.
function formatTotalsMetric(totals, type, rows, catalogs) {
  if (type === "tratoHE") {
    const parts = [];
    if (totals.qty > 0) parts.push(`${fmtNumber(totals.qty)} j`);
    if (totals.overtimeHours > 0) parts.push(`${fmtNumber(totals.overtimeHours)} HE`);
    return parts.join(" + ");
  }
  if (type === "trato" && rows) {
    const anyHasUnit = rows.some((r) => r.unit != null);
    if (anyHasUnit) {
      const byUnit = new Map();
      for (const r of rows) {
        const u = r.unit ?? null;
        byUnit.set(u, (byUnit.get(u) || 0) + (Number(r.qty) || 0));
      }
      return [...byUnit.entries()]
        .map(([u, q]) => {
          const label = u == null ? "" : tratoUnitLabel(catalogs, u) || "";
          return `${fmtNumber(q)}${label ? ` ${label}` : ""}`;
        })
        .join(" + ");
    }
  }
  return fmtNumber(totals.qty);
}

// Returns { rows: [...], containers: Set<number> }
// Cada row trae además `pisoAmount` (suma de workdays pisoOnly del día) y
// `pisoCount` (cuántas personas tuvieron piso). El `amount` total incluye
// la producción + piso.
//
// Para trato: si el día/labor tiene una `unit` configurada en
// `dayPrices[labor.id][date].t0.unit`, queda en `row.unit` (índice del
// catálogo `tratoUnits`). Display la convierte a label vía `tratoUnitLabel`.
function buildDailyRows(labor, wdMap, dayPrices = {}) {
  const byDate = new Map();
  const containers = new Set();
  const isTrato = labor?.type === "trato";
  for (const k in wdMap) {
    const wd = wdMap[k];
    const d = wd.date;
    if (!byDate.has(d)) {
      const row = { date: d, qty: 0, overtimeHours: 0, amount: 0, pisoAmount: 0, pisoCount: 0, workersSet: new Set(), pisoWorkersSet: new Set() };
      if (isTrato) {
        // Lee la unidad del primer tier — en práctica cada día usa una
        // sola unidad. Si más adelante un tier diferente del mismo día
        // usara otra, el display lo trata como mixto (formatRowMetric).
        const tiers = getTratoTiers(dayPrices, labor.id, d);
        row.unit = tiers[0]?.unit ?? null;
      }
      byDate.set(d, row);
    }
    const g = byDate.get(d);
    if (wd.pisoOnly) {
      const pa = Number(wd.amount) || 0;
      g.pisoAmount += pa;
      if (wd.workerRut) g.pisoWorkersSet.add(wd.workerRut);
    } else if (labor.type === "cosecha") {
      g.qty += Number(wd.qty) || 0;
      g.amount += Number(wd.amount) || 0;
      containers.add(Number(wd.containerY) || 0);
    } else if (labor.type === "trato") {
      const t = getTratoTierTotals(wd);
      g.qty += t.qty;
      g.amount += t.amount;
    } else if (labor.type === "tratoHE") {
      g.qty += Number(wd.qty) || 0;
      g.overtimeHours += Number(wd.overtimeHours) || 0;
      g.amount += Number(wd.amount) || 0;
    } else {
      // main/supervision/extra: 1 jornada por workday
      g.qty += 1;
      g.amount += Number(wd.amount) || 0;
    }
    if (wd.workerRut) g.workersSet.add(wd.workerRut);
  }
  // Tarifa HE del ciclo — leemos el override de labor o caemos al default.
  // Solo se usa para derivar `bonosTotal` y `heTotal` en tratoHE; los demás
  // tipos lo ignoran.
  const overtimeRate = labor?.type === "tratoHE"
    ? (Number(labor?.overtimeRate) > 0 ? Number(labor.overtimeRate) : 3500)
    : 0;
  const rows = [...byDate.values()]
    .map((g) => {
      // bonosTotal = amount - base - HE_hrs * tarifa. Suma manejo + supervision
      // + extras a través de TODOS los trabajadores del día. Es derivado del
      // amount real (no asume bonos fijos por trabajador) — si la tarifa HE
      // cambia, los bonos se recalculan automáticamente.
      const heTotal = (g.overtimeHours || 0) * overtimeRate;
      const bonosTotal = labor?.type === "tratoHE"
        ? Math.max(0, (g.amount || 0) - (g.qty || 0) - heTotal)
        : 0;
      return {
        ...g,
        workerCount: g.workersSet.size,
        pisoCount: g.pisoWorkersSet.size,
        heTotal,
        bonosTotal,
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { rows, containers };
}

function laborTotals(rows) {
  let qty = 0, overtimeHours = 0, amount = 0, pisoAmount = 0, pisoCount = 0;
  let workerDays = 0, heTotal = 0, bonosTotal = 0;
  for (const r of rows) {
    qty += r.qty;
    overtimeHours += r.overtimeHours || 0;
    amount += r.amount;
    pisoAmount += r.pisoAmount || 0;
    pisoCount += r.pisoCount || 0;
    workerDays += r.workerCount || 0;
    heTotal += r.heTotal || 0;
    bonosTotal += r.bonosTotal || 0;
  }
  return { qty, overtimeHours, amount, pisoAmount, pisoCount, workerDays, heTotal, bonosTotal };
}

// Convierte 1-based column index a letra excel ("A", "B", ..., "AA", ...).
// Compartido por todos los handlers de XLSX en este archivo.
function colLetterX(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Expande wdMap a filas por (date, combo/tier) para el XLSX del resumen.
// A diferencia de `buildDailyRows` (que colapsa todo a 1 fila/día), esta
// función mantiene el desglose por combo en cosecha (qx_cy) y por tier en
// trato (tX). Para tratoHE/main devuelve 1 fila por día sin desglose.
//
// Output shape común:
//   { date, comboKey, comboLabel, qty, amount, pisoAmount, unit, ...extras }
//
// Extras por tipo:
//   - tratoHE: { base, overtimeHours, extras }
//   - main/sup/extra: solo qty (n° jornadas) + amount
function buildExpandedRows(labor, wdMap, dayPrices = {}) {
  const type = labor?.type;
  const byKey = new Map();
  const bonusManejoLabor = Number(labor?.bonusManejo) || 0;
  const bonusSupLabor = Number(labor?.bonusSupervision) || 0;

  for (const k in wdMap) {
    const wd = wdMap[k];
    if (!wd?.date) continue;
    const date = wd.date;

    if (type === "cosecha") {
      const qx = Number(wd.qualityX) || 0;
      const cy = Number(wd.containerY) || 0;
      const comboKey = wd.pisoOnly ? `${date}|piso` : `${qx}_${cy}`;
      const mapKey = `${date}|${comboKey}`;
      if (!byKey.has(mapKey)) {
        byKey.set(mapKey, { date, comboKey, qx, cy, qty: 0, amount: 0, pisoAmount: 0, isPiso: !!wd.pisoOnly });
      }
      const r = byKey.get(mapKey);
      if (wd.pisoOnly) {
        r.pisoAmount += Number(wd.amount) || 0;
      } else {
        r.qty += Number(wd.qty) || 0;
        r.amount += Number(wd.amount) || 0;
      }
    } else if (type === "trato") {
      const parts = String(k).split("__");
      const tierKey = wd.pisoOnly ? "piso" : (parts[2] || "t0");
      const mapKey = `${date}|${tierKey}`;
      if (!byKey.has(mapKey)) {
        const tiers = getTratoTiers(dayPrices, labor.id, date);
        const tierIdx = tierKey.startsWith("t") ? Number(tierKey.slice(1)) || 0 : 0;
        byKey.set(mapKey, {
          date,
          comboKey: tierKey,
          tierIdx,
          unit: tiers[tierIdx]?.unit ?? null,
          qty: 0,
          amount: 0,
          pisoAmount: 0,
          isPiso: !!wd.pisoOnly,
        });
      }
      const r = byKey.get(mapKey);
      if (wd.pisoOnly) {
        r.pisoAmount += Number(wd.amount) || 0;
      } else {
        const t = getTratoTierTotals(wd);
        r.qty += t.qty;
        r.amount += t.amount;
      }
    } else if (type === "tratoHE") {
      const mapKey = date;
      if (!byKey.has(mapKey)) {
        byKey.set(mapKey, { date, comboKey: "he", base: 0, overtimeHours: 0, extras: 0, amount: 0, pisoAmount: 0 });
      }
      const r = byKey.get(mapKey);
      if (wd.pisoOnly) {
        r.pisoAmount += Number(wd.amount) || 0;
      } else {
        r.base += Number(wd.qty) || 0;
        r.overtimeHours += Number(wd.overtimeHours) || 0;
        const manejoAmt = wd.hasManejo ? bonusManejoLabor : 0;
        const supAmt = wd.hasSupervision ? bonusSupLabor : 0;
        r.extras += manejoAmt + supAmt + (Number(wd.extras) || 0);
        r.amount += Number(wd.amount) || 0;
      }
    } else {
      // main/supervision/extra: 1 fila por día, qty = n° de jornadas
      const mapKey = date;
      if (!byKey.has(mapKey)) {
        byKey.set(mapKey, { date, comboKey: "j", qty: 0, amount: 0, pisoAmount: 0 });
      }
      const r = byKey.get(mapKey);
      if (wd.pisoOnly) {
        r.pisoAmount += Number(wd.amount) || 0;
      } else {
        r.qty += 1;
        r.amount += Number(wd.amount) || 0;
      }
    }
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return String(a.comboKey || "").localeCompare(String(b.comboKey || ""));
  });
}

// ============================================================
// Worker × Date grid per labor (segunda sección imprimible)
// ============================================================
// Construye la grilla workers × dates para una labor: cada celda trae la
// producción del trabajador ese día. La métrica varía según labor.type:
//   - cosecha: kilos (qty) + monto + breakdown por combo (calidad/envase)
//   - trato:   qty (n° de "podas"/"desmalezados"/...) + monto
//   - tratoHE: jornadas + horas extras + monto
//   - main/supervision/extra: 1 jornada + monto
// Los nombres de trabajadores salen de `labor.workers[].name` (denormalizado
// al asignarlos a la labor). Si un workday queda huérfano, cae al RUT.
function buildWorkerLaborGrid(labor, wdMap) {
  const nameByRut = new Map();
  for (const w of labor?.workers || []) {
    if (w?.rut) nameByRut.set(w.rut, w.name || w.rut);
  }

  const byWorker = new Map(); // rut -> { rut, name, byDate, totals }
  const datesSet = new Set();
  const containers = new Set();
  let anyPiso = false;

  // Bonuses default a labor-level si el workday no trae override.
  const bonusManejoLabor = Number(labor?.bonusManejo) || 0;
  const bonusSupLabor = Number(labor?.bonusSupervision) || 0;

  for (const k in wdMap) {
    const wd = wdMap[k];
    if (!wd?.workerRut || !wd?.date) continue;
    datesSet.add(wd.date);

    if (!byWorker.has(wd.workerRut)) {
      byWorker.set(wd.workerRut, {
        rut: wd.workerRut,
        name: nameByRut.get(wd.workerRut) || wd.workerName || wd.workerRut,
        byDate: new Map(),
        totals: { qty: 0, amount: 0, kilos: 0, jornadas: 0, overtimeHours: 0, pisoAmount: 0, base: 0, extras: 0 },
      });
    }
    const wEntry = byWorker.get(wd.workerRut);
    if (!wEntry.byDate.has(wd.date)) {
      wEntry.byDate.set(wd.date, {
        date: wd.date,
        qty: 0,
        amount: 0,
        kilos: 0,
        jornadas: 0,
        overtimeHours: 0,
        pisoAmount: 0,
        // tratoHE: base = $ del día (wd.qty), extras = manejo + supervisión + extras
        base: 0,
        extras: 0,
        byCombo: new Map(),
        byTier: new Map(),
      });
    }
    const c = wEntry.byDate.get(wd.date);
    const wdAmount = Number(wd.amount) || 0;
    c.amount += wdAmount;
    wEntry.totals.amount += wdAmount;

    if (wd.pisoOnly) {
      c.pisoAmount += wdAmount;
      wEntry.totals.pisoAmount += wdAmount;
      anyPiso = true;
      continue;
    }

    if (labor?.type === "cosecha") {
      const kg = Number(wd.qty) || 0;
      const qx = Number(wd.qualityX) || 0;
      const cy = Number(wd.containerY) || 0;
      containers.add(cy);
      c.kilos += kg;
      c.qty += kg;
      wEntry.totals.kilos += kg;
      wEntry.totals.qty += kg;
      const ck = `${qx}_${cy}`;
      if (!c.byCombo.has(ck)) c.byCombo.set(ck, { qx, cy, kilos: 0 });
      c.byCombo.get(ck).kilos += kg;
    } else if (labor?.type === "trato") {
      const t = getTratoTierTotals(wd);
      c.qty += t.qty;
      wEntry.totals.qty += t.qty;
      // El tierKey es la 3ra parte del map key `rut__date__ck`. Para trato
      // valores típicos: "t0", "t1", … Cada tier-workday es un doc separado.
      const parts = String(k).split("__");
      const tierKey = parts[2] || "t0";
      if (!c.byTier.has(tierKey)) c.byTier.set(tierKey, { qty: 0, amount: 0 });
      const tb = c.byTier.get(tierKey);
      tb.qty += t.qty;
      tb.amount += t.amount;
    } else if (labor?.type === "tratoHE") {
      // Para tratoHE `wd.qty` guarda el monto base diario (no la cuenta de
      // jornadas). La jornada es implícita: 1 por workday document. Antes
      // sumábamos `q` a jornadas y por eso aparecía algo como "200.000" en
      // la columna de Total Jornadas — era $200k, no 8 jornadas.
      const q = Number(wd.qty) || 0;
      const oh = Number(wd.overtimeHours) || 0;
      // Extras = bono manejo + bono supervisión + valor `extras` numérico.
      const manejoAmt = wd.hasManejo ? bonusManejoLabor : 0;
      const supAmt = wd.hasSupervision ? bonusSupLabor : 0;
      const extrasNum = Number(wd.extras) || 0;
      const extrasTotal = manejoAmt + supAmt + extrasNum;
      c.qty += q;
      c.base += q;
      c.jornadas += 1;
      c.overtimeHours += oh;
      c.extras += extrasTotal;
      wEntry.totals.qty += q;
      wEntry.totals.base += q;
      wEntry.totals.jornadas += 1;
      wEntry.totals.overtimeHours += oh;
      wEntry.totals.extras += extrasTotal;
    } else {
      c.qty += 1;
      c.jornadas += 1;
      wEntry.totals.qty += 1;
      wEntry.totals.jornadas += 1;
    }
  }

  const dates = [...datesSet].sort();
  const workers = [...byWorker.values()].sort((a, b) =>
    (a.name || a.rut).localeCompare(b.name || b.rut, "es"),
  );
  return { workers, dates, containers, anyPiso };
}

// ============================================================
// LocalStorage helpers
// ============================================================

const cobrarStorageKey = (cycleId) => `cobrar_${cycleId}`;
const titlesStorageKey = (cycleId) => `summary_titles_${cycleId}`;

const loadJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
};
const saveJSON = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { console.error(err); }
};

// ============================================================
// Main component
// ============================================================

export default function CycleSummaryModal({
  open, onClose, cycle, faena, subfaena, workdaysByLabor = {}, dayPrices = {}, catalogs = {},
}) {
  // Usamos TODOS los carriers (no solo activos) — un transportista soft-deleted
  // puede tener vueltas viejas en el ciclo y necesitamos su alias para no
  // mostrar el UUID crudo.
  const { carriers } = useCarriers();
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [mode, setMode] = useState("pagar"); // pagar | cobrar
  const [cobrar, setCobrar] = useState({ labors: {}, carriers: {} });
  const [titles, setTitles] = useState({ main: "DETALLE DE JORNADA", subtitle: "", laborNames: {}, carrierNames: {} });
  const [showTitleEditor, setShowTitleEditor] = useState(false);
  const [showCobrarEditor, setShowCobrarEditor] = useState(true);
  // Toggle de edición — cuando es false, oculta inputs/+filas/✕ en cobrar
  // mode. El resumen queda "limpio" para copiar/imprimir/exportar.
  const [editMode, setEditMode] = useState(true);
  // Popover de visibilidad de columnas (cobrar mode). El botón ancla se pasa
  // como ref para posicionar el popover via portal sin que el overflow del
  // Modal padre lo recorte.
  const [colsMenuOpen, setColsMenuOpen] = useState(false);
  const colsBtnRef = useRef(null);
  // Modal de importar ciclos anteriores (cobrar mode). Mantiene la lista de
  // ciclos disponibles + selección.
  const [importOpen, setImportOpen] = useState(false);
  const [availableCycles, setAvailableCycles] = useState([]);
  const [selectedImportIds, setSelectedImportIds] = useState(new Set());
  const printRef = useRef(null);

  useEffect(() => {
    if (!open || !cycle?.id) return;
    setCobrar(loadJSON(cobrarStorageKey(cycle.id), { labors: {}, carriers: {} }));
    const defaultSubtitle = [faena?.name, subfaena?.name, cycle.label].filter(Boolean).join(" · ");
    setTitles(loadJSON(titlesStorageKey(cycle.id), {
      main: "DETALLE DE JORNADA",
      subtitle: defaultSubtitle,
      laborNames: {},
      carrierNames: {},
    }));
    (async () => {
      setLoading(true);
      try {
        const list = await tripsService.listByCycle(cycle.id);
        setTrips(list);
      } finally {
        setLoading(false);
      }
    })();
  }, [open, cycle?.id, cycle?.label, faena?.name, subfaena?.name]);

  const updateTitles = (patch) => {
    setTitles((prev) => {
      const next = { ...prev, ...patch };
      saveJSON(titlesStorageKey(cycle?.id), next);
      return next;
    });
  };
  const updateLaborName = (laborId, name) => {
    setTitles((prev) => {
      const next = { ...prev, laborNames: { ...prev.laborNames, [laborId]: name } };
      saveJSON(titlesStorageKey(cycle?.id), next);
      return next;
    });
  };
  const updateCarrierName = (carrierId, name) => {
    setTitles((prev) => {
      const next = { ...prev, carrierNames: { ...prev.carrierNames, [carrierId]: name } };
      saveJSON(titlesStorageKey(cycle?.id), next);
      return next;
    });
  };

  const updateCobrarLabor = (laborId, patch) => {
    setCobrar((prev) => {
      const next = { ...prev, labors: { ...prev.labors, [laborId]: { ...prev.labors[laborId], ...patch } } };
      saveJSON(cobrarStorageKey(cycle?.id), next);
      return next;
    });
  };
  const updateCobrarCarrier = (carrierId, patch) => {
    setCobrar((prev) => {
      const next = { ...prev, carriers: { ...prev.carriers, [carrierId]: { ...prev.carriers[carrierId], ...patch } } };
      saveJSON(cobrarStorageKey(cycle?.id), next);
      return next;
    });
  };

  // Overrides por fila (cobrar). Cada labor mantiene un map { rowKey -> patch }
  // donde rowKey = date (filas existentes) o "extra:${id}" (filas agregadas
  // manualmente). El patch puede tener qty, overtimeHours, rate, amount —
  // todos opcionales; los no seteados caen al valor base.
  const updateCobrarLaborRow = (laborId, rowKey, patch) => {
    setCobrar((prev) => {
      const labor = prev.labors[laborId] || {};
      const rowOverrides = { ...(labor.rowOverrides || {}) };
      const existing = rowOverrides[rowKey] || {};
      const merged = { ...existing, ...patch };
      // Si el patch deja todas las keys en undefined/null/"", removemos override.
      const allEmpty = Object.values(merged).every((v) => v === "" || v == null);
      if (allEmpty) delete rowOverrides[rowKey];
      else rowOverrides[rowKey] = merged;
      const next = { ...prev, labors: { ...prev.labors, [laborId]: { ...labor, rowOverrides } } };
      saveJSON(cobrarStorageKey(cycle?.id), next);
      return next;
    });
  };
  const addCobrarLaborExtraRow = (laborId) => {
    setCobrar((prev) => {
      const labor = prev.labors[laborId] || {};
      const extraRows = [...(labor.extraRows || [])];
      const id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `x${Date.now()}${Math.random()}`;
      // amount/rate vacíos para que la multiplicación automática (qty × rate)
      // arranque a funcionar apenas el usuario tipea qty + rate. Si dejamos `0`,
      // el override `amount=0` bloquea el `computedAmount` y la fila queda en $0.
      extraRows.push({ id, date: "", qty: "", overtimeHours: "", rate: "", amount: "" });
      const next = { ...prev, labors: { ...prev.labors, [laborId]: { ...labor, extraRows } } };
      saveJSON(cobrarStorageKey(cycle?.id), next);
      return next;
    });
  };
  const updateCobrarLaborExtraRow = (laborId, id, patch) => {
    setCobrar((prev) => {
      const labor = prev.labors[laborId] || {};
      const extraRows = (labor.extraRows || []).map((r) => (r.id === id ? { ...r, ...patch } : r));
      const next = { ...prev, labors: { ...prev.labors, [laborId]: { ...labor, extraRows } } };
      saveJSON(cobrarStorageKey(cycle?.id), next);
      return next;
    });
  };
  const removeCobrarLaborExtraRow = (laborId, id) => {
    setCobrar((prev) => {
      const labor = prev.labors[laborId] || {};
      const extraRows = (labor.extraRows || []).filter((r) => r.id !== id);
      const next = { ...prev, labors: { ...prev.labors, [laborId]: { ...labor, extraRows } } };
      saveJSON(cobrarStorageKey(cycle?.id), next);
      return next;
    });
  };
  // Mismo modelo para transportistas.
  const updateCobrarCarrierRow = (carrierId, rowKey, patch) => {
    setCobrar((prev) => {
      const carrier = prev.carriers[carrierId] || {};
      const rowOverrides = { ...(carrier.rowOverrides || {}) };
      const existing = rowOverrides[rowKey] || {};
      const merged = { ...existing, ...patch };
      const allEmpty = Object.values(merged).every((v) => v === "" || v == null);
      if (allEmpty) delete rowOverrides[rowKey];
      else rowOverrides[rowKey] = merged;
      const next = { ...prev, carriers: { ...prev.carriers, [carrierId]: { ...carrier, rowOverrides } } };
      saveJSON(cobrarStorageKey(cycle?.id), next);
      return next;
    });
  };
  const addCobrarCarrierExtraRow = (carrierId) => {
    setCobrar((prev) => {
      const carrier = prev.carriers[carrierId] || {};
      const extraRows = [...(carrier.extraRows || [])];
      const id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `x${Date.now()}${Math.random()}`;
      // amount/rate vacíos — ver comentario en addCobrarLaborExtraRow.
      extraRows.push({ id, date: "", count: "", rate: "", amount: "" });
      const next = { ...prev, carriers: { ...prev.carriers, [carrierId]: { ...carrier, extraRows } } };
      saveJSON(cobrarStorageKey(cycle?.id), next);
      return next;
    });
  };
  const updateCobrarCarrierExtraRow = (carrierId, id, patch) => {
    setCobrar((prev) => {
      const carrier = prev.carriers[carrierId] || {};
      const extraRows = (carrier.extraRows || []).map((r) => (r.id === id ? { ...r, ...patch } : r));
      const next = { ...prev, carriers: { ...prev.carriers, [carrierId]: { ...carrier, extraRows } } };
      saveJSON(cobrarStorageKey(cycle?.id), next);
      return next;
    });
  };
  const removeCobrarCarrierExtraRow = (carrierId, id) => {
    setCobrar((prev) => {
      const carrier = prev.carriers[carrierId] || {};
      const extraRows = (carrier.extraRows || []).filter((r) => r.id !== id);
      const next = { ...prev, carriers: { ...prev.carriers, [carrierId]: { ...carrier, extraRows } } };
      saveJSON(cobrarStorageKey(cycle?.id), next);
      return next;
    });
  };

  // ============================================================
  // Importar ciclos anteriores (cobrar mode)
  // ============================================================
  // Al abrir el modal de importar, listamos ciclos de la misma faena+subfaena
  // (excluyendo el actual) — todos los estados, ya que se permite consolidar
  // ciclos abiertos también. Usamos `cache: true` para evitar pegar al
  // Firestore cada vez que se abre.
  // Set de cycleIds ya importados — derivado de las filas existentes en
  // `cobrar.labors[].extraRows[].sourceCycleId`. Usado para deshabilitar
  // ciclos ya importados en el modal y evitar duplicar el merge.
  const importedCycleIds = useMemo(() => {
    const set = new Set();
    for (const laborCfg of Object.values(cobrar.labors || {})) {
      for (const er of laborCfg?.extraRows || []) {
        if (er.sourceCycleId) set.add(er.sourceCycleId);
      }
    }
    return set;
  }, [cobrar.labors]);

  const openImportModal = async () => {
    setImportOpen(true);
    setSelectedImportIds(new Set());
    if (!cycle?.faenaId || !cycle?.subfaenaId) {
      setAvailableCycles([]);
      return;
    }
    try {
      const list = await cyclesService.list({
        wheres: [
          ["faenaId", "==", cycle.faenaId],
          ["subfaenaId", "==", cycle.subfaenaId],
        ],
        cache: true,
        ttl: 5 * 60 * 1000,
      });
      const filtered = list
        .filter((c) => c.id !== cycle.id)
        .sort((a, b) => String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id)));
      setAvailableCycles(filtered);
    } catch (err) {
      alert("Error cargando ciclos: " + (err.message || err));
      setAvailableCycles([]);
    }
  };

  // Carga workdays de cada ciclo elegido, los agrupa por labor, matchea por
  // nombre (case-insensitive) contra el ciclo actual y pushea cada día como
  // `extraRow` en `cobrar.labors[laborId].extraRows`. Las labores cuyo nombre
  // no matchee se reportan en un alert al final (el usuario puede renombrar
  // y re-importar).
  const handleImportCycles = async () => {
    // Defensa: filtramos los ya-importados aunque el modal los deshabilite.
    const ids = [...selectedImportIds].filter((id) => !importedCycleIds.has(id));
    if (ids.length === 0) {
      setImportOpen(false);
      return;
    }
    setBusy("import");
    try {
      const labors = cycle?.labors || [];
      const nameToId = new Map(labors.map((l) => [String(l.name || "").trim().toLowerCase(), l.id]));

      const sourceCycles = await Promise.all(ids.map((id) => cyclesService.getById(id)));
      const allWds = await Promise.all(
        ids.map((id) => workdaysService.list({ wheres: [["cycleId", "==", id]] })),
      );

      let importedRowCount = 0;
      const skippedLabors = [];

      setCobrar((prev) => {
        const nextLabors = { ...prev.labors };

        for (let i = 0; i < sourceCycles.length; i++) {
          const sCycle = sourceCycles[i];
          const sWds = allWds[i] || [];
          if (!sCycle?.labors) continue;

          const wdsBy = new Map();
          for (const wd of sWds) {
            if (!wd?.laborId) continue;
            if (!wdsBy.has(wd.laborId)) wdsBy.set(wd.laborId, {});
            const key = wd.id || `${wd.workerRut || "?"}__${wd.date || "?"}`;
            wdsBy.get(wd.laborId)[key] = wd;
          }

          for (const sLabor of sCycle.labors) {
            const wdMap = wdsBy.get(sLabor.id) || {};
            const { rows } = buildDailyRows(sLabor, wdMap, sCycle.dayPrices || {});
            if (rows.length === 0) continue;

            const targetId = nameToId.get(String(sLabor.name || "").trim().toLowerCase());
            if (!targetId) {
              skippedLabors.push(`${sCycle.label || sCycle.id}: ${sLabor.name}`);
              continue;
            }

            const target = nextLabors[targetId] ? { ...nextLabors[targetId] } : {};
            const extraRows = [...(target.extraRows || [])];
            for (const r of rows) {
              const id = (typeof crypto !== "undefined" && crypto.randomUUID)
                ? crypto.randomUUID()
                : `imp${Date.now()}${Math.random()}`;
              const rate = (Number(r.qty) || 0) > 0
                ? Math.round((Number(r.amount) || 0) / (Number(r.qty) || 1))
                : 0;
              extraRows.push({
                id,
                date: r.date,
                qty: Number(r.qty) || 0,
                overtimeHours: Number(r.overtimeHours) || 0,
                rate,
                amount: Number(r.amount) || 0,
                sourceCycleId: sCycle.id,
                sourceCycleLabel: sCycle.label || sCycle.id,
              });
              importedRowCount++;
            }
            target.extraRows = extraRows;
            nextLabors[targetId] = target;
          }
        }

        const next = { ...prev, labors: nextLabors };
        saveJSON(cobrarStorageKey(cycle?.id), next);
        return next;
      });

      setImportOpen(false);
      let msg = `${importedRowCount} días importados.`;
      if (skippedLabors.length > 0) {
        msg += `\n\nLabores no encontradas (nombre no coincide):\n${skippedLabors.slice(0, 10).join("\n")}`;
        if (skippedLabors.length > 10) msg += `\n… +${skippedLabors.length - 10} más`;
      }
      alert(msg);
    } catch (err) {
      alert("Error importando: " + (err.message || err));
    } finally {
      setBusy("");
    }
  };

  const toggleImportCycle = (id) => {
    setSelectedImportIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Toggle visibilidad de columna (global por ciclo). Set persistido en
  // `cobrar.hiddenColumns: string[]`. Las claves coinciden con los campos
  // que renderiza LaborTable/TransportTable (ver render).
  const toggleColumn = (key) => {
    setCobrar((prev) => {
      const set = new Set(prev.hiddenColumns || []);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      const next = { ...prev, hiddenColumns: [...set] };
      saveJSON(cobrarStorageKey(cycle?.id), next);
      return next;
    });
  };
  const resetColumns = () => {
    setCobrar((prev) => {
      const next = { ...prev, hiddenColumns: [] };
      saveJSON(cobrarStorageKey(cycle?.id), next);
      return next;
    });
  };
  const hiddenColumns = useMemo(() => new Set(cobrar.hiddenColumns || []), [cobrar.hiddenColumns]);

  // ============================================================
  // Build per-labor data
  // ============================================================
  const laborsData = useMemo(() => {
    if (!cycle?.labors) return [];
    return cycle.labors.map((l) => {
      const wdMap = workdaysByLabor[l.id] || {};
      const { rows, containers } = buildDailyRows(l, wdMap, dayPrices);
      const totals = laborTotals(rows);
      // Set de unidades únicas usadas en este ciclo para esta labor de trato.
      // Si todas las filas comparten una sola unidad, laborQtyUnit la elige
      // como header de columna en vez del tratoType.
      const tratoUnitsSet =
        l.type === "trato"
          ? new Set(rows.map((r) => r.unit).filter((u) => u != null))
          : null;
      return {
        labor: l,
        rows,
        totals,
        unit: laborQtyUnit(l, catalogs, containers, tratoUnitsSet),
        containers,
        tratoUnitsSet,
      };
    });
  }, [cycle?.labors, workdaysByLabor, catalogs, dayPrices]);

  // Grilla workers × dates por labor — segunda sección imprimible. Cada
  // labor rinde su propia infografía con botones de copiar/imprimir.
  const laborWorkerGrids = useMemo(() => {
    if (!cycle?.labors) return [];
    return cycle.labors.map((l) => {
      const wdMap = workdaysByLabor[l.id] || {};
      const grid = buildWorkerLaborGrid(l, wdMap);
      return { labor: l, ...grid };
    });
  }, [cycle?.labors, workdaysByLabor]);

  // Transport: group by carrier + date
  const transportData = useMemo(() => {
    const byCarrier = new Map();
    for (const t of trips) {
      const cid = t.carrierId;
      if (!byCarrier.has(cid)) byCarrier.set(cid, { carrierId: cid, byDate: new Map(), totalCount: 0, totalAmount: 0 });
      const g = byCarrier.get(cid);
      if (!g.byDate.has(t.date)) g.byDate.set(t.date, { date: t.date, count: 0, amount: 0 });
      const d = g.byDate.get(t.date);
      d.count += Number(t.qty) || 1;
      d.amount += Number(t.amount) || 0;
      g.totalCount += Number(t.qty) || 1;
      g.totalAmount += Number(t.amount) || 0;
    }
    return [...byCarrier.values()].map((g) => ({
      ...g,
      rows: [...g.byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    }));
  }, [trips]);

  const carrierById = useMemo(() => new Map(carriers.map((c) => [c.id, c])), [carriers]);

  const grandTotalPagar = useMemo(() => {
    let sum = 0;
    for (const ld of laborsData) sum += ld.totals.amount + (ld.totals.pisoAmount || 0);
    for (const tg of transportData) sum += tg.totalAmount;
    return sum;
  }, [laborsData, transportData]);

  // ============================================================
  // Cobrar rows
  // ============================================================
  //
  // Para la tarifa sugerida usamos la MEDIANA del precio por día y no el
  // promedio simple (total/qty). Motivo: si una labor tiene 1 jornada
  // mensual de $500k mezclada con 30 días normales a $25k, el promedio se
  // dispara (~$40k) y queda muy lejos del precio real del 96% de los días.
  // La mediana ignora el outlier y devuelve $25k, que es lo que el
  // contratista efectivamente está pagando.
  //
  // Igual mantenemos el `meanRate` calculado para mostrarlo entre paréntesis
  // y que el usuario tenga visibilidad de la diferencia.
  const cobrarLabors = useMemo(() => {
    return laborsData.map((ld) => {
      const cfg = cobrar.labors[ld.labor.id] || {};
      const include = cfg.include !== false;
      const meanRate = ld.totals.qty > 0 ? Math.round(ld.totals.amount / ld.totals.qty) : 0;
      const perDayRates = (ld.rows || [])
        .filter((r) => (Number(r.qty) || 0) > 0)
        .map((r) => (Number(r.amount) || 0) / (Number(r.qty) || 1));
      const medianRate = Math.round(medianOf(perDayRates));
      const defaultRate = medianRate || meanRate;
      const rate = cfg.chargeRate != null ? Number(cfg.chargeRate) : defaultRate;
      const activity = activityLabel(ld.labor, catalogs, ld.containers, ld.tratoUnitsSet);

      // Aplicar overrides por fila + sumar extraRows. Cada chargedRow trae los
      // valores resultantes (qty, rate, amount) ya aplicados. La UI los usa
      // para mostrar inputs y el XLSX/totales para sumar.
      const rowOverrides = cfg.rowOverrides || {};
      const extraRows = cfg.extraRows || [];
      const isHE = ld.labor.type === "tratoHE";
      // tratoHE: total = base $ + HE × tarifa HE. Otros: total = qty × rate.
      const computeAmount = (qty, hours, rowRate) =>
        isHE ? Number(qty) + Number(hours) * Number(rowRate) : Number(qty) * Number(rowRate);

      // Para labors `trato`, las filas regulares traen `unit` desde el config
      // del día (`saco`, `metro`, etc.). Las filas extra/manuales no tienen
      // unit → heredamos la unidad dominante de las filas regulares para que
      // el formato muestre "212 saco" en vez de solo "212".
      let dominantUnit = null;
      if (ld.labor.type === "trato") {
        const unitCounts = new Map();
        for (const r of ld.rows || []) {
          if (r.unit != null) unitCounts.set(r.unit, (unitCounts.get(r.unit) || 0) + 1);
        }
        let maxC = 0;
        for (const [u, c] of unitCounts) {
          if (c > maxC) { maxC = c; dominantUnit = u; }
        }
      }
      const chargedRows = (ld.rows || []).map((r) => {
        const ov = rowOverrides[r.date] || {};
        const qty = ov.qty != null && ov.qty !== "" ? Number(ov.qty) : Number(r.qty) || 0;
        const overtimeHours = ov.overtimeHours != null && ov.overtimeHours !== ""
          ? Number(ov.overtimeHours)
          : Number(r.overtimeHours) || 0;
        const rowRate = ov.rate != null && ov.rate !== "" ? Number(ov.rate) : rate;
        const computedAmount = computeAmount(qty, overtimeHours, rowRate);
        const amount = ov.amount != null && ov.amount !== "" ? Number(ov.amount) : computedAmount;
        const hasOverride = Object.keys(ov).length > 0;
        return {
          ...r,
          chargedQty: qty,
          chargedOvertimeHours: overtimeHours,
          chargedRate: rowRate,
          chargedAmount: amount,
          rowKey: r.date,
          isExtra: false,
          hasOverride,
          override: ov,
        };
      });
      for (const ex of extraRows) {
        const qty = Number(ex.qty) || 0;
        const overtimeHours = Number(ex.overtimeHours) || 0;
        const rowRate = ex.rate != null && ex.rate !== "" ? Number(ex.rate) : rate;
        const computedAmount = computeAmount(qty, overtimeHours, rowRate);
        const amount = ex.amount != null && ex.amount !== "" ? Number(ex.amount) : computedAmount;
        chargedRows.push({
          date: ex.date || "",
          qty: Number(ex.qty) || 0,
          overtimeHours: Number(ex.overtimeHours) || 0,
          amount: amount,
          // Heredá la unit dominante del labor (solo trato) para que
          // formatRowMetric muestre "X saco" cuando se imprime no-editable.
          unit: ex.unit != null ? ex.unit : dominantUnit,
          pisoAmount: 0,
          pisoCount: 0,
          chargedQty: qty,
          chargedOvertimeHours: overtimeHours,
          chargedRate: rowRate,
          chargedAmount: amount,
          rowKey: `extra:${ex.id}`,
          isExtra: true,
          extraId: ex.id,
        });
      }
      // Ordenar por fecha (las extra con date vacío al final).
      chargedRows.sort((a, b) => {
        if (!a.date && !b.date) return 0;
        if (!a.date) return 1;
        if (!b.date) return -1;
        return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      });
      let chargedTotalAmount = 0, chargedTotalQty = 0, chargedTotalOvertimeHours = 0;
      for (const r of chargedRows) {
        chargedTotalAmount += r.chargedAmount;
        chargedTotalQty += r.chargedQty;
        chargedTotalOvertimeHours += r.chargedOvertimeHours;
      }
      const chargedTotals = {
        amount: chargedTotalAmount,
        qty: chargedTotalQty,
        overtimeHours: chargedTotalOvertimeHours,
        pisoAmount: ld.totals.pisoAmount || 0,
        pisoCount: ld.totals.pisoCount || 0,
        // Stats informativas: vienen del dato real (no se modifican con overrides).
        workerDays: ld.totals.workerDays || 0,
        heTotal: ld.totals.heTotal || 0,
        bonosTotal: ld.totals.bonosTotal || 0,
      };
      return {
        ...ld,
        include,
        rate,
        defaultRate,
        meanRate,
        medianRate,
        activity,
        chargedRows,
        chargedTotals,
      };
    });
  }, [laborsData, cobrar.labors, catalogs]);

  const cobrarCarriers = useMemo(() => {
    return transportData.map((tg) => {
      const cfg = cobrar.carriers[tg.carrierId] || {};
      const include = cfg.include !== false;
      const defaultRate = tg.totalCount > 0 ? Math.round(tg.totalAmount / tg.totalCount) : 0;
      const rate = cfg.chargeRate != null ? Number(cfg.chargeRate) : defaultRate;

      const rowOverrides = cfg.rowOverrides || {};
      const extraRows = cfg.extraRows || [];
      const chargedRows = (tg.rows || []).map((r) => {
        const ov = rowOverrides[r.date] || {};
        const count = ov.count != null && ov.count !== "" ? Number(ov.count) : Number(r.count) || 0;
        const rowRate = ov.rate != null && ov.rate !== "" ? Number(ov.rate) : rate;
        const computedAmount = count * rowRate;
        const amount = ov.amount != null && ov.amount !== "" ? Number(ov.amount) : computedAmount;
        const hasOverride = Object.keys(ov).length > 0;
        return {
          ...r,
          chargedCount: count,
          chargedRate: rowRate,
          chargedAmount: amount,
          rowKey: r.date,
          isExtra: false,
          hasOverride,
          override: ov,
        };
      });
      for (const ex of extraRows) {
        const count = Number(ex.count) || 0;
        const rowRate = ex.rate != null && ex.rate !== "" ? Number(ex.rate) : rate;
        const computedAmount = count * rowRate;
        const amount = ex.amount != null && ex.amount !== "" ? Number(ex.amount) : computedAmount;
        chargedRows.push({
          date: ex.date || "",
          count: Number(ex.count) || 0,
          amount,
          chargedCount: count,
          chargedRate: rowRate,
          chargedAmount: amount,
          rowKey: `extra:${ex.id}`,
          isExtra: true,
          extraId: ex.id,
        });
      }
      chargedRows.sort((a, b) => {
        if (!a.date && !b.date) return 0;
        if (!a.date) return 1;
        if (!b.date) return -1;
        return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      });
      let chargedTotalAmount = 0, chargedTotalCount = 0;
      for (const r of chargedRows) {
        chargedTotalAmount += r.chargedAmount;
        chargedTotalCount += r.chargedCount;
      }
      return { ...tg, include, rate, defaultRate, chargedRows, chargedTotalAmount, chargedTotalCount };
    });
  }, [transportData, cobrar.carriers]);

  const grandTotalCobrar = useMemo(() => {
    let sum = 0;
    for (const cl of cobrarLabors) if (cl.include) sum += cl.chargedTotals?.amount || 0;
    for (const cc of cobrarCarriers) if (cc.include) sum += cc.chargedTotalAmount || 0;
    return sum;
  }, [cobrarLabors, cobrarCarriers]);

  // Wrappers que dispatchan a updateRow / updateExtra según el tipo de fila.
  // Simplifican la API que recibe LaborTable / TransportTable: ellos sólo
  // saben `editRow(row, patch)` sin preocuparse si es base u override.
  // Si el usuario edita un factor (qty/count/rate/overtimeHours) sin pasar
  // `amount` explícito, blanqueamos `amount` para que el cálculo
  // qty × rate (o qty + hours × rate en tratoHE) vuelva a mandar. Sin esto
  // el amount viejo (ej. el que vino de la importación) queda pegado y la
  // multiplicación parece no actualizarse.
  const clearAmountIfFactorEdit = (patch, factorKeys) => {
    const editsFactor = factorKeys.some((k) => k in patch);
    return editsFactor && !("amount" in patch) ? { ...patch, amount: "" } : patch;
  };
  const editCobrarLaborRow = (laborId, row, patch) => {
    const finalPatch = clearAmountIfFactorEdit(patch, ["qty", "rate", "overtimeHours"]);
    if (row?.isExtra) updateCobrarLaborExtraRow(laborId, row.extraId, finalPatch);
    else updateCobrarLaborRow(laborId, row.date, finalPatch);
  };
  const editCobrarCarrierRow = (carrierId, row, patch) => {
    const finalPatch = clearAmountIfFactorEdit(patch, ["count", "rate"]);
    if (row?.isExtra) updateCobrarCarrierExtraRow(carrierId, row.extraId, finalPatch);
    else updateCobrarCarrierRow(carrierId, row.date, finalPatch);
  };

  // ============================================================
  // Image / print actions
  // ============================================================
  const filename = `resumen_${mode}_${(cycle?.label || "ciclo").replace(/[/\s]+/g, "_")}.png`;
  const handleDownload = async () => {
    if (!printRef.current) return;
    setBusy("download");
    try {
      const dataUrl = await toPng(printRef.current, { backgroundColor: "#ffffff", pixelRatio: 2 });
      const link = document.createElement("a");
      link.download = filename;
      link.href = dataUrl;
      link.click();
    } finally { setBusy(""); }
  };
  const handleCopy = async () => {
    if (!printRef.current) return;
    setBusy("copy");
    try {
      const blob = await toBlob(printRef.current, { backgroundColor: "#ffffff", pixelRatio: 2 });
      if (!blob) throw new Error("No se pudo generar la imagen");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      alert("Imagen copiada al portapapeles");
    } catch (err) {
      alert("Error: " + (err.message || err));
    } finally { setBusy(""); }
  };
  // ============================================================
  // XLSX del resumen consolidado (una hoja por labor + transporte + Total).
  // Cada hoja respeta las restricciones globales: col A vacía mitad ancho,
  // fila 1 vacía. Datos arrancan en B2. Cosecha/Trato se desglosan por
  // (día, combo/tier) con precios editables. tratoHE tiene tarifa HE
  // editable y fórmulas Base+HE×tarifa+Extras. Subtotales y total general
  // con SUM() para que el usuario pueda editar precios y recalcular.
  // ============================================================
  const handleXlsxSummary = async () => {
    setBusy("xlsx");
    try {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const colLetter = (n) => {
        let s = "";
        while (n > 0) {
          const m = (n - 1) % 26;
          s = String.fromCharCode(65 + m) + s;
          n = Math.floor((n - 1) / 26);
        }
        return s;
      };
      const usedNames = new Set();
      const safeName = (s) => {
        let base = String(s || "Hoja").substring(0, 28).replace(/[\\/?*[\]]/g, "_");
        let name = base, i = 2;
        while (usedNames.has(name)) {
          name = `${base} ${i}`.substring(0, 31);
          i++;
        }
        usedNames.add(name);
        return name;
      };
      const moneyFmt = '"$"#,##0;[Red]-"$"#,##0';
      const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF9DC3E6" } };
      const subtotalFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };
      const editableFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
      const transportFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFBE5D6" } };
      const titleFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFA9D08E" } };

      const laborsForMode = mode === "cobrar" ? cobrarLabors : laborsData;
      const carriersForMode = mode === "cobrar" ? cobrarCarriers : transportData;

      // Para la hoja Total: lista de {displayName, sheetName, totalCellRef}.
      const sheetTotals = [];

      // ============ HOJAS DE LABORES ============
      for (const ld of laborsForMode) {
        if (mode === "cobrar" && !ld.include) continue;
        const labor = ld.labor;
        if (!ld.rows || ld.rows.length === 0) continue;
        const displayName = titles.laborNames?.[labor.id] || labor.name;
        const sheetName = safeName(displayName);
        const ws = wb.addWorksheet(sheetName);
        ws.getColumn(1).width = 6;

        // Title B2
        ws.getCell("B2").value = displayName;
        ws.getCell("B2").font = { bold: true, size: 14 };

        const isCosecha = labor.type === "cosecha";
        const isTrato = labor.type === "trato";
        const isHE = labor.type === "tratoHE";

        // RedDates (solo tratoHE) — para color rojo en columna Fecha.
        const redDates = new Set();
        if (isHE) {
          for (const r of ld.rows) {
            const cfg = getDaySingle(dayPrices, labor.id, r.date, "normal");
            if (isRedDay(r.date, cfg)) redDates.add(r.date);
          }
        }

        if (isCosecha || isTrato) {
          // Estructura: B Fecha | C Combo/Tier | D Cantidad | E Precio | F Total
          // mode=cobrar: una sola tarifa editable en C3 (todas las filas la referencian)
          let chargeRef = null;
          if (mode === "cobrar") {
            ws.getCell("B3").value = "Tarifa cobro:";
            ws.getCell("B3").font = { bold: true };
            const c3 = ws.getCell("C3");
            c3.value = Number(ld.rate) || 0;
            c3.numFmt = moneyFmt;
            c3.fill = editableFill;
            chargeRef = "$C$3";
          }

          const HEADER_ROW = mode === "cobrar" ? 5 : 4;
          const headerCells = ["B", "C", "D", "E", "F"];
          const headers = ["Fecha", isCosecha ? "Combo (Calidad / Envase)" : "Tier", "Cantidad", "Precio", "Total"];
          headerCells.forEach((col, i) => {
            const c = ws.getCell(`${col}${HEADER_ROW}`);
            c.value = headers[i];
            c.font = { bold: true };
            c.fill = headerFill;
            c.alignment = { horizontal: i === 0 || i === 1 ? "left" : "right" };
          });

          // Construir filas desglosadas por (fecha, combo/tier).
          const wdMap = workdaysByLabor[labor.id] || {};
          const dayMap = new Map();
          for (const k in wdMap) {
            const wd = wdMap[k];
            if (wd?.pisoOnly) continue;
            let key, label, qty;
            if (isCosecha) {
              const qx = Number(wd.qualityX) || 0;
              const cy = Number(wd.containerY) || 0;
              key = `${qx}_${cy}`;
              label = `${qualityLabel(catalogs, qx)} / ${containerLabel(catalogs, cy)}`;
              qty = Number(wd.qty) || 0;
            } else {
              const parts = String(k).split("__");
              key = parts[2] || "t0";
              const t = getTratoTierTotals(wd);
              const tiers = getTratoTiers(dayPrices, labor.id, wd.date);
              const tier = tiers.find((x) => x.key === key);
              const unitLabel = tier?.unit != null ? tratoUnitLabel(catalogs, tier.unit) : null;
              label = unitLabel || `Tier ${key.replace(/^t/, "")}`;
              qty = t.qty;
            }
            if (qty <= 0) continue;
            if (!dayMap.has(wd.date)) dayMap.set(wd.date, new Map());
            const m = dayMap.get(wd.date);
            if (!m.has(key)) m.set(key, { key, label, qty: 0 });
            m.get(key).qty += qty;
          }

          const sortedDates = [...dayMap.keys()].sort();
          let curRow = HEADER_ROW + 1;
          const dataStartRow = curRow;
          for (const date of sortedDates) {
            const items = [...dayMap.get(date).values()].sort((a, b) => a.label.localeCompare(b.label));
            for (const it of items) {
              const dateCell = ws.getCell(`B${curRow}`);
              dateCell.value = dateLabel(date);
              // Marca rojo solo si aplicara (tratoHE no entra acá; reservado).
              ws.getCell(`C${curRow}`).value = it.label;
              const qCell = ws.getCell(`D${curRow}`);
              qCell.value = it.qty;
              qCell.numFmt = "#,##0.##";
              qCell.alignment = { horizontal: "right" };
              const pCell = ws.getCell(`E${curRow}`);
              if (mode === "cobrar") {
                pCell.value = { formula: chargeRef, result: Number(ld.rate) || 0 };
              } else {
                let price = 0;
                if (isCosecha) {
                  const list = getDayCombos(dayPrices, labor.id, date, "unit");
                  const hit = list.find((c) => c.key === it.key);
                  price = Number(hit?.price) || 0;
                } else {
                  const list = getTratoTiers(dayPrices, labor.id, date, "unit");
                  const hit = list.find((c) => c.key === it.key);
                  price = Number(hit?.price) || 0;
                }
                pCell.value = price;
                pCell.fill = editableFill;
              }
              pCell.numFmt = moneyFmt;
              const tCell = ws.getCell(`F${curRow}`);
              const priceResult = mode === "cobrar"
                ? Number(ld.rate) || 0
                : Number(pCell.value) || 0;
              tCell.value = { formula: `D${curRow}*E${curRow}`, result: it.qty * priceResult };
              tCell.numFmt = moneyFmt;
              curRow++;
            }
          }
          const dataEndRow = curRow - 1;

          // Subtotal
          const subRow = curRow;
          for (const col of headerCells) {
            ws.getCell(`${col}${subRow}`).fill = subtotalFill;
            ws.getCell(`${col}${subRow}`).font = { bold: true };
          }
          ws.getCell(`B${subRow}`).value = "Subtotal";
          if (dataEndRow >= dataStartRow) {
            ws.getCell(`D${subRow}`).value = { formula: `SUM(D${dataStartRow}:D${dataEndRow})`, result: 0 };
            ws.getCell(`D${subRow}`).numFmt = "#,##0.##";
            ws.getCell(`F${subRow}`).value = { formula: `SUM(F${dataStartRow}:F${dataEndRow})`, result: ld.totals.amount };
            ws.getCell(`F${subRow}`).numFmt = moneyFmt;
          }
          const fallbackCos = mode === "cobrar" ? (ld.chargedTotals?.amount ?? ld.totals.amount) : ld.totals.amount;
          sheetTotals.push({ displayName, sheetName, totalRef: `'${sheetName}'!$F$${subRow}`, fallback: fallbackCos });

          ws.getColumn(2).width = 14;
          ws.getColumn(3).width = 30;
          ws.getColumn(4).width = 12;
          ws.getColumn(5).width = 12;
          ws.getColumn(6).width = 14;
          ws.views = [{ state: "frozen", ySplit: HEADER_ROW }];
        }
        else if (isHE) {
          // tratoHE: B Fecha | C Base $ | D HE (hrs) | E Tarifa HE (ref) | F Extras $ | G Total
          // Tarifa HE editable en C3.
          ws.getCell("B3").value = "Tarifa HE:";
          ws.getCell("B3").font = { bold: true };
          const c3 = ws.getCell("C3");
          // Tarifa por defecto: si hay HE en datos, calcular como promedio implícito.
          // Si no hay HE, dejar 0.
          const totalHE = ld.totals.overtimeHours || 0;
          const implicitRate = totalHE > 0 ? Math.round(ld.totals.amount - ld.totals.qty) / Math.max(totalHE, 1) : 0;
          // Mejor: dejar editable iniciado en 0 si no hay HE, o usar implícito si lo hay.
          c3.value = totalHE > 0 ? Math.max(0, Math.round(implicitRate)) : 0;
          c3.numFmt = moneyFmt;
          c3.fill = editableFill;
          const heRateRef = "$C$3";

          const HEADER_ROW = 5;
          const cols = ["B", "C", "D", "E", "F", "G"];
          const headers = ["Fecha", "Base $", "HE (hrs)", "Tarifa HE", "Extras $", "Total $"];
          cols.forEach((col, i) => {
            const c = ws.getCell(`${col}${HEADER_ROW}`);
            c.value = headers[i];
            c.font = { bold: true };
            c.fill = headerFill;
            c.alignment = { horizontal: i === 0 ? "left" : "right" };
          });

          let curRow = HEADER_ROW + 1;
          const dataStartRow = curRow;
          // En cobrar usamos chargedRows (incluye overrides + extras manuales).
          const heRows = mode === "cobrar" ? (ld.chargedRows || ld.rows) : ld.rows;
          for (const r of heRows) {
            const isRed = redDates.has(r.date);
            const dCell = ws.getCell(`B${curRow}`);
            dCell.value = r.date ? dateLabel(r.date) : (r.isExtra ? "(ajuste)" : "");
            if (isRed) dCell.font = { bold: true, color: { argb: "FFCC0000" } };

            const baseV = mode === "cobrar" ? Number(r.chargedQty) || 0 : Number(r.qty) || 0;
            const heHrs = mode === "cobrar" ? Number(r.chargedOvertimeHours) || 0 : Number(r.overtimeHours) || 0;
            const heAmt = heHrs * (Number(c3.value) || 0);
            const amountForExtras = mode === "cobrar" ? Number(r.chargedAmount) || 0 : Number(r.amount) || 0;
            const extras = Math.max(0, amountForExtras - baseV - heAmt);

            const base = ws.getCell(`C${curRow}`);
            base.value = baseV;
            base.numFmt = moneyFmt;
            const he = ws.getCell(`D${curRow}`);
            he.value = heHrs;
            he.numFmt = "#,##0.##";
            const rate = ws.getCell(`E${curRow}`);
            rate.value = { formula: heRateRef, result: Number(c3.value) || 0 };
            rate.numFmt = moneyFmt;
            const ex = ws.getCell(`F${curRow}`);
            ex.value = extras;
            ex.numFmt = moneyFmt;
            ex.fill = editableFill;
            const tot = ws.getCell(`G${curRow}`);
            tot.value = {
              formula: `C${curRow}+D${curRow}*${heRateRef}+F${curRow}`,
              result: baseV + heAmt + extras,
            };
            tot.numFmt = moneyFmt;
            curRow++;
          }
          const dataEndRow = curRow - 1;

          const subRow = curRow;
          for (const col of cols) {
            ws.getCell(`${col}${subRow}`).fill = subtotalFill;
            ws.getCell(`${col}${subRow}`).font = { bold: true };
          }
          ws.getCell(`B${subRow}`).value = "Subtotal";
          if (dataEndRow >= dataStartRow) {
            ws.getCell(`C${subRow}`).value = { formula: `SUM(C${dataStartRow}:C${dataEndRow})`, result: 0 };
            ws.getCell(`C${subRow}`).numFmt = moneyFmt;
            ws.getCell(`D${subRow}`).value = { formula: `SUM(D${dataStartRow}:D${dataEndRow})`, result: 0 };
            ws.getCell(`D${subRow}`).numFmt = "#,##0.##";
            ws.getCell(`F${subRow}`).value = { formula: `SUM(F${dataStartRow}:F${dataEndRow})`, result: 0 };
            ws.getCell(`F${subRow}`).numFmt = moneyFmt;
            ws.getCell(`G${subRow}`).value = { formula: `SUM(G${dataStartRow}:G${dataEndRow})`, result: ld.totals.amount };
            ws.getCell(`G${subRow}`).numFmt = moneyFmt;
          }
          const fallbackHE = mode === "cobrar" ? (ld.chargedTotals?.amount ?? ld.totals.amount) : ld.totals.amount;
          sheetTotals.push({ displayName, sheetName, totalRef: `'${sheetName}'!$G$${subRow}`, fallback: fallbackHE });

          ws.getColumn(2).width = 14;
          ws.getColumn(3).width = 14;
          ws.getColumn(4).width = 12;
          ws.getColumn(5).width = 12;
          ws.getColumn(6).width = 14;
          ws.getColumn(7).width = 14;
          ws.views = [{ state: "frozen", ySplit: HEADER_ROW }];
        }
        else {
          // main / supervision / extra: B Fecha | C Jornadas | D $ jornada | E Total
          // Para mode=cobrar usa tarifa única en C3.
          let chargeRef = null;
          if (mode === "cobrar") {
            ws.getCell("B3").value = "Tarifa cobro:";
            ws.getCell("B3").font = { bold: true };
            const c3 = ws.getCell("C3");
            c3.value = Number(ld.rate) || 0;
            c3.numFmt = moneyFmt;
            c3.fill = editableFill;
            chargeRef = "$C$3";
          }

          const HEADER_ROW = mode === "cobrar" ? 5 : 4;
          const cols = ["B", "C", "D", "E"];
          const headers = ["Fecha", "Jornadas", "$ por jornada", "Total"];
          cols.forEach((col, i) => {
            const c = ws.getCell(`${col}${HEADER_ROW}`);
            c.value = headers[i];
            c.font = { bold: true };
            c.fill = headerFill;
            c.alignment = { horizontal: i === 0 ? "left" : "right" };
          });

          let curRow = HEADER_ROW + 1;
          const dataStartRow = curRow;
          // En cobrar usamos chargedRows con overrides + extras manuales.
          const simpleRows = mode === "cobrar" ? (ld.chargedRows || ld.rows) : ld.rows;
          for (const r of simpleRows) {
            ws.getCell(`B${curRow}`).value = r.date ? dateLabel(r.date) : (r.isExtra ? "(ajuste)" : "");
            const qCell = ws.getCell(`C${curRow}`);
            const qtyV = mode === "cobrar" ? Number(r.chargedQty) || 0 : Number(r.qty) || 0;
            qCell.value = qtyV;
            qCell.numFmt = "#,##0";
            const pCell = ws.getCell(`D${curRow}`);
            if (mode === "cobrar") {
              // En cobrar el rate puede tener override por fila → escribimos
              // el valor literal en lugar de referenciar $C$3.
              pCell.value = Number(r.chargedRate) || 0;
              pCell.fill = editableFill;
            } else {
              const rate = r.qty > 0 ? Math.round(r.amount / r.qty) : 0;
              pCell.value = rate;
              pCell.fill = editableFill;
            }
            pCell.numFmt = moneyFmt;
            const tCell = ws.getCell(`E${curRow}`);
            const amountResult = mode === "cobrar" ? Number(r.chargedAmount) || 0 : Number(r.amount) || 0;
            tCell.value = { formula: `C${curRow}*D${curRow}`, result: amountResult };
            tCell.numFmt = moneyFmt;
            curRow++;
          }
          const dataEndRow = curRow - 1;

          const subRow = curRow;
          for (const col of cols) {
            ws.getCell(`${col}${subRow}`).fill = subtotalFill;
            ws.getCell(`${col}${subRow}`).font = { bold: true };
          }
          ws.getCell(`B${subRow}`).value = "Subtotal";
          if (dataEndRow >= dataStartRow) {
            ws.getCell(`C${subRow}`).value = { formula: `SUM(C${dataStartRow}:C${dataEndRow})`, result: 0 };
            ws.getCell(`C${subRow}`).numFmt = "#,##0";
            ws.getCell(`E${subRow}`).value = { formula: `SUM(E${dataStartRow}:E${dataEndRow})`, result: ld.totals.amount };
            ws.getCell(`E${subRow}`).numFmt = moneyFmt;
          }
          const fallbackSimple = mode === "cobrar" ? (ld.chargedTotals?.amount ?? ld.totals.amount) : ld.totals.amount;
          sheetTotals.push({ displayName, sheetName, totalRef: `'${sheetName}'!$E$${subRow}`, fallback: fallbackSimple });

          ws.getColumn(2).width = 14;
          ws.getColumn(3).width = 12;
          ws.getColumn(4).width = 14;
          ws.getColumn(5).width = 14;
          ws.views = [{ state: "frozen", ySplit: HEADER_ROW }];
        }
      }

      // ============ HOJAS DE TRANSPORTE ============
      for (const tg of carriersForMode) {
        if (mode === "cobrar" && !tg.include) continue;
        if (!tg.rows || tg.rows.length === 0) continue;
        const fallbackName = carrierById.get(tg.carrierId)?.alias || carrierById.get(tg.carrierId)?.name || "(transportista)";
        const displayName = titles.carrierNames?.[tg.carrierId] || fallbackName;
        const sheetName = safeName(`🚐 ${displayName}`);
        const ws = wb.addWorksheet(sheetName);
        ws.getColumn(1).width = 6;

        ws.getCell("B2").value = `🚐 ${displayName}`;
        ws.getCell("B2").font = { bold: true, size: 14 };

        let chargeRef = null;
        if (mode === "cobrar") {
          ws.getCell("B3").value = "Tarifa cobro:";
          ws.getCell("B3").font = { bold: true };
          const c3 = ws.getCell("C3");
          c3.value = Number(tg.rate) || 0;
          c3.numFmt = moneyFmt;
          c3.fill = editableFill;
          chargeRef = "$C$3";
        }

        const HEADER_ROW = mode === "cobrar" ? 5 : 4;
        const cols = ["B", "C", "D", "E"];
        const headers = ["Fecha", "Vueltas", "Precio", "Total"];
        cols.forEach((col, i) => {
          const c = ws.getCell(`${col}${HEADER_ROW}`);
          c.value = headers[i];
          c.font = { bold: true };
          c.fill = transportFill;
          c.alignment = { horizontal: i === 0 ? "left" : "right" };
        });

        let curRow = HEADER_ROW + 1;
        const dataStartRow = curRow;
        const carrierRows = mode === "cobrar" ? (tg.chargedRows || tg.rows) : tg.rows;
        for (const r of carrierRows) {
          ws.getCell(`B${curRow}`).value = r.date ? dateLabel(r.date) : (r.isExtra ? "(ajuste)" : "");
          const qCell = ws.getCell(`C${curRow}`);
          const countV = mode === "cobrar" ? Number(r.chargedCount) || 0 : Number(r.count) || 0;
          qCell.value = countV;
          qCell.numFmt = "#,##0";
          const pCell = ws.getCell(`D${curRow}`);
          if (mode === "cobrar") {
            pCell.value = Number(r.chargedRate) || 0;
            pCell.fill = editableFill;
          } else {
            const rate = r.count > 0 ? Math.round(r.amount / r.count) : 0;
            pCell.value = rate;
            pCell.fill = editableFill;
          }
          pCell.numFmt = moneyFmt;
          const tCell = ws.getCell(`E${curRow}`);
          const amountV = mode === "cobrar" ? Number(r.chargedAmount) || 0 : Number(r.amount) || 0;
          tCell.value = { formula: `C${curRow}*D${curRow}`, result: amountV };
          tCell.numFmt = moneyFmt;
          curRow++;
        }
        const dataEndRow = curRow - 1;

        const subRow = curRow;
        for (const col of cols) {
          ws.getCell(`${col}${subRow}`).fill = subtotalFill;
          ws.getCell(`${col}${subRow}`).font = { bold: true };
        }
        ws.getCell(`B${subRow}`).value = "Subtotal";
        const totalAmountForSheet = mode === "cobrar" ? (tg.chargedTotalAmount || 0) : tg.totalAmount;
        if (dataEndRow >= dataStartRow) {
          ws.getCell(`C${subRow}`).value = { formula: `SUM(C${dataStartRow}:C${dataEndRow})`, result: 0 };
          ws.getCell(`C${subRow}`).numFmt = "#,##0";
          ws.getCell(`E${subRow}`).value = { formula: `SUM(E${dataStartRow}:E${dataEndRow})`, result: totalAmountForSheet };
          ws.getCell(`E${subRow}`).numFmt = moneyFmt;
        }
        const fallbackTotal = mode === "cobrar" ? (tg.chargedTotalAmount || 0) : tg.totalAmount;
        sheetTotals.push({ displayName: `🚐 ${displayName}`, sheetName, totalRef: `'${sheetName}'!$E$${subRow}`, fallback: fallbackTotal });

        ws.getColumn(2).width = 14;
        ws.getColumn(3).width = 12;
        ws.getColumn(4).width = 12;
        ws.getColumn(5).width = 14;
        ws.views = [{ state: "frozen", ySplit: HEADER_ROW }];
      }

      // ============ HOJA TOTAL GENERAL ============
      const wsTotal = wb.addWorksheet(safeName("Total"));
      wsTotal.getColumn(1).width = 6;
      wsTotal.getCell("B2").value = mode === "cobrar" ? "TOTAL A FACTURAR" : "TOTAL GENERAL";
      wsTotal.getCell("B2").font = { bold: true, size: 14 };

      const HR = 4;
      const headerCols = ["B", "C"];
      ["Concepto", "Subtotal"].forEach((h, i) => {
        const c = wsTotal.getCell(`${headerCols[i]}${HR}`);
        c.value = h;
        c.font = { bold: true };
        c.fill = headerFill;
        c.alignment = { horizontal: i === 0 ? "left" : "right" };
      });

      let totalRow = HR + 1;
      const totalStart = totalRow;
      for (const st of sheetTotals) {
        wsTotal.getCell(`B${totalRow}`).value = st.displayName;
        const ref = wsTotal.getCell(`C${totalRow}`);
        ref.value = { formula: st.totalRef, result: st.fallback };
        ref.numFmt = moneyFmt;
        totalRow++;
      }
      const totalEnd = totalRow - 1;

      const grandRow = totalRow;
      wsTotal.getCell(`B${grandRow}`).value = mode === "cobrar" ? "TOTAL A FACTURAR" : "TOTAL GENERAL";
      wsTotal.getCell(`B${grandRow}`).font = { bold: true };
      wsTotal.getCell(`B${grandRow}`).fill = titleFill;
      const grand = wsTotal.getCell(`C${grandRow}`);
      const grandFallback = mode === "cobrar" ? grandTotalCobrar : grandTotalPagar;
      if (totalEnd >= totalStart) {
        grand.value = { formula: `SUM(C${totalStart}:C${totalEnd})`, result: grandFallback };
      } else {
        grand.value = 0;
      }
      grand.numFmt = moneyFmt;
      grand.font = { bold: true, size: 12 };
      grand.fill = titleFill;

      // En modo cobrar agregamos abajo: Valor IVA (19%) y total con IVA incluido.
      if (mode === "cobrar") {
        const ivaRow = grandRow + 1;
        wsTotal.getCell(`B${ivaRow}`).value = "Valor IVA (19%)";
        wsTotal.getCell(`B${ivaRow}`).font = { bold: true };
        const iva = wsTotal.getCell(`C${ivaRow}`);
        iva.value = { formula: `ROUND(C${grandRow}*0.19,0)`, result: Math.round((Number(grandFallback) || 0) * 0.19) };
        iva.numFmt = moneyFmt;
        iva.font = { bold: true };

        const totIvaRow = grandRow + 2;
        wsTotal.getCell(`B${totIvaRow}`).value = "IVA incluido";
        wsTotal.getCell(`B${totIvaRow}`).font = { bold: true, size: 12 };
        wsTotal.getCell(`B${totIvaRow}`).fill = titleFill;
        const totIva = wsTotal.getCell(`C${totIvaRow}`);
        totIva.value = { formula: `C${grandRow}+C${ivaRow}`, result: Math.round((Number(grandFallback) || 0) * 1.19) };
        totIva.numFmt = moneyFmt;
        totIva.font = { bold: true, size: 12 };
        totIva.fill = titleFill;
      }

      wsTotal.getColumn(2).width = 32;
      wsTotal.getColumn(3).width = 16;

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `resumen_${mode}_${(cycle?.label || "ciclo").replace(/[/\s]+/g, "_")}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Error al exportar: " + (err.message || err));
    } finally {
      setBusy("");
    }
  };

  const handlePrint = () => {
    if (!printRef.current) return;
    const html = printRef.current.outerHTML;
    const win = window.open("", "_blank", "width=900,height=700");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>${titles.main} — ${cycle?.label || ""}</title>
      <style>
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 20px; color: #000; margin: 0; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #888; padding: 6px 8px; font-size: 12px; }
        /* Repetir el encabezado de la tabla en cada hoja nueva cuando la
           tabla excede la página (Chrome/Firefox). */
        thead { display: table-header-group; }
        tfoot { display: table-row-group; }
        tr { page-break-inside: avoid; }
        @media print { @page { size: landscape; margin: 10mm; } }
      </style>
    </head><body>${html}</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 350);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`📊 Resumen ciclo — ${cycle?.label || ""}`}
      size="xl"
      footer={
        <>
          <button onClick={onClose} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
            Cerrar
          </button>
          <button onClick={handleCopy} disabled={busy === "copy"} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60">
            {busy === "copy" ? "Copiando..." : "📋 Copiar imagen"}
          </button>
          <button onClick={handleDownload} disabled={busy === "download"} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60">
            {busy === "download" ? "Descargando..." : "📥 Descargar PNG"}
          </button>
          <button onClick={handleXlsxSummary} disabled={busy === "xlsx"} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60">
            {busy === "xlsx" ? "Generando..." : "📊 Excel"}
          </button>
          <button onClick={handlePrint} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
            🖨 Imprimir
          </button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-md overflow-hidden border border-[var(--color-border)] text-xs">
          <button
            onClick={() => setMode("pagar")}
            className={`px-3 py-1.5 ${mode === "pagar" ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-medium" : "bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"}`}
          >
            Para pagar
          </button>
          <button
            onClick={() => setMode("cobrar")}
            className={`px-3 py-1.5 ${mode === "cobrar" ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-medium" : "bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"}`}
          >
            Para cobrar
          </button>
        </div>
        <button
          onClick={() => setShowTitleEditor((v) => !v)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
        >
          {showTitleEditor ? "▾" : "▸"} Personalizar títulos
        </button>
        {mode === "cobrar" && (
          <button
            onClick={() => setShowCobrarEditor((v) => !v)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
          >
            {showCobrarEditor ? "▾" : "▸"} Editar tarifas cobro
          </button>
        )}
        {mode === "cobrar" && (
          <button
            onClick={openImportModal}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
            title="Agregar días de otros ciclos de la misma faena/subfaena"
          >
            📥 Importar ciclos anteriores
          </button>
        )}
        {mode === "cobrar" && (
          <button
            onClick={() => setEditMode((v) => !v)}
            className={`rounded-md border px-2 py-1 text-xs ${editMode ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"}`}
            title={editMode ? "Ocultar controles de edición para copiar/imprimir limpio" : "Mostrar inputs y botones de edición"}
          >
            {editMode ? "✏️ Editando" : "🔒 Bloqueado"}
          </button>
        )}
        {mode === "cobrar" && (
          <>
            <button
              ref={colsBtnRef}
              onClick={() => setColsMenuOpen((v) => !v)}
              className={`rounded-md border px-2 py-1 text-xs ${hiddenColumns.size > 0 ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"}`}
              title="Mostrar / ocultar columnas"
            >
              👁 Columnas{hiddenColumns.size > 0 ? ` (${hiddenColumns.size} ocultas)` : ""}
            </button>
            {colsMenuOpen && (
              <ColumnsMenu
                anchorRef={colsBtnRef}
                hidden={hiddenColumns}
                onToggle={toggleColumn}
                onReset={resetColumns}
                onClose={() => setColsMenuOpen(false)}
              />
            )}
          </>
        )}
        {loading && <span className="text-xs text-[var(--color-muted)]">Cargando...</span>}
        <span className="ml-auto text-sm">
          <span className="text-[var(--color-muted)]">Total: </span>
          <span className="font-semibold tabular-nums">
            {fmtCurrency(mode === "cobrar" ? grandTotalCobrar : grandTotalPagar)}
          </span>
        </span>
      </div>

      {showTitleEditor && (
        <TitlesEditor
          titles={titles}
          labors={cycle?.labors || []}
          carriers={transportData.map((t) => ({ id: t.carrierId, label: carrierById.get(t.carrierId)?.alias || t.carrierId }))}
          onChange={updateTitles}
          onLaborNameChange={updateLaborName}
          onCarrierNameChange={updateCarrierName}
        />
      )}

      {mode === "cobrar" && showCobrarEditor && (
        <CobrarEditor
          labors={cobrarLabors}
          carriers={cobrarCarriers}
          carrierById={carrierById}
          onLaborChange={updateCobrarLabor}
          onCarrierChange={updateCobrarCarrier}
        />
      )}

      <div ref={printRef}>
        <PrintableSummary
          mode={mode}
          editMode={editMode}
          hiddenColumns={hiddenColumns}
          titles={titles}
          labors={mode === "cobrar" ? cobrarLabors : laborsData}
          carriers={mode === "cobrar" ? cobrarCarriers : transportData}
          carrierById={carrierById}
          grandTotal={mode === "cobrar" ? grandTotalCobrar : grandTotalPagar}
          catalogs={catalogs}
          dayPrices={dayPrices}
          editLaborRow={editCobrarLaborRow}
          addLaborRow={addCobrarLaborExtraRow}
          removeLaborRow={removeCobrarLaborExtraRow}
          editCarrierRow={editCobrarCarrierRow}
          addCarrierRow={addCobrarCarrierExtraRow}
          removeCarrierRow={removeCobrarCarrierExtraRow}
        />
        {/* Resumen por trabajador (workers × dates), una infografía por
            labor. Solo se muestra en modo "pagar" — el cobrar es por
            tarifa pactada, no por desglose por trabajador. */}
        {mode === "pagar" && laborWorkerGrids.map((g) => (
          <LaborWorkerGrid
            key={g.labor.id}
            labor={g.labor}
            displayName={titles.laborNames?.[g.labor.id] || g.labor.name}
            unit={laborsData.find((ld) => ld.labor.id === g.labor.id)?.unit || ""}
            catalogs={catalogs}
            containers={g.containers}
            workers={g.workers}
            dates={g.dates}
            anyPiso={g.anyPiso}
            titles={titles}
            dayPrices={dayPrices}
          />
        ))}
      </div>

      {importOpen && (
        <ImportCyclesModal
          open={importOpen}
          onClose={() => setImportOpen(false)}
          cycles={availableCycles}
          alreadyImported={importedCycleIds}
          selected={selectedImportIds}
          onToggle={toggleImportCycle}
          onConfirm={handleImportCycles}
          busy={busy === "import"}
        />
      )}
    </Modal>
  );
}

// ============================================================
// Popover: Mostrar / ocultar columnas (cobrar mode)
// ============================================================
// Lista las claves de columna que pueden ocultarse globalmente en todas las
// tablas del resumen cobrar. Persiste en `cobrar.hiddenColumns`. Las keys
// coinciden con los gates `hiddenColumns.has(key)` dentro de LaborTable /
// TransportTable. Algunas keys aplican solo a ciertos tipos (he/bonos a
// tratoHE; piso cuando hay piso registrado) — ocultarlas no rompe nada en
// otras tablas.
const COLUMN_OPTIONS = [
  { key: "qty", label: "Base $ / Unidad / Vueltas" },
  { key: "he", label: "HE (hrs) — tratoHE" },
  { key: "rate", label: "Total HE / Valor" },
  { key: "valorTotal", label: "Valor total" },
  { key: "piso", label: "Piso" },
  { key: "transport", label: "Transporte" },
  { key: "total", label: "Total" },
  { key: "personas", label: "Personas" },
  { key: "bonos", label: "Bonos — tratoHE" },
];

function ColumnsMenu({ anchorRef, hidden, onToggle, onReset, onClose }) {
  // Posicionamos el popover en coordenadas viewport-relative (fixed) usando
  // el rect del botón ancla. Renderizado via portal en <body> para escapar
  // del overflow del Modal padre — sin esto el popover quedaba recortado
  // cuando el usuario ocultaba columnas y el botón se desplazaba.
  const POPOVER_WIDTH = 256; // = w-64
  const MARGIN = 8;
  const [pos, setPos] = useState(null);

  useEffect(() => {
    const recompute = () => {
      const el = anchorRef?.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Alineamos el borde derecho del popover con el borde derecho del botón.
      const left = Math.max(MARGIN, Math.min(window.innerWidth - POPOVER_WIDTH - MARGIN, r.right - POPOVER_WIDTH));
      const top = r.bottom + 4;
      setPos({ top, left });
    };
    recompute();
    window.addEventListener("resize", recompute);
    window.addEventListener("scroll", recompute, true);
    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("scroll", recompute, true);
    };
  }, [anchorRef]);

  if (!pos) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[1000]" onClick={onClose} />
      <div
        className="fixed z-[1001] w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-lg"
        style={{ top: pos.top, left: pos.left }}
      >
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
          <span>Columnas visibles</span>
          <button
            onClick={onReset}
            className="rounded px-1 py-0.5 text-[10px] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
          >
            Mostrar todas
          </button>
        </div>
        <ul className="space-y-0.5">
          {COLUMN_OPTIONS.map((c) => {
            const isHidden = hidden.has(c.key);
            return (
              <li key={c.key}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]">
                  <input
                    type="checkbox"
                    checked={!isHidden}
                    onChange={() => onToggle(c.key)}
                  />
                  <span className={isHidden ? "text-[var(--color-muted)] line-through" : ""}>{c.label}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>
    </>,
    document.body,
  );
}

// ============================================================
// Modal: Importar ciclos anteriores
// ============================================================
// Sub-modal del CycleSummaryModal (cobrar mode). Lista ciclos de la misma
// faena+subfaena para que el usuario elija cuáles importar; cada día de cada
// labor matcheada se inyecta como `extraRow` (con badge de origen).
function ImportCyclesModal({ open, onClose, cycles, alreadyImported, selected, onToggle, onConfirm, busy }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-baseline justify-between border-b border-[var(--color-border)] px-5 py-3">
          <div>
            <h2 className="text-lg font-semibold">📥 Importar ciclos anteriores</h2>
            <p className="text-xs text-[var(--color-muted)]">
              Misma faena/subfaena. Las labores se mergean por nombre. Los ya importados quedan deshabilitados.
            </p>
          </div>
          <button onClick={onClose} className="text-[var(--color-muted)] hover:text-[var(--color-text)]">✕</button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {cycles.length === 0 ? (
            <p className="rounded-md border border-dashed border-[var(--color-border)] py-6 text-center text-sm text-[var(--color-muted)]">
              No hay otros ciclos en esta faena/subfaena.
            </p>
          ) : (
            <ul className="space-y-1">
              {cycles.map((c) => {
                const checked = selected.has(c.id);
                const alreadyDone = alreadyImported?.has(c.id);
                return (
                  <li key={c.id}>
                    <label
                      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                        alreadyDone
                          ? "cursor-not-allowed border-[var(--color-border)] bg-[var(--color-surface-2)] opacity-60"
                          : checked
                            ? "cursor-pointer border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                            : "cursor-pointer border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={alreadyDone}
                        onChange={() => onToggle(c.id)}
                      />
                      <div className="flex-1">
                        <div className="font-medium">
                          {c.label || c.id}
                          {alreadyDone && (
                            <span className="ml-2 rounded bg-[var(--color-success-bg,#dcfce7)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--color-success,#166534)]">
                              ✓ ya importado
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-[var(--color-muted)]">
                          {c.status || "—"} · {(c.labors || []).length} labor{(c.labors || []).length === 1 ? "" : "es"}
                        </div>
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--color-border)] px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={busy || selected.size === 0}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Importando..." : `Importar ${selected.size} ciclo${selected.size === 1 ? "" : "s"}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ============================================================
// Editors
// ============================================================

function TitlesEditor({ titles, labors, carriers, onChange, onLaborNameChange, onCarrierNameChange }) {
  return (
    <div className="mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--color-muted)]">
        Títulos del resumen (se guardan localmente)
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <label className="block">
          <span className="block text-[10px] text-[var(--color-muted)]">Título principal</span>
          <input
            value={titles.main || ""}
            onChange={(e) => onChange({ main: e.target.value })}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] text-[var(--color-muted)]">Subtítulo (razón social / cliente)</span>
          <input
            value={titles.subtitle || ""}
            onChange={(e) => onChange({ subtitle: e.target.value })}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>
      </div>
      {labors.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[10px] text-[var(--color-muted)]">Alias por labor (opcional)</div>
          <div className="grid gap-1.5 md:grid-cols-2">
            {labors.map((l) => (
              <label key={l.id} className="flex items-center gap-2 text-xs">
                <span className="w-32 truncate text-[var(--color-muted)]">{l.name}</span>
                <input
                  value={titles.laborNames?.[l.id] || ""}
                  placeholder={l.name}
                  onChange={(e) => onLaborNameChange(l.id, e.target.value)}
                  className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 outline-none focus:border-[var(--color-accent)]"
                />
              </label>
            ))}
          </div>
        </div>
      )}
      {carriers.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[10px] text-[var(--color-muted)]">Alias por transportista (opcional)</div>
          <div className="grid gap-1.5 md:grid-cols-2">
            {carriers.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-xs">
                <span className="w-32 truncate text-[var(--color-muted)]">{c.label}</span>
                <input
                  value={titles.carrierNames?.[c.id] || ""}
                  placeholder={c.label}
                  onChange={(e) => onCarrierNameChange(c.id, e.target.value)}
                  className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 outline-none focus:border-[var(--color-accent)]"
                />
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CobrarEditor({ labors, carriers, carrierById, onLaborChange, onCarrierChange }) {
  return (
    <div className="mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--color-muted)]">
        Tarifas para cobrar (se guardan localmente)
      </div>
      <div className="overflow-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-[var(--color-muted)]">
            <tr>
              <th className="px-2 py-1">Incluir</th>
              <th className="px-2 py-1">Concepto</th>
              <th className="px-2 py-1 text-right">Cantidad</th>
              <th className="px-2 py-1 text-right" title="Mediana del precio por día — robusta a outliers como una jornada mensual. Entre paréntesis el promedio simple cuando difiere.">
                Pago tipo
              </th>
              <th className="px-2 py-1 text-right">Tarifa cobro</th>
              <th className="px-2 py-1 text-right">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {labors.map((l) => {
              const showMeanHint =
                l.meanRate &&
                l.medianRate &&
                Math.abs(l.meanRate - l.medianRate) / Math.max(1, l.medianRate) > 0.1;
              return (
              <tr key={l.labor.id} className="border-t border-[var(--color-border)]">
                <td className="px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={l.include}
                    onChange={(e) => onLaborChange(l.labor.id, { include: e.target.checked })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  {l.activity && (
                    <div>
                      <span className="rounded-full bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-accent)]">
                        {l.activity}
                      </span>
                    </div>
                  )}
                  <div className="mt-0.5">
                    <span className="font-medium">{l.labor.name}</span>
                    <span className="ml-1 text-[var(--color-muted)]">({l.unit.toLowerCase()})</span>
                  </div>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmtNumber(l.totals.qty)}</td>
                <td className="px-2 py-1.5 text-right text-[var(--color-muted)] tabular-nums">
                  <div>{fmtCurrency(l.defaultRate)}</div>
                  {showMeanHint && (
                    <div
                      className="text-[10px] opacity-70"
                      title="Promedio simple — sube/baja con outliers; la mediana es lo que ves arriba."
                    >
                      prom. {fmtCurrency(l.meanRate)}
                    </div>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <input
                    type="number"
                    value={l.rate || ""}
                    placeholder="0"
                    onChange={(e) => onLaborChange(l.labor.id, { chargeRate: Number(e.target.value) || 0 })}
                    className="w-24 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-right tabular-nums outline-none focus:border-[var(--color-accent)]"
                  />
                </td>
                <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                  {l.include ? fmtCurrency(l.totals.qty * l.rate) : <span className="text-[var(--color-muted)]">—</span>}
                </td>
              </tr>
              );
            })}
            {carriers.map((c) => {
              const ci = carrierById.get(c.carrierId);
              return (
                <tr key={c.carrierId} className="border-t border-[var(--color-border)]">
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={c.include}
                      onChange={(e) => onCarrierChange(c.carrierId, { include: e.target.checked })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    🚐 <span className="font-medium">{ci ? ci.alias : c.carrierId}</span>
                    <span className="ml-1 text-[var(--color-muted)]">(vueltas)</span>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{c.totalCount}</td>
                  <td className="px-2 py-1.5 text-right text-[var(--color-muted)] tabular-nums">{fmtCurrency(c.defaultRate)}</td>
                  <td className="px-2 py-1.5 text-right">
                    <input
                      type="number"
                      value={c.rate || ""}
                      placeholder="0"
                      onChange={(e) => onCarrierChange(c.carrierId, { chargeRate: Number(e.target.value) || 0 })}
                      className="w-24 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-right tabular-nums outline-none focus:border-[var(--color-accent)]"
                    />
                  </td>
                  <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                    {c.include ? fmtCurrency(c.totalCount * c.rate) : <span className="text-[var(--color-muted)]">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// Printable
// ============================================================

const PrintableSummary = forwardRef(function PrintableSummary(
  {
    mode,
    editMode = true,
    hiddenColumns = new Set(),
    titles,
    labors,
    carriers,
    carrierById,
    grandTotal,
    catalogs,
    dayPrices = {},
    editLaborRow,
    addLaborRow,
    removeLaborRow,
    editCarrierRow,
    addCarrierRow,
    removeCarrierRow,
  },
  ref,
) {
  return (
    <div ref={ref} style={{ background: "#ffffff", color: "#000", padding: 20, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 24, marginBottom: 16 }}>
        <img src={LOGO_URL} alt="logo" crossOrigin="anonymous" style={{ width: 90, height: 90, objectFit: "contain", flexShrink: 0 }} />
        <div style={{ textAlign: "center" }}>
          <div style={{ fontWeight: 700, fontSize: 18, letterSpacing: 1 }}>{titles.main || "DETALLE DE JORNADA"}</div>
          {titles.subtitle && <div style={{ marginTop: 6, fontSize: 14 }}>{titles.subtitle}</div>}
        </div>
        <div style={{ width: 90 }} />
      </div>

      {/* Per-labor day-by-day tables */}
      {labors.map((ld) => {
        if (mode === "cobrar" && ld.include === false) return null;
        const displayName = titles.laborNames?.[ld.labor.id] || ld.labor.name;
        // Para tratoHE: marcar sábados/domingos/feriados en rojo en la
        // columna Fecha (mismo criterio que el grid del trabajador).
        let redDates = null;
        if (ld.labor.type === "tratoHE") {
          redDates = new Set();
          const sourceRows = mode === "cobrar" ? (ld.chargedRows || ld.rows) : ld.rows;
          for (const r of sourceRows) {
            if (!r.date) continue;
            const cfg = getDaySingle(dayPrices, ld.labor.id, r.date, "normal");
            if (isRedDay(r.date, cfg)) redDates.add(r.date);
          }
        }
        // En cobrar usamos chargedRows (incluyen overrides + extras) y chargedTotals.
        const tableRows = mode === "cobrar" ? (ld.chargedRows || ld.rows) : ld.rows;
        const tableTotals = mode === "cobrar" ? (ld.chargedTotals || ld.totals) : ld.totals;
        return (
          <LaborTable
            key={ld.labor.id}
            laborId={ld.labor.id}
            displayName={displayName}
            unit={ld.unit}
            laborType={ld.labor.type}
            overtimeRate={Number(ld.labor.overtimeRate) > 0 ? Number(ld.labor.overtimeRate) : 3500}
            rows={tableRows}
            totals={tableTotals}
            mode={mode}
            editMode={editMode}
            hiddenColumns={hiddenColumns}
            chargeRate={mode === "cobrar" ? ld.rate : null}
            catalogs={catalogs}
            redDates={redDates}
            onEditRow={editLaborRow}
            onAddRow={addLaborRow}
            onRemoveRow={removeLaborRow}
          />
        );
      })}

      {/* Transport tables (one per carrier) */}
      {carriers.map((tg) => {
        if (mode === "cobrar" && tg.include === false) return null;
        const c = carrierById.get(tg.carrierId);
        const fallbackName = c?.alias || c?.name || "(transportista eliminado)";
        const displayName = titles.carrierNames?.[tg.carrierId] || fallbackName;
        const tableRows = mode === "cobrar" ? (tg.chargedRows || tg.rows) : tg.rows;
        const totalCount = mode === "cobrar" ? (tg.chargedTotalCount ?? tg.totalCount) : tg.totalCount;
        const totalAmount = mode === "cobrar" ? (tg.chargedTotalAmount ?? tg.totalAmount) : tg.totalAmount;
        return (
          <TransportTable
            key={tg.carrierId}
            carrierId={tg.carrierId}
            displayName={displayName}
            rows={tableRows}
            totalCount={totalCount}
            totalAmount={totalAmount}
            mode={mode}
            editMode={editMode}
            hiddenColumns={hiddenColumns}
            chargeRate={mode === "cobrar" ? tg.rate : null}
            onEditRow={editCarrierRow}
            onAddRow={addCarrierRow}
            onRemoveRow={removeCarrierRow}
          />
        );
      })}

      {/* Grand total — en modo cobrar incluye desglose de IVA (19%) abajo. */}
      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 12 }}>
        <tbody>
          <tr style={{ background: "#a9d08e" }}>
            <td style={{ ...cell, fontWeight: 700, fontSize: 14 }}>
              {mode === "cobrar" ? "TOTAL A FACTURAR" : "TOTAL GENERAL"}
            </td>
            <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
              {fmtCurrency(grandTotal)}
            </td>
          </tr>
          {mode === "cobrar" && (
            <>
              <tr style={{ background: "#fff" }}>
                <td style={{ ...cell, fontWeight: 600 }}>Valor IVA (19%)</td>
                <td style={{ ...cell, textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                  {fmtCurrency(Math.round((Number(grandTotal) || 0) * 0.19))}
                </td>
              </tr>
              <tr style={{ background: "#c6efce" }}>
                <td style={{ ...cell, fontWeight: 700, fontSize: 14 }}>IVA incluido</td>
                <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
                  {fmtCurrency(Math.round((Number(grandTotal) || 0) * 1.19))}
                </td>
              </tr>
            </>
          )}
        </tbody>
      </table>
    </div>
  );
});

// Estilos compartidos para los inputs editables en modo cobrar. Fondo amarillo
// para señalar visualmente las celdas modificables (igual que en el XLSX).
const cobrarInputStyle = {
  width: 90,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
  border: "1px solid #ccc",
  borderRadius: 3,
  padding: "1px 4px",
  background: "#fffbeb",
  fontSize: 12,
};
const cobrarDateInputStyle = {
  border: "1px solid #ccc",
  borderRadius: 3,
  padding: "1px 4px",
  background: "#fffbeb",
  fontSize: 12,
};
const inputVal = (v) => (v === 0 || v == null || v === "") ? "" : v;

function LaborTable({
  laborId,
  displayName,
  unit,
  laborType,
  overtimeRate = 3500,
  rows,
  totals,
  mode,
  editMode = true,
  hiddenColumns = new Set(),
  chargeRate,
  catalogs,
  redDates,
  onEditRow,
  onAddRow,
  onRemoveRow,
}) {
  const isCobrar = mode === "cobrar";
  const editable = isCobrar && editMode;
  if (rows.length === 0 && !isCobrar) return null;
  const showPiso = (totals.pisoAmount || 0) > 0;
  const isHE = laborType === "tratoHE";
  // Helper: cada columna chequea si su key está en hiddenColumns.
  const showCol = (key) => !hiddenColumns.has(key);

  // En cobrar las filas vienen pre-cargadas con chargedQty/chargedOvertimeHours/
  // chargedRate/chargedAmount (overrides aplicados). En pagar leemos los campos
  // directos del workday agregado.
  const rowQty = (r) => isCobrar ? r.chargedQty : r.qty;
  const rowHE = (r) => isCobrar ? r.chargedOvertimeHours : r.overtimeHours;
  // Total HE (tratoHE) = HE_hrs × tarifa HE del ciclo. Para los demás tipos
  // mantenemos "Valor" = $/unidad (amount/qty).
  const rowHeTotal = (r) => (Number(rowHE(r)) || 0) * overtimeRate;
  const rowRate = (r) => {
    if (isHE) return rowHeTotal(r);
    if (isCobrar) return r.chargedRate;
    return r.qty > 0 ? Math.round(r.amount / r.qty) : 0;
  };
  const rowValorTotal = (r) => isCobrar ? r.chargedAmount : r.amount;

  const handleField = (r, field, raw) => {
    if (!onEditRow) return;
    const value = raw === "" ? "" : Number(raw);
    onEditRow(laborId, r, { [field]: value });
  };
  const handleDateChange = (r, raw) => {
    if (!onEditRow) return;
    onEditRow(laborId, r, { date: raw });
  };
  const handleAdd = () => { if (onAddRow) onAddRow(laborId); };
  const handleRemove = (extraId) => { if (onRemoveRow) onRemoveRow(laborId, extraId); };

  return (
    <div style={{ marginBottom: 14 }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ background: "#9dc3e6" }}>
            <th style={cellH}>Detalle de jornada</th>
            <th style={cellH}>Fecha</th>
            {isHE ? (
              <>
                {showCol("qty") && <th style={{ ...cellH, textAlign: "right" }}>Base $</th>}
                {showCol("he") && <th style={{ ...cellH, textAlign: "right" }}>HE (hrs)</th>}
              </>
            ) : (
              showCol("qty") && <th style={{ ...cellH, textAlign: "right" }}>{unit}</th>
            )}
            {showCol("rate") && <th style={{ ...cellH, textAlign: "right" }}>{isHE ? "Total HE" : "Valor"}</th>}
            {showCol("valorTotal") && <th style={{ ...cellH, textAlign: "right" }}>Valor total</th>}
            {showPiso && showCol("piso") && <th style={{ ...cellH, textAlign: "right" }}>Piso</th>}
            {showCol("transport") && <th style={cellH}>Transporte</th>}
            {showCol("total") && <th style={{ ...cellH, textAlign: "right" }}>Total</th>}
            {showCol("personas") && <th style={{ ...cellH, textAlign: "right" }}>Personas</th>}
            {isHE && showCol("bonos") && <th style={{ ...cellH, textAlign: "right" }}>Bonos</th>}
            {editable && <th style={{ ...cellH, width: 24 }}></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const piso = Number(r.pisoAmount) || 0;
            const qty = rowQty(r);
            const heHrs = rowHE(r);
            const rate = rowRate(r);
            const valorTotal = rowValorTotal(r);
            const totalCol = isCobrar ? valorTotal : valorTotal + piso;
            const dateIsRed = isHE && redDates && r.date && redDates.has(r.date);
            const dateCellStyle = dateIsRed ? { ...cell, color: "#c00", fontWeight: 700 } : cell;
            const rowKey = r.rowKey || r.date || `r${Math.random()}`;
            return (
              <tr key={rowKey}>
                <td style={cell}>
                  {displayName}
                  {r.isExtra && editable && (
                    <span style={{ color: "#888", marginLeft: 4, fontSize: 10 }}>
                      {r.sourceCycleLabel ? `(de ${r.sourceCycleLabel})` : "(ajuste)"}
                    </span>
                  )}
                </td>
                <td style={dateCellStyle}>
                  {editable && r.isExtra ? (
                    <input
                      type="date"
                      value={r.date || ""}
                      onChange={(e) => handleDateChange(r, e.target.value)}
                      style={cobrarDateInputStyle}
                    />
                  ) : (
                    dateLabel(r.date)
                  )}
                </td>
                {isHE ? (
                  <>
                    {showCol("qty") && (
                      <td style={{ ...cell, textAlign: "right", padding: editable ? 3 : "5px 8px" }}>
                        {editable ? (
                          <input
                            type="number"
                            value={inputVal(qty)}
                            onChange={(e) => handleField(r, "qty", e.target.value)}
                            style={cobrarInputStyle}
                          />
                        ) : (qty > 0 ? fmtCurrency(qty) : "")}
                      </td>
                    )}
                    {showCol("he") && (
                      <td style={{ ...cell, textAlign: "right", padding: editable ? 3 : "5px 8px" }}>
                        {editable ? (
                          <input
                            type="number"
                            step="0.25"
                            value={inputVal(heHrs)}
                            onChange={(e) => handleField(r, "overtimeHours", e.target.value)}
                            style={cobrarInputStyle}
                          />
                        ) : (heHrs > 0 ? fmtNumber(heHrs) : "")}
                      </td>
                    )}
                  </>
                ) : (
                  showCol("qty") && (
                    <td style={{ ...cell, textAlign: "right", padding: editable ? 3 : "5px 8px" }}>
                      {editable ? (
                        <input
                          type="number"
                          value={inputVal(qty)}
                          onChange={(e) => handleField(r, "qty", e.target.value)}
                          style={cobrarInputStyle}
                        />
                      ) : formatRowMetric(r, laborType, catalogs)}
                    </td>
                  )
                )}
                {showCol("rate") && (
                  <td style={{ ...cell, textAlign: "right", padding: (editable && !isHE) ? 3 : "5px 8px" }}>
                    {isHE ? (
                      rate > 0 ? fmtCurrency(rate) : ""
                    ) : editable ? (
                      <input
                        type="number"
                        value={inputVal(rate)}
                        onChange={(e) => handleField(r, "rate", e.target.value)}
                        style={cobrarInputStyle}
                      />
                    ) : (rate > 0 ? fmtCurrency(rate) : "")}
                  </td>
                )}
                {showCol("valorTotal") && (
                  <td style={{ ...cell, textAlign: "right", padding: editable ? 3 : "5px 8px" }}>
                    {editable ? (
                      <input
                        type="number"
                        value={inputVal(valorTotal)}
                        onChange={(e) => handleField(r, "amount", e.target.value)}
                        style={{ ...cobrarInputStyle, fontWeight: 600 }}
                        title="Sobreescribe el cálculo qty × rate. Borrá para volver al auto."
                      />
                    ) : fmtCurrency(valorTotal)}
                  </td>
                )}
                {showPiso && showCol("piso") && (
                  <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums", color: piso > 0 ? "#b45309" : "#999" }}>
                    {piso > 0 ? `${r.pisoCount > 1 ? `${r.pisoCount}× ` : ""}${fmtCurrency(piso)}` : "—"}
                  </td>
                )}
                {showCol("transport") && <td style={{ ...cell, textAlign: "right", color: "#999" }}>$ -</td>}
                {showCol("total") && (
                  <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{fmtCurrency(totalCol)}</td>
                )}
                {showCol("personas") && (
                  <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {(r.workerCount || 0) > 0 ? r.workerCount : (r.isExtra ? "—" : 0)}
                  </td>
                )}
                {isHE && showCol("bonos") && (
                  <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums", color: (r.bonosTotal || 0) > 0 ? "#b45309" : "#999" }}>
                    {(r.bonosTotal || 0) > 0 ? fmtCurrency(r.bonosTotal) : "—"}
                  </td>
                )}
                {editable && (
                  <td style={{ ...cell, textAlign: "center", padding: 2 }}>
                    {r.isExtra && (
                      <button
                        type="button"
                        onClick={() => handleRemove(r.extraId)}
                        title="Eliminar fila"
                        style={{ background: "transparent", border: "none", cursor: "pointer", color: "#b91c1c", fontSize: 14, padding: 0 }}
                      >
                        ✕
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
          {editable && onAddRow && (
            <tr>
              <td
                colSpan={
                  2
                  + (isHE ? (Number(showCol("qty")) + Number(showCol("he"))) : Number(showCol("qty")))
                  + Number(showCol("rate"))
                  + Number(showCol("valorTotal"))
                  + (showPiso ? Number(showCol("piso")) : 0)
                  + Number(showCol("transport"))
                  + Number(showCol("total"))
                  + Number(showCol("personas"))
                  + (isHE ? Number(showCol("bonos")) : 0)
                  + 1
                }
                style={{ ...cell, padding: 4, textAlign: "left", background: "#f9fafb" }}
              >
                <button
                  type="button"
                  onClick={handleAdd}
                  style={{ background: "transparent", border: "1px dashed #999", borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 11 }}
                >
                  + Agregar día / ajuste manual
                </button>
              </td>
            </tr>
          )}
          <tr style={{ background: "#c6efce" }}>
            <td style={{ ...cell, fontWeight: 700 }} colSpan={2}>Subtotal {displayName}</td>
            {isHE ? (
              <>
                {showCol("qty") && (
                  <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                    {totals.qty > 0 ? fmtCurrency(totals.qty) : ""}
                  </td>
                )}
                {showCol("he") && (
                  <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                    {totals.overtimeHours > 0 ? fmtNumber(totals.overtimeHours) : ""}
                  </td>
                )}
              </>
            ) : (
              showCol("qty") && (
                <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                  {isCobrar ? fmtNumber(totals.qty || 0) : formatTotalsMetric(totals, laborType, rows, catalogs)}
                </td>
              )
            )}
            {showCol("rate") && (
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {isHE && (totals.heTotal || 0) > 0 ? fmtCurrency(totals.heTotal) : ""}
              </td>
            )}
            {showCol("valorTotal") && (
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(totals.amount)}</td>
            )}
            {showPiso && showCol("piso") && (
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "#b45309" }}>
                {fmtCurrency(totals.pisoAmount || 0)}
              </td>
            )}
            {showCol("transport") && <td style={cell}></td>}
            {showCol("total") && (
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {fmtCurrency(isCobrar ? totals.amount : totals.amount + (totals.pisoAmount || 0))}
              </td>
            )}
            {showCol("personas") && (
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {(totals.workerDays || 0) > 0 ? totals.workerDays : ""}
              </td>
            )}
            {isHE && showCol("bonos") && (
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "#b45309" }}>
                {(totals.bonosTotal || 0) > 0 ? fmtCurrency(totals.bonosTotal) : "—"}
              </td>
            )}
            {editable && <td style={cell}></td>}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function TransportTable({
  carrierId,
  displayName,
  rows,
  totalCount,
  totalAmount,
  mode,
  editMode = true,
  hiddenColumns = new Set(),
  chargeRate,
  onEditRow,
  onAddRow,
  onRemoveRow,
}) {
  const isCobrar = mode === "cobrar";
  const editable = isCobrar && editMode;
  if (rows.length === 0 && !isCobrar) return null;
  const showCol = (key) => !hiddenColumns.has(key);

  const rowCount = (r) => isCobrar ? r.chargedCount : r.count;
  const rowRate = (r) => isCobrar
    ? r.chargedRate
    : (r.count > 0 ? Math.round(r.amount / r.count) : 0);
  const rowTotal = (r) => isCobrar ? r.chargedAmount : r.amount;

  const handleField = (r, field, raw) => {
    if (!onEditRow) return;
    const value = raw === "" ? "" : Number(raw);
    onEditRow(carrierId, r, { [field]: value });
  };
  const handleDateChange = (r, raw) => {
    if (!onEditRow) return;
    onEditRow(carrierId, r, { date: raw });
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ background: "#fbe5d6" }}>
            <th style={cellH}>🚐 Transporte</th>
            <th style={cellH}>Fecha</th>
            {showCol("qty") && <th style={{ ...cellH, textAlign: "right" }}>Vueltas</th>}
            {showCol("rate") && <th style={{ ...cellH, textAlign: "right" }}>Valor</th>}
            {showCol("total") && <th style={{ ...cellH, textAlign: "right" }}>Total</th>}
            {editable && <th style={{ ...cellH, width: 24 }}></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const count = rowCount(r);
            const rate = rowRate(r);
            const total = rowTotal(r);
            const rowKey = r.rowKey || r.date || `r${Math.random()}`;
            return (
              <tr key={rowKey}>
                <td style={cell}>
                  {displayName}
                  {r.isExtra && editable && (
                    <span style={{ color: "#888", marginLeft: 4, fontSize: 10 }}>
                      {r.sourceCycleLabel ? `(de ${r.sourceCycleLabel})` : "(ajuste)"}
                    </span>
                  )}
                </td>
                <td style={cell}>
                  {editable && r.isExtra ? (
                    <input
                      type="date"
                      value={r.date || ""}
                      onChange={(e) => handleDateChange(r, e.target.value)}
                      style={cobrarDateInputStyle}
                    />
                  ) : (
                    dateLabel(r.date)
                  )}
                </td>
                {showCol("qty") && (
                  <td style={{ ...cell, textAlign: "right", padding: editable ? 3 : "5px 8px" }}>
                    {editable ? (
                      <input
                        type="number"
                        value={inputVal(count)}
                        onChange={(e) => handleField(r, "count", e.target.value)}
                        style={cobrarInputStyle}
                      />
                    ) : count}
                  </td>
                )}
                {showCol("rate") && (
                  <td style={{ ...cell, textAlign: "right", padding: editable ? 3 : "5px 8px" }}>
                    {editable ? (
                      <input
                        type="number"
                        value={inputVal(rate)}
                        onChange={(e) => handleField(r, "rate", e.target.value)}
                        style={cobrarInputStyle}
                      />
                    ) : (rate > 0 ? fmtCurrency(rate) : "")}
                  </td>
                )}
                {showCol("total") && (
                  <td style={{ ...cell, textAlign: "right", padding: editable ? 3 : "5px 8px" }}>
                    {editable ? (
                      <input
                        type="number"
                        value={inputVal(total)}
                        onChange={(e) => handleField(r, "amount", e.target.value)}
                        style={{ ...cobrarInputStyle, fontWeight: 600 }}
                        title="Sobreescribe el cálculo vueltas × valor. Borrá para volver al auto."
                      />
                    ) : fmtCurrency(total)}
                  </td>
                )}
                {editable && (
                  <td style={{ ...cell, textAlign: "center", padding: 2 }}>
                    {r.isExtra && (
                      <button
                        type="button"
                        onClick={() => onRemoveRow && onRemoveRow(carrierId, r.extraId)}
                        title="Eliminar fila"
                        style={{ background: "transparent", border: "none", cursor: "pointer", color: "#b91c1c", fontSize: 14, padding: 0 }}
                      >
                        ✕
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
          {editable && onAddRow && (
            <tr>
              <td
                colSpan={2 + Number(showCol("qty")) + Number(showCol("rate")) + Number(showCol("total")) + 1}
                style={{ ...cell, padding: 4, textAlign: "left", background: "#f9fafb" }}
              >
                <button
                  type="button"
                  onClick={() => onAddRow(carrierId)}
                  style={{ background: "transparent", border: "1px dashed #999", borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 11 }}
                >
                  + Agregar viaje / ajuste manual
                </button>
              </td>
            </tr>
          )}
          <tr style={{ background: "#c6efce" }}>
            <td style={{ ...cell, fontWeight: 700 }} colSpan={2}>Subtotal {displayName}</td>
            {showCol("qty") && (
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{totalCount}</td>
            )}
            {showCol("rate") && <td style={cell}></td>}
            {showCol("total") && (
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {fmtCurrency(totalAmount)}
              </td>
            )}
            {editable && <td style={cell}></td>}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const cellH = { border: "1px solid #555", padding: "6px 8px", fontSize: 12, fontWeight: 700, textAlign: "left" };
const cell = { border: "1px solid #999", padding: "5px 8px", fontSize: 12 };

// ============================================================
// LaborWorkerGrid — grilla imprimible workers × dates, una por labor
// ============================================================
// Replica visualmente lo que se ve en el grid de CycleDetail pero solo lectura
// y optimizado para imprimir / capturar imagen. Tiene su propio ref +
// botones (📋 / 📥 / 🖨). Para impresión, el `<thead>` lleva
// `display: table-header-group` que hace que Chrome repita el encabezado en
// cada hoja nueva cuando la tabla excede la primera página.
function LaborWorkerGrid({
  labor,
  displayName,
  unit,
  catalogs,
  containers,
  workers: allWorkers,
  dates,
  anyPiso,
  titles,
  dayPrices = {},
}) {
  const ref = useRef(null);
  const [busy, setBusy] = useState("");
  // Vista ampliada: la grilla se renderiza en un Modal aparte para que se
  // pueda ver completa sin que rompa el layout del modal padre. Útil cuando
  // hay muchos días (>15) y el scroll horizontal inline es incómodo.
  const [expanded, setExpanded] = useState(false);

  // Filtro de trabajadores — set de ruts ocultos. Vacío = mostrar todos.
  // Se aplica al render del grid Y a los totales/XLSX, así el resumen
  // filtrado refleja solo el subgrupo seleccionado.
  const [hiddenRuts, setHiddenRuts] = useState(() => new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const workers = useMemo(
    () => allWorkers.filter((w) => !hiddenRuts.has(w.rut)),
    [allWorkers, hiddenRuts],
  );

  // Para tratoHE: marcamos en rojo sábados, domingos y días configurados como
  // feriado en el dayPrices del ciclo (mismo criterio que el grid). Para
  // otras labores el array queda vacío.
  const redDates = useMemo(() => {
    if (labor?.type !== "tratoHE") return new Set();
    const out = new Set();
    for (const d of dates) {
      const cfg = getDaySingle(dayPrices, labor.id, d, "normal");
      if (isRedDay(d, cfg)) out.add(d);
    }
    return out;
  }, [labor?.type, labor?.id, dates, dayPrices]);

  const filename = `resumen_trabajadores_${(labor?.name || "labor").replace(/[/\s]+/g, "_")}.png`;
  const xlsxFilename = `resumen_${(labor?.name || "labor").replace(/[/\s]+/g, "_")}.xlsx`;

  // Cuando la grilla es más ancha que el viewport, `html-to-image` puede
  // truncar al `offsetWidth` del elemento. Forzamos `width` / `height` desde
  // `scrollWidth` / `scrollHeight` para garantizar que el PNG contenga la
  // tabla completa, incluyendo las columnas de la derecha.
  const fullCaptureOpts = () => ({
    backgroundColor: "#ffffff",
    pixelRatio: 2,
    width: ref.current?.scrollWidth || undefined,
    height: ref.current?.scrollHeight || undefined,
  });

  const handleCopy = async () => {
    if (!ref.current) return;
    setBusy("copy");
    try {
      const blob = await toBlob(ref.current, fullCaptureOpts());
      if (!blob) throw new Error("No se pudo generar la imagen");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      alert("Imagen copiada al portapapeles");
    } catch (err) {
      alert("Error: " + (err.message || err));
    } finally {
      setBusy("");
    }
  };
  const handleDownload = async () => {
    if (!ref.current) return;
    setBusy("download");
    try {
      const dataUrl = await toPng(ref.current, fullCaptureOpts());
      const link = document.createElement("a");
      link.download = filename;
      link.href = dataUrl;
      link.click();
    } finally {
      setBusy("");
    }
  };
  // Exporta la grilla a XLSX con fórmulas Excel.
  // Restricciones de layout:
  //   - Col A vacía (width = 6, mitad de una columna normal de 12).
  //   - Fila 1 vacía.
  //   - Todos los datos arrancan desde la col B / fila 2.
  //
  // Por tipo:
  //   - tratoHE → 3 cols por día (Base, Horas, Extras). Tarifa HE editable
  //     al final. Total $ = TotalBase + TotalHoras × tarifa_HE + TotalExtras.
  //   - cosecha → 1 col por (día, combo) con kg + 1 col $ por día (fórmula).
  //     Precios por combo en celdas editables al inicio.
  //   - trato   → idem cosecha pero con tiers.
  //   - main/supervision/extra → 1 col por día con monto; totales son SUM.
  const handleXlsx = async () => {
    setBusy("xlsx");
    try {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(displayName.slice(0, 30) || "Resumen");

      const t = labor?.type;
      const isHE = t === "tratoHE";
      const isCosecha = t === "cosecha";
      const isTrato = t === "trato";
      const isMoneyOnly = !isCosecha && !isTrato && !isHE;

      const colLetter = (n) => {
        let s = "";
        let x = n;
        while (x > 0) {
          const r = (x - 1) % 26;
          s = String.fromCharCode(65 + r) + s;
          x = Math.floor((x - 1) / 26);
        }
        return s;
      };

      const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF9DC3E6" } };
      const TOTAL_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };
      const PRICE_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
      const RED_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };
      const thinBorder = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };
      const hairBorder = { top: { style: "hair" }, left: { style: "hair" }, bottom: { style: "hair" }, right: { style: "hair" } };

      // Restricciones de layout: col A vacía + fila 1 vacía.
      const COL_FIXED_START = 2; // col B = Trabajador
      const COL_RUT = 3; // col C = RUT

      // ────────────────────────────────────────────────────────────────────
      // Recolección de combos / tiers (cosecha / trato).
      // ────────────────────────────────────────────────────────────────────
      // combos: array ordenado de { key, label }. El PRECIO real varía por
      // (date, key); se obtiene del `dayPrices` y se renderiza en una fila
      // de precios DENTRO del header (no como referencia única arriba).
      let combos = [];
      if (isCosecha) {
        const seen = new Map(); // key -> { qx, cy }
        for (const w of workers) {
          for (const c of w.byDate.values()) {
            for (const [k, b] of c.byCombo) {
              if (!seen.has(k)) seen.set(k, { qx: b.qx, cy: b.cy });
            }
          }
        }
        combos = [...seen.entries()].map(([key, m]) => ({
          key,
          qx: m.qx, cy: m.cy,
          label: `${qualityLabel(catalogs, m.qx)}/${containerLabel(catalogs, m.cy)}`.toLowerCase(),
        })).sort((a, b) => a.key.localeCompare(b.key));
      } else if (isTrato) {
        const seen = new Map();
        for (const w of workers) {
          for (const c of w.byDate.values()) {
            for (const [k] of c.byTier) {
              if (!seen.has(k)) seen.set(k, true);
            }
          }
        }
        combos = [...seen.keys()].map((key) => {
          const idx = key.startsWith("t") ? Number(key.slice(1)) : 0;
          const ttLabel = tratoTypeLabel(catalogs, labor?.tratoType ?? 0);
          return { key, label: `T${idx + 1} ${ttLabel}`.trim() };
        }).sort((a, b) => a.key.localeCompare(b.key));
      }

      // Precio real por (date, key) desde dayPrices.
      // Usa los helpers que ya normalizan formatos legacy:
      //   - cosecha: getDayCombos devuelve [{ key:"x_y", price }, ...]
      //   - trato:   getTratoTiers devuelve [{ key:"tN", price }, ...]
      // Sin normalizar caería a 0 en docs legacy (price flat o "0_0"), que
      // es exactamente el síntoma que el usuario reportó como "precio constante".
      const priceFor = (date, key) => {
        if (!labor?.id) return 0;
        if (isCosecha) {
          const list = getDayCombos(dayPrices, labor.id, date, "unit");
          const hit = list.find((c) => c.key === key);
          return Number(hit?.price) || 0;
        }
        if (isTrato) {
          const list = getTratoTiers(dayPrices, labor.id, date, "unit");
          const hit = list.find((c) => c.key === key);
          return Number(hit?.price) || 0;
        }
        return 0;
      };

      let cursorRow = 2; // fila 1 vacía

      // ────────────────────────────────────────────────────────────────────
      // Header de la tabla principal.
      // ────────────────────────────────────────────────────────────────────
      const HEADER_ROW = cursorRow;
      const cellsPerDay = isHE ? 3 : (combos.length > 0 ? combos.length + 1 : 1);
      // tratoHE: Base / Horas / Extras por día
      // cosecha/trato con combos: 1 col por combo + 1 col Subtotal $
      // money-only o cosecha/trato sin combos: 1 col $

      const COL_FIRST_DAY = COL_RUT + 1;
      const COL_AFTER_DAYS = COL_FIRST_DAY + dates.length * cellsPerDay;

      // Cols de totales finales:
      let COL_TOTAL_BASE = null, COL_TOTAL_HORAS = null, COL_TOTAL_EXTRAS = null;
      let COL_TOTAL_QTY_BY_COMBO = []; // por combo
      let COL_TOTAL_AMT;
      if (isHE) {
        COL_TOTAL_BASE = COL_AFTER_DAYS;
        COL_TOTAL_HORAS = COL_AFTER_DAYS + 1;
        COL_TOTAL_EXTRAS = COL_AFTER_DAYS + 2;
        COL_TOTAL_AMT = COL_AFTER_DAYS + 3;
      } else if ((isCosecha || isTrato) && combos.length > 0) {
        // Una col total por combo + Total $.
        for (let i = 0; i < combos.length; i++) COL_TOTAL_QTY_BY_COMBO.push(COL_AFTER_DAYS + i);
        COL_TOTAL_AMT = COL_AFTER_DAYS + combos.length;
      } else if (isCosecha || isTrato) {
        // Sin combos detectados (raro): solo Total $.
        COL_TOTAL_AMT = COL_AFTER_DAYS;
      } else {
        COL_TOTAL_AMT = COL_AFTER_DAYS;
      }

      const headerRow = ws.getRow(HEADER_ROW);
      headerRow.getCell(COL_FIXED_START).value = "Trabajador";
      headerRow.getCell(COL_RUT).value = "RUT";

      // Para cosecha/trato con combos: TRIPLE fila de header
      //   Row 0: fecha (merged sobre las cols del día)
      //   Row 1: nombre del combo / tier + "$" para subtotal
      //   Row 2: PRECIO por combo (editable) + "" para la col $
      // tratoHE / money-only usan header simple en una fila.
      const useDoubleHeader = (isCosecha || isTrato) && combos.length > 0;
      const HEADER_ROW_2 = useDoubleHeader ? HEADER_ROW + 1 : null;
      const PRICE_HEADER_ROW = useDoubleHeader ? HEADER_ROW + 2 : null;
      const subHeaderRow = useDoubleHeader ? ws.getRow(HEADER_ROW_2) : null;
      const priceHeaderRow = useDoubleHeader ? ws.getRow(PRICE_HEADER_ROW) : null;

      dates.forEach((d, di) => {
        const lbl = dateLabel(d);
        const baseCol = COL_FIRST_DAY + di * cellsPerDay;
        const isRed = isHE && redDates.has(d);
        if (isHE) {
          headerRow.getCell(baseCol).value = `Base ${lbl}`;
          headerRow.getCell(baseCol + 1).value = `Horas ${lbl}`;
          headerRow.getCell(baseCol + 2).value = `Extras ${lbl}`;
          if (isRed) {
            for (let i = 0; i < 3; i++) {
              const cc = headerRow.getCell(baseCol + i);
              cc.fill = RED_FILL;
              cc.font = { bold: true, color: { argb: "FF9C0006" } };
            }
          }
        } else if (useDoubleHeader) {
          // Fila 1: la fecha merged sobre las (combo+1) columnas de ese día.
          headerRow.getCell(baseCol).value = lbl;
          ws.mergeCells(HEADER_ROW, baseCol, HEADER_ROW, baseCol + combos.length);
          // Fila 2: combo labels + "$"
          combos.forEach((cb, ci) => {
            subHeaderRow.getCell(baseCol + ci).value = cb.label;
          });
          subHeaderRow.getCell(baseCol + combos.length).value = "$";
          // Fila 3: precios reales del día por combo (editables).
          combos.forEach((cb, ci) => {
            const priceCell = priceHeaderRow.getCell(baseCol + ci);
            priceCell.value = priceFor(d, cb.key);
            priceCell.numFmt = '"$"#,##0';
            priceCell.fill = PRICE_FILL;
            priceCell.border = thinBorder;
            priceCell.font = { italic: true };
            priceCell.alignment = { horizontal: "center", vertical: "middle" };
          });
          // La celda $ del día queda en blanco en la fila de precios (es el
          // subtotal computado abajo, no un precio).
          const subAmtPriceCell = priceHeaderRow.getCell(baseCol + combos.length);
          subAmtPriceCell.value = "$";
          subAmtPriceCell.font = { italic: true, color: { argb: "FF888888" } };
          subAmtPriceCell.alignment = { horizontal: "center" };
        } else if (isCosecha || isTrato) {
          headerRow.getCell(baseCol).value = `${lbl} (${unit || "u"})`;
        } else {
          headerRow.getCell(baseCol).value = `${lbl} ($)`;
        }
      });

      // Totales finales en header.
      if (isHE) {
        headerRow.getCell(COL_TOTAL_BASE).value = "Total Base";
        headerRow.getCell(COL_TOTAL_HORAS).value = "Total Horas";
        headerRow.getCell(COL_TOTAL_EXTRAS).value = "Total Extras";
        headerRow.getCell(COL_TOTAL_AMT).value = "Total $";
      } else if ((isCosecha || isTrato) && combos.length > 0) {
        combos.forEach((cb, ci) => {
          headerRow.getCell(COL_TOTAL_QTY_BY_COMBO[ci]).value = `Total ${cb.label}`;
        });
        headerRow.getCell(COL_TOTAL_AMT).value = "Total $";
      } else if (isCosecha || isTrato) {
        headerRow.getCell(COL_TOTAL_AMT).value = `Total ${unit || "u"}`;
        const nextCol = COL_TOTAL_AMT + 1;
        headerRow.getCell(nextCol).value = "Total $";
      } else {
        headerRow.getCell(COL_TOTAL_AMT).value = "Total $";
      }

      // Estilos de header (filas 1 y 2 — la fila 3 de precios ya está estilada).
      const styleHeaderCell = (c) => {
        c.font = c.font?.color ? c.font : { bold: true };
        c.fill = c.fill || HEADER_FILL;
        c.border = thinBorder;
        c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      };
      headerRow.eachCell({ includeEmpty: false }, styleHeaderCell);
      if (subHeaderRow) subHeaderRow.eachCell({ includeEmpty: false }, styleHeaderCell);
      // Etiqueta "Precios →" en la col del nombre (fila de precios).
      if (priceHeaderRow) {
        const lbl = priceHeaderRow.getCell(COL_FIXED_START);
        lbl.value = "Precios →";
        lbl.font = { italic: true, color: { argb: "FF555555" } };
        lbl.alignment = { horizontal: "right" };
      }

      // ────────────────────────────────────────────────────────────────────
      // Filas de datos.
      // ────────────────────────────────────────────────────────────────────
      const DATA_START_ROW = useDoubleHeader ? HEADER_ROW + 3 : HEADER_ROW + 1;
      const DATA_END_ROW = DATA_START_ROW + workers.length - 1;

      workers.forEach((w, wi) => {
        const rowNum = DATA_START_ROW + wi;
        const row = ws.getRow(rowNum);
        row.getCell(COL_FIXED_START).value = w.name;
        row.getCell(COL_RUT).value = w.rut;

        dates.forEach((d, di) => {
          const c = w.byDate.get(d);
          const baseCol = COL_FIRST_DAY + di * cellsPerDay;
          if (isHE) {
            row.getCell(baseCol).value = Number(c?.base) || 0;
            row.getCell(baseCol + 1).value = Number(c?.overtimeHours) || 0;
            row.getCell(baseCol + 2).value = Number(c?.extras) || 0;
          } else if ((isCosecha || isTrato) && combos.length > 0) {
            // Por combo: qty en cada col, $ subtotal en última col (formula).
            const qtyCells = [];
            combos.forEach((cb, ci) => {
              const qtyCell = row.getCell(baseCol + ci);
              const qty = isCosecha
                ? Number(c?.byCombo?.get(cb.key)?.kilos) || 0
                : Number(c?.byTier?.get(cb.key)?.qty) || 0;
              qtyCell.value = qty;
              // Precio editable de ESE día/combo: fila PRICE_HEADER_ROW,
              // misma columna que la qty. Row absoluto, col relativa.
              const priceRef = `${colLetter(baseCol + ci)}$${PRICE_HEADER_ROW}`;
              qtyCells.push({
                ref: `${colLetter(baseCol + ci)}${rowNum}`,
                priceRef,
              });
            });
            const subAmtCell = row.getCell(baseCol + combos.length);
            // Fórmula: qty1*price1_dia + qty2*price2_dia + ...
            const parts = qtyCells.map((x) => `${x.ref}*${x.priceRef}`);
            subAmtCell.value = { formula: parts.join("+"), result: Number(c?.amount) || 0 };
          } else if (isCosecha || isTrato) {
            row.getCell(baseCol).value = Number(c?.qty) || 0;
          } else {
            row.getCell(baseCol).value = Number(c?.amount) || 0;
          }
        });

        // Totales por fila.
        if (isHE) {
          const baseCells = dates.map((_, di) => `${colLetter(COL_FIRST_DAY + di * 3)}${rowNum}`).join(",");
          const horasCells = dates.map((_, di) => `${colLetter(COL_FIRST_DAY + di * 3 + 1)}${rowNum}`).join(",");
          const extrasCells = dates.map((_, di) => `${colLetter(COL_FIRST_DAY + di * 3 + 2)}${rowNum}`).join(",");
          row.getCell(COL_TOTAL_BASE).value = { formula: `SUM(${baseCells})`, result: Number(w.totals.base) || 0 };
          row.getCell(COL_TOTAL_HORAS).value = { formula: `SUM(${horasCells})`, result: Number(w.totals.overtimeHours) || 0 };
          row.getCell(COL_TOTAL_EXTRAS).value = { formula: `SUM(${extrasCells})`, result: Number(w.totals.extras) || 0 };
          // Total $ se setea más abajo (después de armar la celda de tarifa HE).
          row.getCell(COL_TOTAL_AMT).value = Number(w.totals.amount) || 0;
        } else if ((isCosecha || isTrato) && combos.length > 0) {
          // Total por combo: SUM hacia la derecha tomando solo las cols de ese combo.
          combos.forEach((cb, ci) => {
            const cells = dates.map((_, di) => `${colLetter(COL_FIRST_DAY + di * cellsPerDay + ci)}${rowNum}`).join(",");
            const totQty = isCosecha
              ? [...w.byDate.values()].reduce((s, c) => s + (Number(c.byCombo?.get(cb.key)?.kilos) || 0), 0)
              : [...w.byDate.values()].reduce((s, c) => s + (Number(c.byTier?.get(cb.key)?.qty) || 0), 0);
            row.getCell(COL_TOTAL_QTY_BY_COMBO[ci]).value = { formula: `SUM(${cells})`, result: totQty };
          });
          // Total $: suma de los subtotales por día.
          const subAmtCells = dates.map((_, di) => `${colLetter(COL_FIRST_DAY + di * cellsPerDay + combos.length)}${rowNum}`).join(",");
          row.getCell(COL_TOTAL_AMT).value = { formula: `SUM(${subAmtCells})`, result: Number(w.totals.amount) || 0 };
        } else if (isCosecha || isTrato) {
          const dayCells = dates.map((_, di) => `${colLetter(COL_FIRST_DAY + di)}${rowNum}`).join(",");
          row.getCell(COL_TOTAL_AMT).value = { formula: `SUM(${dayCells})`, result: Number(w.totals.qty) || 0 };
          row.getCell(COL_TOTAL_AMT + 1).value = Number(w.totals.amount) || 0;
        } else {
          const dayCells = dates.map((_, di) => `${colLetter(COL_FIRST_DAY + di)}${rowNum}`).join(",");
          row.getCell(COL_TOTAL_AMT).value = { formula: `SUM(${dayCells})`, result: Number(w.totals.amount) || 0 };
        }

        // Formato celdas.
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          cell.border = hairBorder;
          if (colNumber < COL_FIRST_DAY) return; // Trabajador/RUT
          const isAmtCol = colNumber === COL_TOTAL_AMT;
          if (isMoneyOnly) {
            cell.numFmt = '"$"#,##0;[Red]"$"#,##0;""';
          } else if (isAmtCol) {
            cell.numFmt = '"$"#,##0';
          } else if (isHE) {
            const offset = colNumber - COL_FIRST_DAY;
            if (offset >= 0 && offset < dates.length * 3) {
              const kind = offset % 3; // 0 base ($), 1 horas (#), 2 extras ($)
              cell.numFmt = kind === 0 ? '"$"#,##0;[Red]-"$"#,##0;""'
                : kind === 1 ? "0.0;[Red]-0.0;\"\""
                : '"$"#,##0;[Red]-"$"#,##0;""';
            } else if (colNumber === COL_TOTAL_HORAS) {
              cell.numFmt = "#,##0.0";
            } else {
              cell.numFmt = '"$"#,##0';
            }
          } else if ((isCosecha || isTrato) && combos.length > 0) {
            const offset = colNumber - COL_FIRST_DAY;
            if (offset >= 0 && offset < dates.length * cellsPerDay) {
              const slot = offset % cellsPerDay;
              cell.numFmt = slot === cellsPerDay - 1 ? '"$"#,##0' : "#,##0";
            } else {
              cell.numFmt = "#,##0";
            }
          } else {
            cell.numFmt = '#,##0;[Red]-#,##0;""';
          }
        });
      });

      // ────────────────────────────────────────────────────────────────────
      // Fila Total día (footer).
      // ────────────────────────────────────────────────────────────────────
      const TOTAL_ROW = DATA_END_ROW + 1;
      const totalRow = ws.getRow(TOTAL_ROW);
      totalRow.getCell(COL_FIXED_START).value = "Total día";
      const sumDown = (col) => {
        const c = colLetter(col);
        return `SUM(${c}${DATA_START_ROW}:${c}${DATA_END_ROW})`;
      };
      dates.forEach((_, di) => {
        const baseCol = COL_FIRST_DAY + di * cellsPerDay;
        for (let i = 0; i < cellsPerDay; i++) {
          totalRow.getCell(baseCol + i).value = { formula: sumDown(baseCol + i), result: 0 };
        }
      });
      if (isHE) {
        totalRow.getCell(COL_TOTAL_BASE).value = { formula: sumDown(COL_TOTAL_BASE), result: 0 };
        totalRow.getCell(COL_TOTAL_HORAS).value = { formula: sumDown(COL_TOTAL_HORAS), result: 0 };
        totalRow.getCell(COL_TOTAL_EXTRAS).value = { formula: sumDown(COL_TOTAL_EXTRAS), result: 0 };
      } else if ((isCosecha || isTrato) && combos.length > 0) {
        COL_TOTAL_QTY_BY_COMBO.forEach((col) => {
          totalRow.getCell(col).value = { formula: sumDown(col), result: 0 };
        });
      } else if (isCosecha || isTrato) {
        totalRow.getCell(COL_TOTAL_AMT + 1).value = { formula: sumDown(COL_TOTAL_AMT + 1), result: 0 };
      }
      totalRow.getCell(COL_TOTAL_AMT).value = { formula: sumDown(COL_TOTAL_AMT), result: 0 };

      // Estilo total row.
      const lastTotalCol = (isCosecha || isTrato) && combos.length === 0 ? COL_TOTAL_AMT + 1 : COL_TOTAL_AMT;
      for (let col = COL_FIXED_START; col <= lastTotalCol; col++) {
        const cell = totalRow.getCell(col);
        cell.font = { bold: true };
        cell.fill = TOTAL_FILL;
        cell.border = thinBorder;
        if (col < COL_FIRST_DAY) continue;
        if (isMoneyOnly || col === COL_TOTAL_AMT) cell.numFmt = '"$"#,##0';
        else if (isHE) {
          const offset = col - COL_FIRST_DAY;
          if (offset >= 0 && offset < dates.length * 3) {
            const kind = offset % 3;
            cell.numFmt = kind === 1 ? "#,##0.0" : '"$"#,##0';
          } else if (col === COL_TOTAL_HORAS) {
            cell.numFmt = "#,##0.0";
          } else {
            cell.numFmt = '"$"#,##0';
          }
        } else if ((isCosecha || isTrato) && combos.length > 0) {
          const offset = col - COL_FIRST_DAY;
          if (offset >= 0 && offset < dates.length * cellsPerDay) {
            const slot = offset % cellsPerDay;
            cell.numFmt = slot === cellsPerDay - 1 ? '"$"#,##0' : "#,##0";
          } else {
            cell.numFmt = "#,##0";
          }
        } else {
          cell.numFmt = "#,##0";
        }
      }

      // ────────────────────────────────────────────────────────────────────
      // Tarifa HE editable (solo tratoHE).
      // ────────────────────────────────────────────────────────────────────
      if (isHE) {
        const HE_RATE_ROW = TOTAL_ROW + 2;
        const heRateRow = ws.getRow(HE_RATE_ROW);
        heRateRow.getCell(COL_FIXED_START).value = "Tarifa HE $/hora";
        heRateRow.getCell(COL_FIXED_START).font = { bold: true, italic: true };
        heRateRow.getCell(COL_RUT).value = Number(labor?.overtimeRate) || 3500;
        heRateRow.getCell(COL_RUT).numFmt = '"$"#,##0';
        heRateRow.getCell(COL_RUT).fill = PRICE_FILL;
        heRateRow.getCell(COL_RUT).border = thinBorder;

        const heRef = `$${colLetter(COL_RUT)}$${HE_RATE_ROW}`;
        workers.forEach((w, wi) => {
          const rowNum = DATA_START_ROW + wi;
          const baseRef = `${colLetter(COL_TOTAL_BASE)}${rowNum}`;
          const horasRef = `${colLetter(COL_TOTAL_HORAS)}${rowNum}`;
          const extrasRef = `${colLetter(COL_TOTAL_EXTRAS)}${rowNum}`;
          ws.getRow(rowNum).getCell(COL_TOTAL_AMT).value = {
            formula: `${baseRef}+${horasRef}*${heRef}+${extrasRef}`,
            result: Number(w.totals.amount) || 0,
          };
        });
        // Footer Total $ → suma de Total $ por trabajador (sigue funcionando
        // porque las fórmulas devuelven números).
        totalRow.getCell(COL_TOTAL_AMT).value = { formula: sumDown(COL_TOTAL_AMT), result: 0 };

        const note = ws.getRow(HE_RATE_ROW + 1);
        note.getCell(COL_FIXED_START).value = "↑ Edita la tarifa HE para recalcular los Total $.";
        note.getCell(COL_FIXED_START).font = { italic: true, color: { argb: "FF666666" }, size: 10 };
      }

      // ────────────────────────────────────────────────────────────────────
      // Anchos y views.
      // ────────────────────────────────────────────────────────────────────
      ws.getColumn(1).width = 6; // col A = mitad
      ws.getColumn(COL_FIXED_START).width = 30; // Trabajador
      ws.getColumn(COL_RUT).width = 14; // RUT
      for (let i = COL_FIRST_DAY; i <= COL_TOTAL_AMT + 1; i++) {
        ws.getColumn(i).width = 12;
      }

      // Freeze: 3 cols a la izquierda (A, Trabajador, RUT) + header.
      // Freeze el header completo + col A/Trabajador/RUT.
      const ySplit = useDoubleHeader ? PRICE_HEADER_ROW : HEADER_ROW;
      ws.views = [{ state: "frozen", xSplit: COL_RUT, ySplit }];

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = xlsxFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Error al exportar: " + (err.message || err));
    } finally {
      setBusy("");
    }
  };

  const handlePrint = () => {
    if (!ref.current) return;
    const html = ref.current.outerHTML;
    const win = window.open("", "_blank", "width=1100,height=800");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>${displayName} — trabajadores</title>
      <style>
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; box-sizing: border-box; }
        body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 20px; color: #000; margin: 0; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #888; padding: 5px 7px; font-size: 11px; }
        /* Hace que el thead se repita en cada hoja nueva (Chrome/Firefox). */
        thead { display: table-header-group; }
        tfoot { display: table-row-group; }
        tr { page-break-inside: avoid; }
        @media print { @page { size: landscape; margin: 10mm; } }
      </style>
    </head><body>${html}<script>window.onload = () => { window.focus(); window.print(); };</script></body></html>`);
    win.document.close();
  };

  if (allWorkers.length === 0 || dates.length === 0) return null;

  // Sumas por columna (día) — pie de tabla.
  const dayTotals = new Map();
  for (const d of dates) dayTotals.set(d, { qty: 0, amount: 0, jornadas: 0, overtimeHours: 0, pisoAmount: 0 });
  for (const w of workers) {
    for (const [d, c] of w.byDate.entries()) {
      const t = dayTotals.get(d);
      if (!t) continue;
      t.qty += c.qty;
      t.amount += c.amount;
      t.jornadas += c.jornadas;
      t.overtimeHours += c.overtimeHours || 0;
      t.pisoAmount += c.pisoAmount || 0;
    }
  }
  const grand = { qty: 0, amount: 0, jornadas: 0, overtimeHours: 0, pisoAmount: 0 };
  for (const w of workers) {
    grand.qty += w.totals.qty;
    grand.amount += w.totals.amount;
    grand.jornadas += w.totals.jornadas || 0;
    grand.overtimeHours += w.totals.overtimeHours || 0;
    grand.pisoAmount += w.totals.pisoAmount || 0;
  }

  const containerName = labor?.type === "cosecha" && containers.size === 1
    ? containerLabel(catalogs, [...containers][0])
    : null;

  // Devuelve el contenido de una celda (worker, date). qty arriba grande,
  // monto chico abajo. Para piso muestra un tag dorado discreto.
  //
  // Para tratoHE: NO mostramos "j" (la jornada está implícita en el día con
  // trabajo). En su lugar, la línea de monto se muestra como `$amount + Xh`
  // cuando hay horas extras, o solo `$amount` cuando es jornada limpia.
  const renderCell = (c) => {
    if (!c || (!c.qty && !c.amount && !c.pisoAmount)) return null;
    const lines = [];
    const t = labor?.type;
    if (c.pisoAmount > 0 && !c.qty && !c.jornadas) {
      lines.push(
        <div key="piso" style={{ color: "#b45309", fontSize: 10 }}>🪙 {fmtCurrency(c.pisoAmount)}</div>,
      );
    } else if (t === "cosecha") {
      const main = (
        <div key="kg" style={{ fontWeight: 600 }}>
          {fmtNumber(c.qty)}{containerName ? ` ${containerName.toLowerCase()}` : ""}
        </div>
      );
      lines.push(main);
      if (c.byCombo && c.byCombo.size > 1) {
        for (const [, b] of c.byCombo) {
          lines.push(
            <div key={`${b.qx}_${b.cy}`} style={{ fontSize: 9, color: "#666" }}>
              {qualityLabel(catalogs, b.qx)}: {fmtNumber(b.kilos)}
            </div>,
          );
        }
      }
    } else if (t === "trato") {
      lines.push(<div key="qty" style={{ fontWeight: 600 }}>{fmtNumber(c.qty)}</div>);
    } else if (t === "tratoHE") {
      // Sin línea de jornada — se renderiza solo en la línea de monto abajo.
    } else {
      // main/supervision/extra: tampoco mostramos "j". El monto manda como
      // línea principal (la jornada se cuenta sola en la columna Total).
    }
    if (c.pisoAmount > 0 && (c.qty || c.jornadas)) {
      lines.push(
        <div key="piso" style={{ color: "#b45309", fontSize: 9 }}>🪙 {fmtCurrency(c.pisoAmount)}</div>,
      );
    }
    if (c.amount) {
      const heSuffix = (t === "tratoHE" && c.overtimeHours > 0)
        ? ` (${fmtNumber(c.overtimeHours)} HE)`
        : "";
      // Cosecha y trato tienen su métrica "principal" arriba (kg / cantidad),
      // entonces el monto va abajo en chico/gris. Para los tipos sin métrica
      // arriba (tratoHE, main, supervision, extra) el monto ES la info
      // principal: lo agrandamos y oscurecemos.
      const isMainLine = t !== "cosecha" && t !== "trato";
      const fontSize = isMainLine ? 11 : 9;
      const fontWeight = isMainLine ? 600 : 400;
      lines.push(
        <div key="amt" style={{ fontSize, fontWeight, color: isMainLine ? "#000" : "#555" }}>
          {fmtCurrency(c.amount)}{heSuffix}
        </div>,
      );
    }
    return <>{lines}</>;
  };

  // Contenido visual del grid — extraído para poder renderizarlo tanto inline
  // (con ref para capturar PNG) como dentro del Modal "Ampliar". Solo una de
  // las dos instancias está montada a la vez (depende de `expanded`), así el
  // ref siempre apunta a la única instancia activa.
  const gridBody = (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{titles?.main || "DETALLE DE JORNADA"}</div>
          {titles?.subtitle && <div style={{ fontSize: 12, color: "#555" }}>{titles.subtitle}</div>}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{displayName}</div>
          <div style={{ fontSize: 11, color: "#555" }}>
            {workers.length} trabajador{workers.length === 1 ? "" : "es"} · {dates.length} día{dates.length === 1 ? "" : "s"} · {unit}
          </div>
        </div>
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ background: "#9dc3e6" }}>
              <th style={cellH}>Trabajador</th>
              {dates.map((d) => {
                const isRed = redDates.has(d);
                const cellStyle = {
                  ...cellH,
                  textAlign: "center",
                  minWidth: 70,
                  ...(isRed ? { background: "#ffc7ce", color: "#9c0006" } : {}),
                };
                return (
                  <th key={d} style={cellStyle}>
                    <div>{dateLabel(d)}</div>
                    {(() => {
                      // Precio + unidad configurado para ese día (ej. "$300/árbol",
                      // "$45/saco"). Vacío si no hay precio o si es tratoHE.
                      const priceLine = formatLaborDayPrice(labor, d, dayPrices, catalogs);
                      if (!priceLine) return null;
                      return (
                        <div style={{ fontSize: 9, fontWeight: 400, color: "#555", marginTop: 2 }}>
                          {priceLine}
                        </div>
                      );
                    })()}
                  </th>
                );
              })}
              <th style={{ ...cellH, textAlign: "right", background: "#7eb0d8", whiteSpace: "nowrap" }}>Total {unit}</th>
              {labor?.type === "tratoHE" && (
                <th style={{ ...cellH, textAlign: "right", background: "#7eb0d8", whiteSpace: "nowrap" }}>Total HE</th>
              )}
              <th style={{ ...cellH, textAlign: "right", background: "#7eb0d8", whiteSpace: "nowrap" }}>Total $</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w) => (
              <tr key={w.rut}>
                <td style={{ ...cell, fontWeight: 600 }}>
                  <div>{w.name}</div>
                  <div style={{ fontSize: 9, color: "#777", fontFamily: "ui-monospace, monospace" }}>{w.rut}</div>
                </td>
                {dates.map((d) => (
                  <td key={d} style={{ ...cell, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
                    {renderCell(w.byDate.get(d))}
                  </td>
                ))}
                <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                  {labor?.type === "tratoHE"
                    ? fmtNumber(w.totals.jornadas)
                    : fmtNumber(w.totals.qty)}
                </td>
                {labor?.type === "tratoHE" && (
                  <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                    {w.totals.overtimeHours > 0 ? `${fmtNumber(w.totals.overtimeHours)} HE` : ""}
                  </td>
                )}
                <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                  {fmtCurrency(w.totals.amount)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ background: "#c6efce", fontWeight: 700 }}>
              <td style={{ ...cell, fontWeight: 700 }}>Total día</td>
              {dates.map((d) => {
                const t = dayTotals.get(d);
                const lt = labor?.type;
                const isHE = lt === "tratoHE";
                // Cosecha y trato muestran la métrica de producción arriba
                // (kilos / cantidad). Para tratoHE, main, supervision, extra
                // solo va el monto — el conteo de jornadas vive en la
                // columna Total Jornadas a la derecha.
                const showQty = lt === "cosecha" || lt === "trato";
                const amtLine = isHE && t.overtimeHours > 0
                  ? `${fmtCurrency(t.amount)} (${fmtNumber(t.overtimeHours)} HE)`
                  : fmtCurrency(t.amount);
                return (
                  <td key={d} style={{ ...cell, textAlign: "center", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
                    {showQty && <div>{fmtNumber(t.qty)}</div>}
                    <div style={{ fontSize: showQty ? 9 : 11, color: "#333" }}>{amtLine}</div>
                  </td>
                );
              })}
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {labor?.type === "tratoHE"
                  ? fmtNumber(grand.jornadas)
                  : fmtNumber(grand.qty)}
              </td>
              {labor?.type === "tratoHE" && (
                <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                  {grand.overtimeHours > 0 ? `${fmtNumber(grand.overtimeHours)} HE` : ""}
                </td>
              )}
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {fmtCurrency(grand.amount)}
              </td>
            </tr>
          {anyPiso && grand.pisoAmount > 0 && (
            <tr style={{ background: "#fce4d6" }}>
              <td style={{ ...cell, fontWeight: 700, color: "#b45309" }} colSpan={dates.length + 1}>
                🪙 Total pisos
              </td>
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, color: "#b45309", fontVariantNumeric: "tabular-nums" }}>—</td>
              {labor?.type === "tratoHE" && (
                <td style={{ ...cell, textAlign: "right", fontWeight: 700, color: "#b45309", fontVariantNumeric: "tabular-nums" }}>—</td>
              )}
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, color: "#b45309", fontVariantNumeric: "tabular-nums" }}>
                {fmtCurrency(grand.pisoAmount)}
              </td>
            </tr>
          )}
        </tfoot>
      </table>
    </>
  );

  // Card wrapper compartido para inline y modal — replica los padding y
  // colores del print. `ref` lo recibe solo cuando se renderiza inline (o
  // dentro del modal) — pero nunca en ambos lados a la vez (mutuamente
  // excluyentes vía `expanded`).
  //
  // `width: max-content` evita que el navegador trate de hacer caber el
  // contenido en el ancho del contenedor con overflow. Cada columna conserva
  // su ancho natural y la tabla puede ser más amplia que el viewport (que es
  // justo lo que queremos — el scroller exterior se encarga).
  const cardStyles = {
    background: "#ffffff",
    color: "#000",
    padding: 14,
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    width: "max-content",
    minWidth: "100%",
  };

  return (
    <div style={{ marginTop: 20 }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          Resumen por trabajador — <span className="text-[var(--color-muted)]">{displayName}</span>
          {hiddenRuts.size > 0 && (
            <span className="ml-2 rounded bg-[var(--color-warning-soft)] px-1.5 py-0.5 text-[10px] font-normal text-[var(--color-warning)]">
              {workers.length}/{allWorkers.length} visibles
            </span>
          )}
        </h3>
        <div className="flex gap-1">
          <button
            onClick={() => setFilterOpen((v) => !v)}
            className={`rounded-md border px-2 py-1 text-xs ${
              filterOpen || hiddenRuts.size > 0
                ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"
            }`}
            title="Filtrar trabajadores visibles"
          >
            👥 Filtrar
          </button>
          <button
            onClick={() => setExpanded(true)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
            title="Ver en grande (modal con scroll horizontal)"
          >
            🔍 Ampliar
          </button>
          <button
            onClick={handleXlsx}
            disabled={busy === "xlsx"}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
            title="Exportar a Excel (columnas numéricas listas para sumar)"
          >
            {busy === "xlsx" ? "..." : "📊 XLSX"}
          </button>
          <button
            onClick={handleCopy}
            disabled={busy === "copy"}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
            title="Copiar imagen al portapapeles"
          >
            {busy === "copy" ? "..." : "📋"}
          </button>
          <button
            onClick={handleDownload}
            disabled={busy === "download"}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
            title="Descargar PNG"
          >
            {busy === "download" ? "..." : "📥"}
          </button>
          <button
            onClick={handlePrint}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
            title="Imprimir"
          >
            🖨
          </button>
        </div>
      </div>

      {filterOpen && (
        <div className="mb-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="text-[11px] text-[var(--color-muted)]">
              Click para ocultar/mostrar trabajadores. Las sumas y el XLSX reflejan solo los visibles.
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => setHiddenRuts(new Set())}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px] hover:bg-[var(--color-accent-soft)]"
              >
                Mostrar todos
              </button>
              <button
                onClick={() => setHiddenRuts(new Set(allWorkers.map((w) => w.rut)))}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px] hover:bg-[var(--color-accent-soft)]"
              >
                Ocultar todos
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {allWorkers.map((w) => {
              const hidden = hiddenRuts.has(w.rut);
              return (
                <button
                  key={w.rut}
                  onClick={() => setHiddenRuts((prev) => {
                    const next = new Set(prev);
                    if (next.has(w.rut)) next.delete(w.rut);
                    else next.add(w.rut);
                    return next;
                  })}
                  className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                    hidden
                      ? "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] line-through opacity-60"
                      : "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                  }`}
                  title={hidden ? "Click para mostrar" : "Click para ocultar"}
                >
                  {hidden ? "👁‍🗨" : "👁"} {w.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {/* Inline: scroll horizontal dentro del modal padre para que la grilla
          con muchos días no rompa el layout. PNG/print toman desde el ref del
          div interno (full-width, no recortado por el overflow del wrapper). */}
      {!expanded && (
        <div style={{ overflowX: "auto", maxWidth: "100%" }}>
          <div ref={ref} style={cardStyles}>
            {gridBody}
          </div>
        </div>
      )}
      {/* Modal "Ampliar": cuando hay muchos días, el inline scrollea pero igual
          es incómodo. Este modal abre la misma grilla en un viewport más
          grande, también con scroll. Los botones de export/print están afuera
          (en la action row del card) — siguen funcionando porque `ref` apunta
          al div que se monta acá cuando `expanded` es true. */}
      {expanded && (
        <Modal
          open={expanded}
          onClose={() => setExpanded(false)}
          title={`📊 ${displayName} — Resumen por trabajador`}
          size="xl"
          footer={
            <>
              <button
                onClick={() => setExpanded(false)}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm"
              >
                Cerrar
              </button>
              <button
                onClick={handleCopy}
                disabled={busy === "copy"}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
              >
                {busy === "copy" ? "Copiando..." : "📋 Copiar imagen"}
              </button>
              <button
                onClick={handleDownload}
                disabled={busy === "download"}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
              >
                {busy === "download" ? "Descargando..." : "📥 Descargar PNG"}
              </button>
              <button
                onClick={handlePrint}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
              >
                🖨 Imprimir
              </button>
            </>
          }
        >
          <div style={{ overflow: "auto", maxHeight: "75vh" }}>
            <div ref={ref} style={cardStyles}>
              {gridBody}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
