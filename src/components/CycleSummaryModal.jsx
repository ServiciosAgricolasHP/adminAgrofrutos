import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { toPng, toBlob } from "html-to-image";
import Modal from "./Modal";
import {
  containerLabel,
  getDaySingle,
  getTratoTierTotals,
  workdayMapKey,
  tratoTypeLabel,
  cosechaUnit,
} from "../utils/cosechaCombos";
import { isRedDay } from "../utils/tratoHE";
import { tripsService } from "../services/transportsService";
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

// ============================================================
// Day-by-day aggregation per labor
// ============================================================

// Encabezado de la columna principal según tipo de labor. tratoHE muestra
// "Jornadas / HE" porque agrega dos métricas en la misma columna. Para trato
// y cosecha tomamos la unidad del catálogo (ej. "Poda", "Saco") en vez de
// literales fijos.
function laborQtyUnit(labor, catalogs, containers) {
  const type = labor?.type;
  if (type === "cosecha") return cosechaUnit(catalogs, containers);
  if (type === "trato") return tratoTypeLabel(catalogs, labor?.tratoType ?? 0);
  if (type === "tratoHE") return "Jornadas / HE";
  return "Jornadas";
}

// Texto a mostrar en la celda de métrica según tipo de labor.
function formatRowMetric(row, type) {
  if (type === "cosecha") return fmtNumber(row.qty);
  if (type === "trato") return fmtNumber(row.qty);
  if (type === "tratoHE") {
    const parts = [];
    if (row.qty > 0) parts.push(`${fmtNumber(row.qty)} j`);
    if (row.overtimeHours > 0) parts.push(`${fmtNumber(row.overtimeHours)} HE`);
    return parts.join(" + ");
  }
  return fmtNumber(row.qty);
}

function formatTotalsMetric(totals, type) {
  if (type === "tratoHE") {
    const parts = [];
    if (totals.qty > 0) parts.push(`${fmtNumber(totals.qty)} j`);
    if (totals.overtimeHours > 0) parts.push(`${fmtNumber(totals.overtimeHours)} HE`);
    return parts.join(" + ");
  }
  return fmtNumber(totals.qty);
}

