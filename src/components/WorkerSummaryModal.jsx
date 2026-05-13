import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { toPng, toBlob } from "html-to-image";
import Modal from "./Modal";
import { workdayMapKey, getTratoTierTotals, containerLabel, tratoTypeLabel, cosechaUnit } from "../utils/cosechaCombos";
import { DEFAULT_OVERTIME_RATE } from "../utils/tratoHE";
import { cyclesService, faenasService, subfaenasService, workdaysService } from "../services";
import { useCatalogs } from "../contexts/CatalogsContext";
import { formatRutForDisplay } from "../utils/rutUtils";

const fmtCurrency = (v) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 }).format(
    Number(v) || 0,
  );

const fmtNumber = (v) =>
  new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(Number(v) || 0);

const dateLabel = (dateStr) => {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return dateStr;
  const month = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"][d.getMonth()];
  return `${String(d.getDate()).padStart(2, "0")}-${month}`;
};

const LOGO_URL = `${import.meta.env.BASE_URL}logo.png`;

const titlesKey = (rut) => `worker_summary_titles_${rut}`;
const loadTitles = (rut, defaultSubtitle) => {
  try {
    const raw = localStorage.getItem(titlesKey(rut));
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        main: "DETALLE DE JORNADA",
        subtitle: defaultSubtitle,
        cycles: {},
        ...parsed,
        cycles: parsed.cycles || {},
      };
    }
  } catch {
    /* noop */
  }
  return { main: "DETALLE DE JORNADA", subtitle: defaultSubtitle, cycles: {} };
};
const saveTitles = (rut, titles) => {
  try { localStorage.setItem(titlesKey(rut), JSON.stringify(titles)); } catch {
    /* noop */
  }
};

// Título por defecto de un ciclo (lo que se muestra si el usuario no editó nada).
const defaultCycleTitle = ({ faena, subfaena, cycle }) =>
  [faena?.name, subfaena?.name, cycle.label].filter(Boolean).join(" · ");

