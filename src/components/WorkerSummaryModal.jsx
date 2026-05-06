import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { toPng, toBlob } from "html-to-image";
import Modal from "./Modal";
import { workdayMapKey, getTratoTierTotals, containerLabel } from "../utils/cosechaCombos";
import { cyclesService, faenasService, subfaenasService, workdaysService } from "../services";
import { useCatalogs } from "../contexts/CatalogsContext";

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
    if (raw) return { main: "DETALLE DE JORNADA", subtitle: defaultSubtitle, ...JSON.parse(raw) };
  } catch {}
  return { main: "DETALLE DE JORNADA", subtitle: defaultSubtitle };
};
const saveTitles = (rut, titles) => {
  try { localStorage.setItem(titlesKey(rut), JSON.stringify(titles)); } catch {}
};

function buildCycleRows(workerRut, cycle, workdaysByLabor, catalogs) {
  const rows = [];
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
    for (const [d, wds] of [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      let kilos = 0, jornadas = 0, amount = 0;
      const containers = new Set();
      for (const wd of wds) {
        if (labor.type === "cosecha") {
          kilos += Number(wd.qty) || 0;
          amount += Number(wd.amount) || 0;
          if (wd.containerY != null) containers.add(Number(wd.containerY));
        } else if (labor.type === "trato") {
          const t = getTratoTierTotals(wd);
          jornadas += t.qty;
          amount += t.amount;
        } else if (labor.type === "tratoHE") {
          jornadas += Number(wd.qty) || 0;
          amount += Number(wd.amount) || 0;
        } else {
          jornadas += 1;
          amount += Number(wd.amount) || 0;
        }
      }
      const containerLabels = [...containers].map((y) => containerLabel(catalogs, y)).join("/");
      rows.push({
        laborName: labor.name,
        laborType: labor.type,
        containerLabels,
        date: d,
        kilos,
        jornadas,
        amount,
      });
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.laborName.localeCompare(b.laborName)));
  return rows;
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
          const rows = buildCycleRows(worker.id, c, wdMap, catalogs);
          let kilos = 0, jornadas = 0, amount = 0;
          for (const r of rows) {
            kilos += r.kilos;
            jornadas += r.jornadas;
            amount += r.amount;
          }
          return {
            cycle: c,
            faena: faenaById.get(c.faenaId),
            subfaena: subById.get(c.subfaenaId),
            rows,
            totals: { kilos, jornadas, amount },
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
        <div className="mb-3 grid gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 md:grid-cols-2">
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
          <div style={{ marginTop: 4, fontSize: 11, color: "#666" }}>Ciclos activos</div>
        </div>
        <div style={{ width: 90 }} />
      </div>

      {data.map(({ cycle, faena, subfaena, rows, totals }) => (
        <div key={cycle.id} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
            {[faena?.name, subfaena?.name, cycle.label].filter(Boolean).join(" · ")}
          </div>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ background: "#9dc3e6" }}>
                <th style={cellH}>Detalle Jornada</th>
                <th style={cellH}>Fecha</th>
                <th style={{ ...cellH, textAlign: "right" }}>Kilos</th>
                <th style={{ ...cellH, textAlign: "right" }}>Jornadas</th>
                <th style={{ ...cellH, textAlign: "right" }}>Precio</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td style={{ ...cell, color: "#666", textAlign: "center" }} colSpan={5}>Sin movimientos</td></tr>
              ) : rows.map((r, i) => (
                <tr key={i}>
                  <td style={cell}>{r.laborName}</td>
                  <td style={cell}>{dateLabel(r.date)}</td>
                  <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.kilos > 0 ? fmtNumber(r.kilos) : ""}</td>
                  <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.jornadas > 0 ? fmtNumber(r.jornadas) : ""}</td>
                  <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(r.amount)}</td>
                </tr>
              ))}
              {rows.length > 0 && (
                <>
                  {totals.kilos > 0 && (
                    <tr>
                      <td style={cell}></td>
                      <td style={{ ...cell, fontWeight: 700 }}>Total Kilos</td>
                      <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtNumber(totals.kilos)}</td>
                      <td style={cell}></td>
                      <td style={cell}></td>
                    </tr>
                  )}
                  {totals.jornadas > 0 && (
                    <tr>
                      <td style={cell}></td>
                      <td style={{ ...cell, fontWeight: 700 }}>Total Jornadas</td>
                      <td style={cell}></td>
                      <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtNumber(totals.jornadas)}</td>
                      <td style={cell}></td>
                    </tr>
                  )}
                  <tr style={{ background: "#c6efce" }}>
                    <td style={cell}></td>
                    <td style={{ ...cell, fontWeight: 700 }}>Subtotal ciclo</td>
                    <td style={cell}></td>
                    <td style={cell}></td>
                    <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(totals.amount)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      ))}

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
