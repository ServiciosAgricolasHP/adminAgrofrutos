import { useEffect, useMemo, useRef, useState } from "react";
import { toBlob } from "html-to-image";
import Modal from "./Modal";
import { workdaysService } from "../services";
import { useCatalogs } from "../contexts/CatalogsContext";
import { useToast } from "../contexts/ToastContext";
import {
  getDayCombos,
  getTratoTiers,
  getTratoTierTotals,
  tratoTypeLabel,
  tratoUnitLabel,
  cosechaUnit,
  qualityLabel,
  containerLabel,
} from "../utils/cosechaCombos";

const fmtCLP = (v) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 })
    .format(Number(v) || 0);
const fmtNum = (v) =>
  new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 }).format(Number(v) || 0);

// Paleta y estilos clonados de las tablas de cobrar (CycleSummaryModal). Inline
// porque las tablas tienen fondo blanco fijo — el modal entero corre con la
// vista "print-ready" para que la imagen/impresión salga igual al UI.
const cellH = { border: "1px solid #555", padding: "6px 8px", fontSize: 12, fontWeight: 700, textAlign: "left" };
const cell = { border: "1px solid #999", padding: "5px 8px", fontSize: 12 };
const HDR_BLUE = "#9dc3e6";    // azul header — por-labor
const HDR_GREEN = "#a9d08e";   // verde header — tabla general
const ROW_TOTAL_LIGHT = "#c6efce"; // verde claro — fila total por-labor
const ROW_TOTAL_DARK = "#6aa84f";  // verde oscuro — fila total general
const ROW_HIGHLIGHT = "#fffbeb";   // amarillo pale — subhead general (labor name row)