// Mapea cada tipo de labor a los acumuladores que tiene sentido reportar.
// El resto se deja en 0 y la tabla esconde la columna si nadie aportó.
function buildCycleRows(workerRut, cycle, workdaysByLabor, catalogs) {
  const rows = [];
  const cosechaContainers = new Set();
  for (const labor of cycle.labors || []) {
    const wdMap = workdaysByLabor[labor.id] || {};
    const byDate = new Map();
    for (const k in wdMap) {
      const wd = wdMap[k];
      if (wd.workerRut !== workerRut) continue;
      const d = wd.date;
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(wd);
    }
    const heRate = Number(labor.overtimeRate) || DEFAULT_OVERTIME_RATE;
    for (const [d, wds] of [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      let kilos = 0;
      let jornadas = 0;
      let tratoQty = 0;
      let overtimeHours = 0;
      let heAmount = 0;
      let amount = 0;
      const containers = new Set();
      for (const wd of wds) {
        if (labor.type === "cosecha") {
          kilos += Number(wd.qty) || 0;
          amount += Number(wd.amount) || 0;
          if (wd.containerY != null) {
            const cy = Number(wd.containerY);
            containers.add(cy);
            cosechaContainers.add(cy);
          }
        } else if (labor.type === "trato") {
          const t = getTratoTierTotals(wd);
          tratoQty += t.qty;
          amount += t.amount;
        } else if (labor.type === "tratoHE") {
          jornadas += Number(wd.qty) || 0;
          const oh = Number(wd.overtimeHours) || 0;
          overtimeHours += oh;
          heAmount += oh * heRate;
          amount += Number(wd.amount) || 0;
        } else {
          // main, supervision, extra → pago al día (1 jornada)
          jornadas += 1;
          amount += Number(wd.amount) || 0;
        }
      }
      const containerLabels = [...containers].map((y) => containerLabel(catalogs, y)).join("/");
      rows.push({
        laborName: labor.name,
        laborType: labor.type,
        tratoType: labor.tratoType ?? 0,
        containerLabels,
        date: d,
        kilos,
        jornadas,
        tratoQty,
        overtimeHours,
        heAmount,
        amount,
      });
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.laborName.localeCompare(b.laborName)));
  return { rows, cosechaContainers };
}

export default function WorkerSummaryModal({ open, onClose, worker }) {
  const { catalogs } = useCatalogs();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState([]); // [{ cycle, faena, subfaena, rows, totals }]
  const [busy, setBusy] = useState("");
  const [titles, setTitles] = useState({ main: "DETALLE DE JORNADA", subtitle: "" });
  const [showTitleEditor, setShowTitleEditor] = useState(false);
  const printRef = useRef(null);

  useEffect(() => {
    if (!open || !worker?.id) {
      setData([]);
      return;
    }
    setTitles(loadTitles(worker.id, worker.name || ""));
    (async () => {
      setLoading(true);
      try {
        const wds = await workdaysService.list({ wheres: [["workerRut", "==", worker.id]] });
        const cycleIds = [...new Set(wds.map((w) => w.cycleId).filter(Boolean))];
        const cycles = await Promise.all(cycleIds.map((id) => cyclesService.getById(id)));
        const activeCycles = cycles.filter((c) => c && c.status !== "closed");
        const faenaIds = [...new Set(activeCycles.map((c) => c.faenaId).filter(Boolean))];
        const subIds = [...new Set(activeCycles.map((c) => c.subfaenaId).filter(Boolean))];
        const faenas = await Promise.all(faenaIds.map((id) => faenasService.getById(id)));
        const subs = await Promise.all(subIds.map((id) => subfaenasService.getById(id)));
        const faenaById = new Map(faenas.filter(Boolean).map((f) => [f.id, f]));
        const subById = new Map(subs.filter(Boolean).map((s) => [s.id, s]));

        const result = activeCycles.map((c) => {
          const wdMap = {};
          for (const wd of wds) {
            if (wd.cycleId !== c.id) continue;
            const labor = (c.labors || []).find((l) => l.id === wd.laborId);
            if (!labor) continue;
            if (!wdMap[wd.laborId]) wdMap[wd.laborId] = {};
            const ck = wd.qualityX != null && wd.containerY != null
              ? `${wd.qualityX}_${wd.containerY}`
              : wd.tiers ? "0_0" : "0_0";
            const k = workdayMapKey(wd.workerRut, wd.date, ck);
            wdMap[wd.laborId][k] = wd;
          }
          const { rows, cosechaContainers } = buildCycleRows(worker.id, c, wdMap, catalogs);
          const totals = rows.reduce(
            (acc, r) => ({
              kilos: acc.kilos + r.kilos,
              jornadas: acc.jornadas + r.jornadas,
              tratoQty: acc.tratoQty + r.tratoQty,
              overtimeHours: acc.overtimeHours + r.overtimeHours,
              heAmount: acc.heAmount + r.heAmount,
              amount: acc.amount + r.amount,
            }),
            { kilos: 0, jornadas: 0, tratoQty: 0, overtimeHours: 0, heAmount: 0, amount: 0 },
          );
          // Columnas a mostrar: solo las que tienen al menos un valor > 0.
          const cols = {
            kilos: rows.some((r) => r.kilos > 0),
            jornadas: rows.some((r) => r.jornadas > 0),
            he: rows.some((r) => r.overtimeHours > 0),
            trato: rows.some((r) => r.tratoQty > 0),
          };
          // Etiqueta de la columna/total de trato: si todos los tratos del ciclo
          // son del mismo tipo (ej. todos "poda"), usamos el label del catálogo.
          // Si hay mezcla, caemos al genérico "Trato".
          const tratoTypes = new Set(rows.filter((r) => r.laborType === "trato").map((r) => r.tratoType));
          const tratoLabel = tratoTypes.size === 1
            ? tratoTypeLabel(catalogs, [...tratoTypes][0])
            : "Trato";
          const kilosLabel = cosechaUnit(catalogs, cosechaContainers);
          return {
            cycle: c,
            faena: faenaById.get(c.faenaId),
            subfaena: subById.get(c.subfaenaId),
            rows,
            totals,
            cols,
            tratoLabel,
            kilosLabel,
          };
        });
        result.sort((a, b) => (a.cycle.label || "").localeCompare(b.cycle.label || ""));
        setData(result);
      } finally {
        setLoading(false);
      }
    })();
  }, [open, worker?.id, catalogs]);

  const grandTotal = useMemo(
    () => data.reduce((s, d) => s + (d.totals.amount || 0), 0),
    [data],
  );

  const updateTitles = (patch) => {
    setTitles((prev) => {
      const next = { ...prev, ...patch };
      saveTitles(worker?.id, next);
      return next;
    });
  };

  const handleDownload = async () => {
    if (!printRef.current) return;
    setBusy("download");
    try {
      const dataUrl = await toPng(printRef.current, { backgroundColor: "#ffffff", pixelRatio: 2 });
      const link = document.createElement("a");
      link.download = `resumen_${(worker?.name || "trabajador").replace(/\s+/g, "_")}.png`;
      link.href = dataUrl;
      link.click();
    } finally {
      setBusy("");
    }
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
    } finally {
      setBusy("");
    }
  };

  const handlePrint = () => {
    if (!printRef.current) return;
    const html = printRef.current.outerHTML;
    const win = window.open("", "_blank", "width=900,height=700");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>Resumen — ${worker?.name || ""}</title>
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
    setTimeout(() => { win.print(); }, 250);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`📊 Resumen — ${worker?.name || ""}`}
      size="xl"
      footer={
        <>
          <button onClick={onClose} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
            Cerrar
          </button>
          <button onClick={handleCopy} disabled={busy === "copy" || loading} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60">
            {busy === "copy" ? "Copiando..." : "📋 Copiar imagen"}
          </button>
          <button onClick={handleDownload} disabled={busy === "download" || loading} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60">
            {busy === "download" ? "Descargando..." : "📥 Descargar PNG"}
          </button>
          <button onClick={handlePrint} disabled={loading} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60">
            🖨 Imprimir
          </button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={() => setShowTitleEditor((v) => !v)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
        >
          {showTitleEditor ? "▾" : "▸"} Personalizar títulos
        </button>
        {!loading && data.length > 0 && (
          <span className="ml-auto text-sm">
            <span className="text-[var(--color-muted)]">Total general: </span>
            <span className="font-semibold tabular-nums">{fmtCurrency(grandTotal)}</span>
          </span>
        )}
      </div>

      {showTitleEditor && (
        <div className="mb-3 space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
          <div className="grid gap-2 md:grid-cols-2">
            <label className="block">
              <span className="block text-[10px] text-[var(--color-muted)]">Título principal</span>
              <input
                value={titles.main || ""}
                onChange={(e) => updateTitles({ main: e.target.value })}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
            <label className="block">
              <span className="block text-[10px] text-[var(--color-muted)]">Subtítulo (nombre formal)</span>
              <input
                value={titles.subtitle || ""}
                onChange={(e) => updateTitles({ subtitle: e.target.value })}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
          </div>
          {data.length > 0 && (
            <div className="space-y-1.5 border-t border-[var(--color-border)] pt-2">
              <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
                Encabezado por ciclo
              </div>
              {data.map(({ cycle, faena, subfaena }) => {
                const fallback = defaultCycleTitle({ faena, subfaena, cycle });
                const current = titles.cycles?.[cycle.id] ?? "";
                return (
                  <label key={cycle.id} className="block">
                    <input
                      value={current}
                      placeholder={fallback}
                      onChange={(e) => {
                        const next = { ...(titles.cycles || {}) };
                        const v = e.target.value;
                        if (v) next[cycle.id] = v;
                        else delete next[cycle.id];
                        updateTitles({ cycles: next });
                      }}
                      className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
                    />
                  </label>
                );
              })}
              <p className="text-[10px] text-[var(--color-muted)]">
                Dejar vacío para usar el encabezado por defecto (faena · subfaena · ciclo).
              </p>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-sm text-[var(--color-muted)]">Cargando...</div>
      ) : data.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] py-8 text-center text-sm text-[var(--color-muted)]">
          Sin actividad en ciclos activos
        </div>
      ) : null}
      <PrintableWorkerSummary ref={printRef} worker={worker} data={data} grandTotal={grandTotal} titles={titles} />
    </Modal>
  );
}

const PrintableWorkerSummary = forwardRef(function PrintableWorkerSummary({ worker, data, grandTotal, titles }, ref) {
  return (
    <div ref={ref} style={{ background: "#ffffff", color: "#000", padding: 20, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 24, marginBottom: 16 }}>
        <img src={LOGO_URL} alt="logo" crossOrigin="anonymous" style={{ width: 90, height: 90, objectFit: "contain", flexShrink: 0 }} />
        <div style={{ textAlign: "center" }}>
          <div style={{ fontWeight: 700, fontSize: 18, letterSpacing: 1 }}>{titles?.main || "DETALLE DE JORNADA"}</div>
          {titles?.subtitle && <div style={{ marginTop: 6, fontSize: 14 }}>{titles.subtitle}</div>}
          {worker?.id && (
            <div style={{ marginTop: 2, fontSize: 12, color: "#444", fontFamily: "ui-monospace, monospace" }}>
              RUT {formatRutForDisplay(worker.id)}
            </div>
          )}
          <div style={{ marginTop: 4, fontSize: 11, color: "#666" }}>Ciclos activos</div>
        </div>
        <div style={{ width: 90 }} />
      </div>

      {data.map(({ cycle, faena, subfaena, rows, totals, cols, tratoLabel, kilosLabel }) => {
        // Helper local para que los totales caigan en la columna correcta.
        // valueCol = "kilos" | "jornadas" | "he" | "trato" | "amount"
        const renderTotalRow = (label, value, valueCol, bg) => (
          <tr style={bg ? { background: bg } : undefined}>
            <td style={cell}></td>
            <td style={{ ...cell, fontWeight: 700 }}>{label}</td>
            {cols.kilos && (
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {valueCol === "kilos" ? value : ""}
              </td>
            )}
            {cols.jornadas && (
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {valueCol === "jornadas" ? value : ""}
              </td>
            )}
            {cols.he && (
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {valueCol === "he" ? value : ""}
              </td>
            )}
            {cols.trato && (
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {valueCol === "trato" ? value : ""}
              </td>
            )}
            <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
              {valueCol === "amount" ? value : ""}
            </td>
          </tr>
        );
        const totalColSpan =
          2 + (cols.kilos ? 1 : 0) + (cols.jornadas ? 1 : 0) + (cols.he ? 1 : 0) + (cols.trato ? 1 : 0) + 1;

        const cycleTitle =
          (titles?.cycles && titles.cycles[cycle.id]) ||
          defaultCycleTitle({ faena, subfaena, cycle });
        return (
          <div key={cycle.id} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{cycleTitle}</div>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr style={{ background: "#9dc3e6" }}>
                  <th style={cellH}>Detalle Jornada</th>
                  <th style={cellH}>Fecha</th>
                  {cols.kilos && <th style={{ ...cellH, textAlign: "right" }}>{kilosLabel}</th>}
                  {cols.jornadas && <th style={{ ...cellH, textAlign: "right" }}>Jornadas</th>}
                  {cols.he && <th style={{ ...cellH, textAlign: "right" }}>HE</th>}
                  {cols.trato && <th style={{ ...cellH, textAlign: "right" }}>{tratoLabel}</th>}
                  <th style={{ ...cellH, textAlign: "right" }}>Precio</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td style={{ ...cell, color: "#666", textAlign: "center" }} colSpan={totalColSpan}>
                      Sin movimientos
                    </td>
                  </tr>
                ) : (
                  rows.map((r, i) => (
                    <tr key={i}>
                      <td style={cell}>{r.laborName}</td>
                      <td style={cell}>{dateLabel(r.date)}</td>
                      {cols.kilos && (
                        <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {r.kilos > 0 ? fmtNumber(r.kilos) : ""}
                        </td>
                      )}
                      {cols.jornadas && (
                        <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {r.jornadas > 0 ? fmtNumber(r.jornadas) : ""}
                        </td>
                      )}
                      {cols.he && (
                        <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {r.overtimeHours > 0
                            ? `${fmtNumber(r.overtimeHours)}h · ${fmtCurrency(r.heAmount)}`
                            : ""}
                        </td>
                      )}
                      {cols.trato && (
                        <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {r.tratoQty > 0 ? fmtNumber(r.tratoQty) : ""}
                        </td>
                      )}
                      <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {fmtCurrency(r.amount)}
                      </td>
                    </tr>
                  ))
                )}
                {rows.length > 0 && (
                  <>
                    {cols.kilos && renderTotalRow(`Total ${kilosLabel}`, fmtNumber(totals.kilos), "kilos")}
                    {cols.jornadas && renderTotalRow("Total Jornadas", fmtNumber(totals.jornadas), "jornadas")}
                    {cols.he &&
                      renderTotalRow(
                        "Total HE",
                        `${fmtNumber(totals.overtimeHours)}h · ${fmtCurrency(totals.heAmount)}`,
                        "he",
                      )}
                    {cols.trato && renderTotalRow(`Total ${tratoLabel}`, fmtNumber(totals.tratoQty), "trato")}
                    {renderTotalRow("Subtotal ciclo", fmtCurrency(totals.amount), "amount", "#c6efce")}
                  </>
                )}
              </tbody>
            </table>
          </div>
        );
      })}

      {data.length > 1 && (
        <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 8 }}>
          <tbody>
            <tr style={{ background: "#a9d08e" }}>
              <td style={{ ...cell, fontWeight: 700, fontSize: 13 }}>TOTAL GENERAL</td>
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontSize: 13, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
});

const cellH = { border: "1px solid #555", padding: "6px 8px", fontSize: 12, fontWeight: 700, textAlign: "left" };
const cell = { border: "1px solid #999", padding: "5px 8px", fontSize: 12 };