// Returns { rows: [...], containers: Set<number> }
function buildDailyRows(labor, wdMap) {
  const byDate = new Map();
  const containers = new Set();
  for (const k in wdMap) {
    const wd = wdMap[k];
    const d = wd.date;
    if (!byDate.has(d)) {
      byDate.set(d, { date: d, qty: 0, overtimeHours: 0, amount: 0, workersSet: new Set() });
    }
    const g = byDate.get(d);
    if (labor.type === "cosecha") {
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
    g.workersSet.add(wd.workerRut);
  }
  const rows = [...byDate.values()]
    .map((g) => ({ ...g, workerCount: g.workersSet.size }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { rows, containers };
}

function laborTotals(rows) {
  let qty = 0, overtimeHours = 0, amount = 0;
  for (const r of rows) {
    qty += r.qty;
    overtimeHours += r.overtimeHours || 0;
    amount += r.amount;
  }
  return { qty, overtimeHours, amount };
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

  // ============================================================
  // Build per-labor data
  // ============================================================
  const laborsData = useMemo(() => {
    if (!cycle?.labors) return [];
    return cycle.labors.map((l) => {
      const wdMap = workdaysByLabor[l.id] || {};
      const { rows, containers } = buildDailyRows(l, wdMap);
      const totals = laborTotals(rows);
      return { labor: l, rows, totals, unit: laborQtyUnit(l, catalogs, containers) };
    });
  }, [cycle?.labors, workdaysByLabor, catalogs]);

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
    for (const ld of laborsData) sum += ld.totals.amount;
    for (const tg of transportData) sum += tg.totalAmount;
    return sum;
  }, [laborsData, transportData]);

  // ============================================================
  // Cobrar rows
  // ============================================================
  const cobrarLabors = useMemo(() => {
    return laborsData.map((ld) => {
      const cfg = cobrar.labors[ld.labor.id] || {};
      const include = cfg.include !== false;
      const defaultRate = ld.totals.qty > 0 ? Math.round(ld.totals.amount / ld.totals.qty) : 0;
      const rate = cfg.chargeRate != null ? Number(cfg.chargeRate) : defaultRate;
      return { ...ld, include, rate, defaultRate };
    });
  }, [laborsData, cobrar.labors]);

  const cobrarCarriers = useMemo(() => {
    return transportData.map((tg) => {
      const cfg = cobrar.carriers[tg.carrierId] || {};
      const include = cfg.include !== false;
      const defaultRate = tg.totalCount > 0 ? Math.round(tg.totalAmount / tg.totalCount) : 0;
      const rate = cfg.chargeRate != null ? Number(cfg.chargeRate) : defaultRate;
      return { ...tg, include, rate, defaultRate };
    });
  }, [transportData, cobrar.carriers]);

  const grandTotalCobrar = useMemo(() => {
    let sum = 0;
    for (const cl of cobrarLabors) if (cl.include) sum += cl.totals.qty * cl.rate;
    for (const cc of cobrarCarriers) if (cc.include) sum += cc.totalCount * cc.rate;
    return sum;
  }, [cobrarLabors, cobrarCarriers]);

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
        @media print { @page { size: portrait; margin: 12mm; } }
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

      <PrintableSummary
        ref={printRef}
        mode={mode}
        titles={titles}
        labors={mode === "cobrar" ? cobrarLabors : laborsData}
        carriers={mode === "cobrar" ? cobrarCarriers : transportData}
        carrierById={carrierById}
        grandTotal={mode === "cobrar" ? grandTotalCobrar : grandTotalPagar}
      />
    </Modal>
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
              <th className="px-2 py-1 text-right">Pago prom.</th>
              <th className="px-2 py-1 text-right">Tarifa cobro</th>
              <th className="px-2 py-1 text-right">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {labors.map((l) => (
              <tr key={l.labor.id} className="border-t border-[var(--color-border)]">
                <td className="px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={l.include}
                    onChange={(e) => onLaborChange(l.labor.id, { include: e.target.checked })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <span className="font-medium">{l.labor.name}</span>
                  <span className="ml-1 text-[var(--color-muted)]">({l.unit.toLowerCase()})</span>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmtNumber(l.totals.qty)}</td>
                <td className="px-2 py-1.5 text-right text-[var(--color-muted)] tabular-nums">{fmtCurrency(l.defaultRate)}</td>
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
            ))}
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
  { mode, titles, labors, carriers, carrierById, grandTotal },
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
          {mode === "cobrar" && <div style={{ marginTop: 4, fontSize: 11, color: "#666" }}>(Para cobrar)</div>}
        </div>
        <div style={{ width: 90 }} />
      </div>

      {/* Per-labor day-by-day tables */}
      {labors.map((ld) => {
        if (mode === "cobrar" && ld.include === false) return null;
        const displayName = titles.laborNames?.[ld.labor.id] || ld.labor.name;
        return (
          <LaborTable
            key={ld.labor.id}
            displayName={displayName}
            unit={ld.unit}
            laborType={ld.labor.type}
            rows={ld.rows}
            totals={ld.totals}
            mode={mode}
            chargeRate={mode === "cobrar" ? ld.rate : null}
          />
        );
      })}

      {/* Transport tables (one per carrier) */}
      {carriers.map((tg) => {
        if (mode === "cobrar" && tg.include === false) return null;
        const c = carrierById.get(tg.carrierId);
        const fallbackName = c?.alias || c?.name || "(transportista eliminado)";
        const displayName = titles.carrierNames?.[tg.carrierId] || fallbackName;
        return (
          <TransportTable
            key={tg.carrierId}
            displayName={displayName}
            rows={tg.rows}
            totalCount={tg.totalCount}
            totalAmount={tg.totalAmount}
            mode={mode}
            chargeRate={mode === "cobrar" ? tg.rate : null}
          />
        );
      })}

      {/* Grand total */}
      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 12 }}>
        <tbody>
          <tr style={{ background: "#a9d08e" }}>
            <td style={{ ...cell, fontWeight: 700, fontSize: 14 }}>
              {mode === "cobrar" ? "TOTAL A COBRAR" : "TOTAL GENERAL"}
            </td>
            <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
              {fmtCurrency(grandTotal)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
});