// Modal de resumen de producción para una o varias faenas/ciclos. Muestra
// una tabla pivot: filas = días, columnas = (ciclo, labor) que sea trato o
// cosecha. Cada celda lleva qty + unidad + precio + monto + rendimiento
// (personas distintas y promedio por persona ese día).
//
// `cycles` es un array de cycle docs con `dayPrices` y `labors` adentro. El
// componente fetchea los workdays internamente para cada ciclo. Si el caller
// los tiene cacheados puede pasar `workdaysByCycle` directamente y se evita
// la query.
export default function ProductionSummaryModal({
  open,
  onClose,
  title = "Resumen de producción",
  cycles = [],
  workdaysByCycle: workdaysByCycleProp,
  initialEnabledCycleIds,
}) {
  const { catalogs } = useCatalogs();
  const [wdByCycle, setWdByCycle] = useState(workdaysByCycleProp || {});
  const [loading, setLoading] = useState(false);
  // Filtros: por tipo de labor (cosecha / trato) y por ciclos incluidos.
  // `initialEnabledCycleIds` decide cuáles arrancan prendidos — útil para la
  // vista a nivel faena donde solo queremos los abiertos por default, pero
  // los cerrados igual deben aparecer como chip apagado por si el usuario
  // quiere verlos también.
  const [typeFilter, setTypeFilter] = useState({ cosecha: true, trato: true });
  const [enabledCycles, setEnabledCycles] = useState(
    () => new Set(initialEnabledCycleIds || cycles.map((c) => c.id)),
  );

  useEffect(() => {
    setEnabledCycles(new Set(initialEnabledCycleIds || cycles.map((c) => c.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycles.map((c) => c.id).join(","), (initialEnabledCycleIds || []).join(",")]);

  // Carga workdays para los ciclos que no tengamos cacheados. El caller puede
  // precargar pasando `workdaysByCycleProp` y evitamos la query.
  useEffect(() => {
    if (!open) return;
    const missing = cycles.filter((c) => !wdByCycle[c.id]);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const fetched = await Promise.all(
          missing.map(async (c) => {
            const all = await workdaysService.list({ cache: true, ttl: 5 * 60 * 1000 });
            const forCycle = all.filter((w) => w.cycleId === c.id);
            return [c.id, forCycle];
          }),
        );
        if (cancelled) return;
        setWdByCycle((prev) => {
          const next = { ...prev };
          for (const [cid, list] of fetched) next[cid] = list;
          return next;
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cycles.map((c) => c.id).join(",")]);

  // Columnas: una por (ciclo, labor) donde labor.type es trato o cosecha. Si
  // dos ciclos tienen labores con el mismo nombre, quedan como columnas
  // separadas — el usuario ve el detalle de cada ciclo sin que se mezclen.
  const columns = useMemo(() => {
    const cols = [];
    for (const c of cycles) {
      if (!enabledCycles.has(c.id)) continue;
      for (const l of c.labors || []) {
        if (l.type !== "cosecha" && l.type !== "trato") continue;
        if (!typeFilter[l.type]) continue;
        cols.push({
          key: `${c.id}__${l.id}`,
          cycleId: c.id,
          cycleLabel: c.label || c.id,
          cycleStatus: c.status || "open",
          labor: l,
          dayPrices: c.dayPrices || {},
        });
      }
    }
    return cols;
  }, [cycles, enabledCycles, typeFilter]);

  // Días: union de todas las fechas con workdays de los ciclos habilitados,
  // ordenadas ascendente. Solo días con al menos un workday relevante.
  const days = useMemo(() => {
    const set = new Set();
    for (const c of cycles) {
      if (!enabledCycles.has(c.id)) continue;
      const wds = wdByCycle[c.id] || [];
      for (const wd of wds) {
        if (wd.date) set.add(wd.date);
      }
    }
    return [...set].sort();
  }, [cycles, enabledCycles, wdByCycle]);

  // Por celda (día × columna) computa qty/amount/precios/personas. Se hace en
  // un solo pase para evitar recorrer workdays N veces en el render.
  const cellsByKey = useMemo(() => {
    const out = new Map(); // `${day}__${colKey}` → cellData
    for (const col of columns) {
      const wds = (wdByCycle[col.cycleId] || []).filter(
        (w) => w.laborId === col.labor.id,
      );
      const byDay = new Map();
      for (const wd of wds) {
        if (!wd.date) continue;
        if (!byDay.has(wd.date)) byDay.set(wd.date, []);
        byDay.get(wd.date).push(wd);
      }
      for (const [day, list] of byDay) {
        const data = buildCell(col.labor, day, list, col.dayPrices, catalogs);
        if (data) out.set(`${day}__${col.key}`, data);
      }
    }
    return out;
  }, [columns, wdByCycle, catalogs]);

  // Por columna (labor): lista de filas día×datos que tiene producción.
  // Usado para renderizar un card independiente por labor con su propia
  // tabla, en lugar de un solo pivot gigante con todas las labores como
  // columnas. Cada card lleva sus botones de copiar/imprimir.
  const dataByColumn = useMemo(() => {
    return columns
      .map((col) => {
        const rows = days
          .map((d) => ({ day: d, cell: cellsByKey.get(`${d}__${col.key}`) }))
          .filter((r) => r.cell);
        const totalQty = rows.reduce((s, r) => s + (r.cell.qty || 0), 0);
        const totalAmount = rows.reduce((s, r) => s + (r.cell.amount || 0), 0);
        const unitSet = new Set();
        const personSet = new Set();
        rows.forEach((r) => {
          if (r.cell.unit) unitSet.add(r.cell.unit);
        });
        // Personas únicas a lo largo de todos los días: sacamos del wd raw
        // para que no se repita el mismo trabajador en varios días.
        const wds = (wdByCycle[col.cycleId] || []).filter(
          (w) => w.laborId === col.labor.id && w.workerRut,
        );
        for (const wd of wds) {
          const hasProd = col.labor.type === "cosecha"
            ? Number(wd.qty) > 0 && !wd.pisoOnly
            : Number(getTratoTierTotals(wd).qty) > 0 && !wd.pisoOnly;
          if (hasProd) personSet.add(wd.workerRut);
        }
        const unitStr = [...unitSet].join("/");
        return {
          col,
          rows,
          totalQty,
          totalAmount,
          unit: unitStr,
          persons: personSet.size,
        };
      })
      .filter((d) => d.rows.length > 0);
  }, [columns, days, cellsByKey, wdByCycle]);

  return (
    <Modal open={open} onClose={onClose} title={title} size="xl">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
        {/* Filtro de tipos */}
        <span className="text-[var(--color-muted)]">Tipo:</span>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={typeFilter.cosecha}
            onChange={(e) => setTypeFilter((p) => ({ ...p, cosecha: e.target.checked }))}
          />
          <span>🌾 Cosecha</span>
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={typeFilter.trato}
            onChange={(e) => setTypeFilter((p) => ({ ...p, trato: e.target.checked }))}
          />
          <span>🛠 Trato</span>
        </label>
        {/* Filtro de ciclos — solo se muestra cuando hay más de uno */}
        {cycles.length > 1 && (
          <>
            <span className="ml-3 text-[var(--color-muted)]">Ciclos:</span>
            <div className="flex flex-wrap gap-1">
              {cycles.map((c) => {
                const on = enabledCycles.has(c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() => setEnabledCycles((prev) => {
                      const next = new Set(prev);
                      if (next.has(c.id)) next.delete(c.id);
                      else next.add(c.id);
                      return next;
                    })}
                    className={`rounded-full px-2 py-0.5 text-[11px] ${
                      on
                        ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                        : "bg-[var(--color-surface-2)] border border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]"
                    }`}
                    title={c.status === "closed" ? "Ciclo cerrado" : "Ciclo abierto"}
                  >
                    {c.label || c.id}
                    {c.status === "closed" && (
                      <span className="ml-1 opacity-70">·🔒</span>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {loading && (
        <div className="py-2 text-center text-xs text-[var(--color-muted)]">Cargando workdays...</div>
      )}

      {columns.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] py-8 text-center text-sm text-[var(--color-muted)]">
          No hay labores de trato o cosecha en los ciclos seleccionados.
        </div>
      ) : dataByColumn.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] py-8 text-center text-sm text-[var(--color-muted)]">
          Sin producción registrada en los ciclos seleccionados.
        </div>
      ) : (
        <div className="space-y-3">
          {/* Tabla general combinada — pivot días × labores con totales por
              día y totales por labor. Aparece arriba para ver el resumen
              global; abajo viene el detalle por labor. */}
          {dataByColumn.length > 1 && (
            <CombinedSummaryCard dataByColumn={dataByColumn} days={days} />
          )}
          {dataByColumn.map((d) => (
            <LaborSummaryCard key={d.col.key} data={d} catalogs={catalogs} />
          ))}
        </div>
      )}
    </Modal>
  );
}

// Card combinada con todas las labores seleccionadas como columnas y los
// días como filas. Cada celda muestra qty (con unidad) arriba y monto
// abajo. Hay una columna "Total día" al final con la suma de montos y una
// fila TOTAL al pie con los acumulados por labor y el gran total.
function CombinedSummaryCard({ dataByColumn, days }) {
  const toast = useToast();
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState("");
  const captureRef = useRef(null);

  // Solo días que tengan al menos un dato en alguna labor visible.
  const activeDays = useMemo(() => {
    const set = new Set();
    for (const d of dataByColumn) for (const r of d.rows) set.add(r.day);
    return [...set].sort();
  }, [dataByColumn]);

  // Mapa rápido por labor de day → cell.
  const byLaborDay = useMemo(() => {
    const m = new Map();
    for (const d of dataByColumn) {
      const inner = new Map();
      for (const r of d.rows) inner.set(r.day, r.cell);
      m.set(d.col.key, inner);
    }
    return m;
  }, [dataByColumn]);

  const totalsByDay = useMemo(() => {
    const out = new Map();
    for (const day of activeDays) {
      let sum = 0;
      for (const d of dataByColumn) {
        const c = byLaborDay.get(d.col.key)?.get(day);
        if (c) sum += c.amount || 0;
      }
      out.set(day, sum);
    }
    return out;
  }, [activeDays, dataByColumn, byLaborDay]);

  const grandTotal = useMemo(
    () => dataByColumn.reduce((s, d) => s + (d.totalAmount || 0), 0),
    [dataByColumn],
  );

  const buildPlainText = () => {
    const lines = [];
    lines.push("📊 TABLA GENERAL — todas las labores seleccionadas");
    lines.push(`Gran total: ${fmtCLP(grandTotal)} · ${dataByColumn.length} labor${dataByColumn.length === 1 ? "" : "es"} · ${activeDays.length} día${activeDays.length === 1 ? "" : "s"}`);
    lines.push("");
    const header = ["Día"];
    for (const d of dataByColumn) header.push(`${d.col.labor.name}`);
    header.push("Total día");
    lines.push(header.join(" | "));
    for (const day of activeDays) {
      const cols = [day];
      for (const d of dataByColumn) {
        const c = byLaborDay.get(d.col.key)?.get(day);
        if (!c) { cols.push("—"); continue; }
        cols.push(`${fmtNum(c.qty)}${c.unit ? " " + c.unit : ""} · ${fmtCLP(c.amount)}`);
      }
      cols.push(fmtCLP(totalsByDay.get(day) || 0));
      lines.push(cols.join(" | "));
    }
    const totalRow = ["TOTAL"];
    for (const d of dataByColumn) totalRow.push(`${fmtNum(d.totalQty)}${d.unit ? " " + d.unit : ""} · ${fmtCLP(d.totalAmount)}`);
    totalRow.push(fmtCLP(grandTotal));
    lines.push(totalRow.join(" | "));
    return lines.join("\n");
  };

  const handleCopyText = async () => {
    setBusy("text");
    try {
      await navigator.clipboard.writeText(buildPlainText());
      toast.success("Texto copiado");
    } catch (err) {
      toast.error("Error al copiar: " + (err.message || err));
    } finally { setBusy(""); }
  };

  const handleCopyImage = async () => {
    if (!captureRef.current) return;
    setBusy("image");
    try {
      const blob = await toBlob(captureRef.current, { backgroundColor: "#ffffff", pixelRatio: 2 });
      if (!blob) throw new Error("No se pudo generar la imagen");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast.success("Imagen copiada");
    } catch (err) {
      toast.error("Error al copiar: " + (err.message || err));
    } finally { setBusy(""); }
  };

  const handlePrint = () => {
    if (!captureRef.current) return;
    const html = captureRef.current.outerHTML;
    const win = window.open("", "_blank", "width=1100,height=700");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>Tabla general</title>
      <style>
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; box-sizing: border-box; }
        body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 20px; color: #000; margin: 0; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #888; padding: 6px 8px; font-size: 11px; }
        @media print { @page { size: landscape; margin: 10mm; } }
      </style>
    </head><body>${html}<script>window.onload = () => { window.focus(); window.print(); };</script></body></html>`);
    win.document.close();
  };

  return (
    <div className="rounded-md border-2 border-[var(--color-border)]">
      <div className="flex flex-wrap items-center gap-2 bg-[var(--color-surface-2)] px-3 py-2 text-sm">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left hover:text-[var(--color-accent)]"
        >
          <span className="text-[var(--color-muted)]">{collapsed ? "▸" : "▾"}</span>
          <div className="min-w-0">
            <div className="font-semibold">📊 Tabla general</div>
            <div className="text-[10px] text-[var(--color-muted)]">
              {dataByColumn.length} labor{dataByColumn.length === 1 ? "" : "es"} · {activeDays.length} día{activeDays.length === 1 ? "" : "s"}
            </div>
          </div>
        </button>
        <div className="text-right">
          <div className="text-[10px] text-[var(--color-muted)]">Gran total</div>
          <div className="font-semibold tabular-nums text-[var(--color-accent)]">{fmtCLP(grandTotal)}</div>
        </div>
        <div className="flex gap-1">
          <button onClick={handleCopyText} disabled={busy === "text"} title="Copiar como texto plano"
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[10px] hover:bg-[var(--color-accent-soft)] disabled:opacity-50">
            {busy === "text" ? "..." : "📋 Texto"}
          </button>
          <button onClick={handleCopyImage} disabled={busy === "image"} title="Copiar como imagen"
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[10px] hover:bg-[var(--color-accent-soft)] disabled:opacity-50">
            {busy === "image" ? "..." : "📋 Imagen"}
          </button>
          <button onClick={handlePrint} title="Imprimir"
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[10px] hover:bg-[var(--color-accent-soft)]">
            🖨
          </button>
        </div>
      </div>
      {!collapsed && (
        <div ref={captureRef} style={{ background: "#fff", color: "#000", padding: 12 }}>
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>📊 Tabla general — resumen consolidado</div>
            <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
              {dataByColumn.length} labores · {activeDays.length} días · gran total {fmtCLP(grandTotal)}
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr style={{ background: HDR_GREEN }}>
                  <th style={cellH}>Día</th>
                  {dataByColumn.map((d) => (
                    <th key={d.col.key} style={{ ...cellH, textAlign: "right", minWidth: 110 }}>
                      <div>{d.col.labor.name}</div>
                      <div style={{ fontSize: 9, fontWeight: 500, color: "#333", marginTop: 1 }}>
                        {d.col.cycleLabel}
                      </div>
                    </th>
                  ))}
                  <th style={{ ...cellH, textAlign: "right", background: ROW_HIGHLIGHT }}>Total día</th>
                </tr>
              </thead>
              <tbody>
                {activeDays.map((day) => {
                  const dayTotal = totalsByDay.get(day) || 0;
                  return (
                    <tr key={day}>
                      <td style={{ ...cell, fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{day}</td>
                      {dataByColumn.map((d) => {
                        const c = byLaborDay.get(d.col.key)?.get(day);
                        if (!c) return <td key={d.col.key} style={{ ...cell, textAlign: "right", color: "#bbb" }}>—</td>;
                        return (
                          <td key={d.col.key} style={{ ...cell, textAlign: "right" }}>
                            <div style={{ fontSize: 11, color: "#444" }}>
                              {fmtNum(c.qty)}{c.unit ? ` ${c.unit}` : ""}
                            </div>
                            <div style={{ fontWeight: 600 }}>{fmtCLP(c.amount)}</div>
                          </td>
                        );
                      })}
                      <td style={{ ...cell, textAlign: "right", fontWeight: 700, background: ROW_HIGHLIGHT }}>
                        {fmtCLP(dayTotal)}
                      </td>
                    </tr>
                  );
                })}
                <tr style={{ background: ROW_TOTAL_DARK, color: "#fff", fontWeight: 700 }}>
                  <td style={{ ...cell, borderColor: "#3d6b2e" }}>TOTAL</td>
                  {dataByColumn.map((d) => (
                    <td key={d.col.key} style={{ ...cell, textAlign: "right", borderColor: "#3d6b2e" }}>
                      <div style={{ fontSize: 10, opacity: 0.9 }}>
                        {fmtNum(d.totalQty)}{d.unit ? ` ${d.unit}` : ""}
                      </div>
                      <div>{fmtCLP(d.totalAmount)}</div>
                    </td>
                  ))}
                  <td style={{ ...cell, textAlign: "right", borderColor: "#3d6b2e", fontSize: 13 }}>
                    {fmtCLP(grandTotal)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// Card independiente por labor — header con título + total + chevron +
// botones de copiar/imprimir, body con la tabla día por día. Default
// colapsado para labores de ciclos cerrados; abierto para ciclos en curso.
function LaborSummaryCard({ data, catalogs }) {
  const toast = useToast();
  const { col, rows, totalQty, totalAmount, unit, persons } = data;
  const [collapsed, setCollapsed] = useState(col.cycleStatus === "closed");
  const [busy, setBusy] = useState("");
  const captureRef = useRef(null);

  const typeLabel = col.labor.type === "cosecha"
    ? "🌾 Cosecha"
    : `🛠 ${tratoTypeLabel(catalogs, col.labor.tratoType ?? 0)}`;

  // Texto plano del desglose para pegar en chat / nota. Mantenemos columnas
  // alineadas con padStart sobre los strings finales — funciona en monospace
  // (WhatsApp Web, Slack, etc.) y se ve razonable en proportional también.
  const buildPlainText = () => {
    const lines = [];
    lines.push(`📊 ${col.labor.name} — ${col.cycleLabel} (${typeLabel})`);
    lines.push(
      `Total: ${fmtNum(totalQty)}${unit ? " " + unit : ""} · ${fmtCLP(totalAmount)} · ${persons} pers`,
    );
    lines.push("");
    lines.push("Día        | Producción            | Precio              | Monto       | Rendimiento");
    for (const { day, cell } of rows) {
      const prod = `${fmtNum(cell.qty)}${cell.unit ? " " + cell.unit : ""}`;
      const price = cell.priceLabel || "—";
      const amt = fmtCLP(cell.amount);
      const rend = cell.persons > 0 ? `${cell.persons} pers · prom ${fmtNum(cell.avg)}` : "—";
      lines.push(
        `${day.padEnd(10, " ")} | ${prod.padEnd(21, " ")} | ${price.padEnd(19, " ")} | ${amt.padEnd(11, " ")} | ${rend}`,
      );
    }
    return lines.join("\n");
  };

  const handleCopyText = async () => {
    setBusy("text");
    try {
      await navigator.clipboard.writeText(buildPlainText());
      toast.success("Texto copiado");
    } catch (err) {
      toast.error("Error al copiar: " + (err.message || err));
    } finally {
      setBusy("");
    }
  };

  const handleCopyImage = async () => {
    if (!captureRef.current) return;
    setBusy("image");
    try {
      const blob = await toBlob(captureRef.current, {
        backgroundColor: "#ffffff",
        pixelRatio: 2,
      });
      if (!blob) throw new Error("No se pudo generar la imagen");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast.success("Imagen copiada");
    } catch (err) {
      toast.error("Error al copiar: " + (err.message || err));
    } finally {
      setBusy("");
    }
  };

  const handlePrint = () => {
    if (!captureRef.current) return;
    const html = captureRef.current.outerHTML;
    const win = window.open("", "_blank", "width=900,height=700");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>Resumen ${col.labor.name}</title>
      <style>
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; box-sizing: border-box; }
        body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 20px; color: #000; margin: 0; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #888; padding: 6px 8px; font-size: 12px; }
        @media print { @page { size: portrait; margin: 12mm; } }
      </style>
    </head><body>${html}<script>window.onload = () => { window.focus(); window.print(); };</script></body></html>`);
    win.document.close();
  };

  return (
    <div className="rounded-md border border-[var(--color-border)]">
      <div className="flex flex-wrap items-center gap-2 bg-[var(--color-surface-2)] px-3 py-2 text-sm">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left hover:text-[var(--color-accent)]"
        >
          <span className="text-[var(--color-muted)]">{collapsed ? "▸" : "▾"}</span>
          <div className="min-w-0">
            <div className="font-semibold truncate">{col.labor.name}</div>
            <div className="text-[10px] text-[var(--color-muted)]">
              {col.cycleLabel}
              {col.cycleStatus === "closed" && <span className="ml-1 opacity-70">·🔒 cerrado</span>}
              {" · "}{typeLabel}
            </div>
          </div>
        </button>
        <div className="text-right">
          {totalQty > 0 && (
            <div className="text-xs text-[var(--color-muted)] tabular-nums">
              {fmtNum(totalQty)}{unit ? " " + unit : ""} · {persons} pers
            </div>
          )}
          <div className="font-semibold tabular-nums text-[var(--color-accent)]">
            {fmtCLP(totalAmount)}
          </div>
        </div>
        <div className="flex gap-1">
          <button
            onClick={handleCopyText}
            disabled={busy === "text"}
            title="Copiar como texto plano"
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[10px] hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
          >
            {busy === "text" ? "..." : "📋 Texto"}
          </button>
          <button
            onClick={handleCopyImage}
            disabled={busy === "image"}
            title="Copiar como imagen"
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[10px] hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
          >
            {busy === "image" ? "..." : "📋 Imagen"}
          </button>
          <button
            onClick={handlePrint}
            title="Imprimir"
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[10px] hover:bg-[var(--color-accent-soft)]"
          >
            🖨
          </button>
        </div>
      </div>
      {!collapsed && (
        <div ref={captureRef} style={{ background: "#fff", color: "#000", padding: 12 }}>
          {/* Header redundante DENTRO del capturable para que la imagen/print
              tengan contexto del labor sin depender del header gris. */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{col.labor.name}</div>
            <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
              {col.cycleLabel} · {typeLabel}
              {col.cycleStatus === "closed" && " · 🔒 cerrado"}
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr style={{ background: HDR_BLUE }}>
                  <th style={cellH}>Día</th>
                  <th style={cellH}>Producción</th>
                  <th style={cellH}>Precio</th>
                  <th style={{ ...cellH, textAlign: "right" }}>Monto</th>
                  <th style={{ ...cellH, textAlign: "right" }}>Rendimiento</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ day, cell: c }) => (
                  <tr key={day}>
                    <td style={{ ...cell, fontFamily: "ui-monospace, monospace" }}>{day}</td>
                    <td style={cell}>
                      <span style={{ fontWeight: 600 }}>{fmtNum(c.qty)}</span>
                      {c.unit && <span style={{ marginLeft: 4, color: "#666" }}>{c.unit}</span>}
                    </td>
                    <td style={{ ...cell, color: "#444" }}>{c.priceLabel || "—"}</td>
                    <td style={{ ...cell, textAlign: "right", fontWeight: 600 }}>{fmtCLP(c.amount)}</td>
                    <td style={{ ...cell, textAlign: "right", color: "#666" }}>
                      {c.persons > 0 ? `${c.persons} pers · prom ${fmtNum(c.avg)}` : "—"}
                    </td>
                  </tr>
                ))}
                <tr style={{ background: ROW_TOTAL_LIGHT, fontWeight: 700 }}>
                  <td style={cell}>TOTAL</td>
                  <td style={cell}>
                    {fmtNum(totalQty)}
                    {unit && <span style={{ marginLeft: 4, color: "#555" }}>{unit}</span>}
                  </td>
                  <td style={{ ...cell, fontSize: 10, color: "#555" }}>
                    {persons} personas únicas
                  </td>
                  <td style={{ ...cell, textAlign: "right" }}>{fmtCLP(totalAmount)}</td>
                  <td style={cell}></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// Construye los datos de una celda a partir de los workdays del día/labor.
// Maneja cosecha (multi-combo: kilos por calidad/envase) y trato (multi-tier:
// qty por unidad/precio). Devuelve null si no hay producción real.
function buildCell(labor, date, workdays, dayPrices, catalogs) {
  if (!workdays?.length) return null;
  if (labor.type === "cosecha") {
    let qty = 0;
    let amount = 0;
    const containerSet = new Set();
    const ruts = new Set();
    for (const wd of workdays) {
      if (wd.pisoOnly) continue;
      const kg = Number(wd.qty) || 0;
      const amt = Number(wd.amount) || 0;
      const cy = Number(wd.containerY) || 0;
      qty += kg;
      amount += amt;
      if (cy != null) containerSet.add(cy);
      if (kg > 0 && wd.workerRut) ruts.add(wd.workerRut);
    }
    if (qty === 0 && amount === 0) return null;
    const unit = cosechaUnit(catalogs, containerSet).toLowerCase();
    // Precio: si hay un solo combo (calidad/envase) mostramos su precio. Si
    // hay varios, mostramos el rango. Si no hay configurado, derivamos $/kg.
    const combos = getDayCombos(dayPrices, labor.id, date);
    let priceLabel = "";
    const activeCombos = combos.filter((c) => c.price > 0);
    if (activeCombos.length === 1) {
      const c0 = activeCombos[0];
      priceLabel = c0.mode === "flat"
        ? `${fmtCLP(c0.price)}/día`
        : `${fmtCLP(c0.price)}/${containerLabel(catalogs, c0.y).toLowerCase()}`;
    } else if (activeCombos.length > 1) {
      priceLabel = activeCombos
        .map((c) => `${qualityLabel(catalogs, c.x)}: ${fmtCLP(c.price)}`)
        .join(" · ");
    } else if (qty > 0) {
      priceLabel = `~${fmtCLP(amount / qty)}/u`;
    }
    const persons = ruts.size;
    const avg = persons > 0 ? qty / persons : 0;
    return { qty, amount, unit, priceLabel, persons, avg };
  }
  if (labor.type === "trato") {
    let qty = 0;
    let amount = 0;
    const unitSet = new Set();
    const ruts = new Set();
    for (const wd of workdays) {
      if (wd.pisoOnly) continue;
      const t = getTratoTierTotals(wd);
      qty += t.qty;
      amount += t.amount;
      if (t.qty > 0 && wd.workerRut) ruts.add(wd.workerRut);
    }
    if (qty === 0 && amount === 0) return null;
    // Unidad y precio salen de los tiers configurados ese día.
    const tiers = getTratoTiers(dayPrices, labor.id, date);
    const activeTiers = tiers.filter((t) => t.price > 0);
    let priceLabel = "";
    if (activeTiers.length === 1) {
      const t0 = activeTiers[0];
      const unitLbl = t0.unit == null ? null : tratoUnitLabel(catalogs, t0.unit);
      if (unitLbl) unitSet.add(unitLbl.toLowerCase());
      priceLabel = t0.mode === "flat"
        ? `${fmtCLP(t0.price)}/día`
        : `${fmtCLP(t0.price)}/${unitLbl ? unitLbl.toLowerCase() : "unid"}`;
    } else if (activeTiers.length > 1) {
      for (const t of activeTiers) {
        const u = t.unit == null ? null : tratoUnitLabel(catalogs, t.unit);
        if (u) unitSet.add(u.toLowerCase());
      }
      priceLabel = activeTiers
        .map((t, i) => `P${i + 1}: ${fmtCLP(t.price)}`)
        .join(" · ");
    } else if (qty > 0) {
      priceLabel = `~${fmtCLP(amount / qty)}/u`;
    }
    // Si no hay unidad configurada caemos al tipo de trato como label visual.
    const unit = unitSet.size > 0
      ? [...unitSet].join("/")
      : tratoTypeLabel(catalogs, labor.tratoType ?? 0).toLowerCase();
    const persons = ruts.size;
    const avg = persons > 0 ? qty / persons : 0;
    return { qty, amount, unit, priceLabel, persons, avg };
  }
  return null;
}