function LaborTable({ displayName, unit, laborType, rows, totals, mode, chargeRate }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ background: "#9dc3e6" }}>
            <th style={cellH}>Detalle de jornada</th>
            <th style={cellH}>Fecha</th>
            <th style={{ ...cellH, textAlign: "right" }}>{unit}</th>
            <th style={{ ...cellH, textAlign: "right" }}>Valor</th>
            <th style={{ ...cellH, textAlign: "right" }}>Valor total</th>
            <th style={cellH}>Transporte</th>
            <th style={{ ...cellH, textAlign: "right" }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const rate = mode === "cobrar"
              ? chargeRate
              : (r.qty > 0 ? Math.round(r.amount / r.qty) : 0);
            const valorTotal = mode === "cobrar" ? r.qty * chargeRate : r.amount;
            return (
              <tr key={r.date}>
                <td style={cell}>{displayName}</td>
                <td style={cell}>{dateLabel(r.date)}</td>
                <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {formatRowMetric(r, laborType)}
                </td>
                <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{rate > 0 ? fmtCurrency(rate) : ""}</td>
                <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(valorTotal)}</td>
                <td style={{ ...cell, textAlign: "right", color: "#999" }}>$ -</td>
                <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(valorTotal)}</td>
              </tr>
            );
          })}
          <tr style={{ background: "#c6efce" }}>
            <td style={{ ...cell, fontWeight: 700 }} colSpan={2}>Subtotal {displayName}</td>
            <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
              {formatTotalsMetric(totals, laborType)}
            </td>
            <td style={cell}></td>
            <td style={cell}></td>
            <td style={cell}></td>
            <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
              {fmtCurrency(mode === "cobrar" ? totals.qty * chargeRate : totals.amount)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function TransportTable({ displayName, rows, totalCount, totalAmount, mode, chargeRate }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ background: "#fbe5d6" }}>
            <th style={cellH}>🚐 Transporte</th>
            <th style={cellH}>Fecha</th>
            <th style={{ ...cellH, textAlign: "right" }}>Vueltas</th>
            <th style={{ ...cellH, textAlign: "right" }}>Valor</th>
            <th style={{ ...cellH, textAlign: "right" }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const rate = mode === "cobrar"
              ? chargeRate
              : (r.count > 0 ? Math.round(r.amount / r.count) : 0);
            const total = mode === "cobrar" ? r.count * chargeRate : r.amount;
            return (
              <tr key={r.date}>
                <td style={cell}>{displayName}</td>
                <td style={cell}>{dateLabel(r.date)}</td>
                <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.count}</td>
                <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{rate > 0 ? fmtCurrency(rate) : ""}</td>
                <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(total)}</td>
              </tr>
            );
          })}
          <tr style={{ background: "#c6efce" }}>
            <td style={{ ...cell, fontWeight: 700 }} colSpan={2}>Subtotal {displayName}</td>
            <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{totalCount}</td>
            <td style={cell}></td>
            <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
              {fmtCurrency(mode === "cobrar" ? totalCount * chargeRate : totalAmount)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const cellH = { border: "1px solid #555", padding: "6px 8px", fontSize: 12, fontWeight: 700, textAlign: "left" };
const cell = { border: "1px solid #999", padding: "5px 8px", fontSize: 12 };
