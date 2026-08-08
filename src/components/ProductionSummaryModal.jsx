import { useEffect, useMemo, useRef, useState } from "react";
import { captureFullWidthBlob } from "../utils/imageCapture";
import Modal from "./Modal";
import { workdaysService } from "../services";
import { tripsService } from "../services/transportsService";
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
import { countingStageIds, normalizeStages } from "../utils/tratoEtapas";

const fmtCLP = (v) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 })
    .format(Number(v) || 0);
const fmtNum = (v) =>
  new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 }).format(Number(v) || 0);
// "2026-07-24" → "24/07", para mostrar rangos de fecha compactos en tablas.
const shortDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${m[3]}/${m[2]}` : (iso || "");
};

// Persistencia de las opciones que el usuario configura en este modal
// (filtros, % de ganancia, valores "pagan $", IVA, etc.) — así no hay que
// re-ingresarlas cada vez que se reabre el resumen. Las claves por labor
// (pctOverrides/paidToUs/workersPaid) usan colKey = cycleId__laborId, que es
// estable en el tiempo, así que quedan asociadas al ciclo/labor correctos
// aunque se reabra el modal semanas después.
const LS_PREFIX = "productionSummary.";
const loadJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw != null ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
};
const saveJSON = (key, value) => {
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); } catch { /* noop */ }
};

// Qué ciclos quedan tildados en el selector se recuerda por id de ciclo
// (mapa acumulativo en localStorage, nunca se resetea entero) — así, si el
// usuario destilda un ciclo, sigue destildado la próxima vez que se abra el
// resumen, sea de la misma faena o de otra. Los ciclos que todavía no se
// vieron nunca (no están en el mapa) usan el default que manda el caller
// (`initialEnabledCycleIds`, típicamente "solo los abiertos").
const computeEnabledCycles = (cyclesList, initialEnabledCycleIds) => {
  const map = loadJSON("enabledCyclesMap", {});
  const defaults = new Set(initialEnabledCycleIds || cyclesList.map((c) => c.id));
  const set = new Set();
  for (const c of cyclesList) {
    const v = map[c.id];
    if (v === true || (v === undefined && defaults.has(c.id))) set.add(c.id);
  }
  return set;
};

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
// Rampa de verdes para el bloque TOTAL/GANANCIAS/TOTAL GENERAL/IVA/BRUTO de
// la tabla general — mismo tono base que el resto, pero cada fila con un
// matiz distinto para que no se vea como un solo bloque sólido pegado.
const ROW_GANANCIAS = "#93c47d";      // verde más claro que TOTAL — fila GANANCIAS
const ROW_TOTAL_GENERAL = "#38761d";  // verde bosque — fila TOTAL GENERAL
const ROW_IVA = "#d9ead3";            // verde muy pálido — fila IVA (informativa, texto oscuro)
const ROW_BRUTO = "#274e13";          // verde más oscuro — fila BRUTO (el total final)

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
  const [tripsByCycle, setTripsByCycle] = useState({});
  const [loading, setLoading] = useState(false);
  // Filtros: por tipo de labor (cosecha / trato) y por ciclos incluidos.
  // `initialEnabledCycleIds` decide cuáles arrancan prendidos — útil para la
  // vista a nivel faena donde solo queremos los abiertos por default, pero
  // los cerrados igual deben aparecer como chip apagado por si el usuario
  // quiere verlos también.
  const [typeFilter, setTypeFilter] = useState(
    () => loadJSON("typeFilter", { cosecha: true, trato: true, tratoEtapas: true, main: true, supervision: true }),
  );
  useEffect(() => { saveJSON("typeFilter", typeFilter); }, [typeFilter]);
  // Aparte del filtro por tipo de labor, un toggle propio para poner/sacar
  // la fila TRANSPORTE (y su derivada MONTO LIBRE NETO) de la tabla, sin
  // perder el cálculo por ciclo que sigue disponible si se vuelve a activar.
  const [includeTransport, setIncludeTransport] = useState(() => loadJSON("includeTransport", true));
  useEffect(() => { saveJSON("includeTransport", includeTransport); }, [includeTransport]);
  const [enabledCycles, setEnabledCyclesState] = useState(
    () => computeEnabledCycles(cycles, initialEnabledCycleIds),
  );
  // Envuelve el setter para que, además de actualizar el estado, persista el
  // on/off de cada ciclo tocado en el mapa acumulativo de localStorage.
  const setEnabledCycles = (updater) => {
    setEnabledCyclesState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      const map = loadJSON("enabledCyclesMap", {});
      for (const c of cycles) map[c.id] = next.has(c.id);
      saveJSON("enabledCyclesMap", map);
      return next;
    });
  };
  // Toggle maestro: colapsa/expande de un solo click todas las tarjetas de
  // ciclos cerrados (cada una ya arranca colapsada por defecto individualmente
  // si el ciclo está cerrado; esto fuerza el estado de TODAS a la vez para no
  // tener que ir card por card cuando hay muchos ciclos cerrados en la lista).
  const [allClosedCollapsed, setAllClosedCollapsed] = useState(() => loadJSON("allClosedCollapsed", true));
  useEffect(() => { saveJSON("allClosedCollapsed", allClosedCollapsed); }, [allClosedCollapsed]);

  useEffect(() => {
    setEnabledCyclesState(computeEnabledCycles(cycles, initialEnabledCycleIds));
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

  // Carga las vueltas de transporte de cada ciclo — usadas por la fila
  // TRANSPORTE de la tabla general (costo de transporte por ciclo).
  useEffect(() => {
    if (!open) return;
    const missing = cycles.filter((c) => !tripsByCycle[c.id]);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const fetched = await Promise.all(
          missing.map(async (c) => [c.id, await tripsService.listByCycle(c.id)]),
        );
        if (cancelled) return;
        setTripsByCycle((prev) => {
          const next = { ...prev };
          for (const [cid, list] of fetched) next[cid] = list;
          return next;
        });
      } catch { /* noop */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cycles.map((c) => c.id).join(",")]);

  // Orden de columnas/chips: agrupadas por subfaena (para que los ciclos de
  // una misma subfaena queden uno al lado del otro) y, dentro de cada grupo,
  // en orden cronológico ascendente (más viejo primero) por el primer día
  // real trabajado — mismo criterio que la navegación prev/next de
  // CycleDetail, más confiable que startDate/createdAt tipeados a mano. Los
  // grupos de subfaena también se ordenan cronológicamente por su ciclo más
  // antiguo, así toda la tabla queda de más vieja a más nueva, agrupada por
  // subfaena (ej. sub1/ciclo8 · sub1/ciclo9 · sub2/ciclo4 · sub3/ciclo1).
  const orderedCycles = useMemo(() => {
    const sortKeyFor = (c) => {
      const days = c.days;
      if (Array.isArray(days) && days.length > 0) {
        return days.reduce((min, d) => (d < min ? d : min), days[0]);
      }
      return c.startDate || c.createdAt?.toDate?.()?.toISOString?.() || "";
    };
    const groups = new Map(); // subfaenaId (o "" para huérfanos) -> cycles[]
    for (const c of cycles) {
      const key = c.subfaenaId || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const groupList = [...groups.values()].map((list) => {
      const sorted = [...list].sort((a, b) => sortKeyFor(a).localeCompare(sortKeyFor(b)));
      return { sorted, groupKey: sorted.length > 0 ? sortKeyFor(sorted[0]) : "" };
    });
    groupList.sort((a, b) => a.groupKey.localeCompare(b.groupKey));
    return groupList.flatMap((g) => g.sorted);
  }, [cycles]);

  // Columnas: una por (ciclo, labor) donde labor.type es trato, cosecha,
  // trato por etapas o pago al día (jornadas). Si dos ciclos tienen labores
  // con el mismo nombre, quedan como columnas separadas — el usuario ve el
  // detalle de cada ciclo sin que se mezclen.
  const columns = useMemo(() => {
    const cols = [];
    for (const c of orderedCycles) {
      if (!enabledCycles.has(c.id)) continue;
      for (const l of c.labors || []) {
        if (l.type !== "cosecha" && l.type !== "trato" && l.type !== "tratoEtapas" && l.type !== "main" && l.type !== "supervision") continue;
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
  }, [orderedCycles, enabledCycles, typeFilter]);

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
        const countingForCol = col.labor.type === "tratoEtapas" ? countingStageIds(col.labor) : null;
        for (const wd of wds) {
          let hasProd;
          if (col.labor.type === "cosecha") {
            hasProd = Number(wd.qty) > 0 && !wd.pisoOnly;
          } else if (col.labor.type === "tratoEtapas") {
            // Solo cuenta como "persona con producción" si aportó en una etapa
            // que cuenta (misma regla que las unidades).
            hasProd = countingForCol.has(String(wd.stageId)) && Number(wd.qty) > 0 && !wd.pisoOnly;
          } else if (col.labor.type === "main" || col.labor.type === "supervision") {
            // Pago al día: el monto ya está directo en el workday, sin tiers.
            hasProd = Number(wd.amount) > 0 && !wd.pisoOnly;
          } else {
            hasProd = Number(getTratoTierTotals(wd).qty) > 0 && !wd.pisoOnly;
          }
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

  // Costo de transporte por ciclo (no por labor — un ciclo puede tener
  // varias columnas de labor, pero el transporte es uno solo por ciclo).
  // `hasTrips` distingue $0 porque hay vueltas creadas sin monto (revisar
  // tarifas) de $0 porque no se cargó ninguna vuelta (típico cuando el
  // transporte es propio y no se factura, aunque también puede ser un
  // olvido — sin datos no hay forma de distinguir eso último).
  const transportByCycle = useMemo(() => {
    const out = new Map();
    for (const c of cycles) {
      const trips = tripsByCycle[c.id] || [];
      out.set(c.id, {
        total: trips.reduce((s, t) => s + (Number(t.amount) || 0), 0),
        hasTrips: trips.length > 0,
      });
    }
    return out;
  }, [cycles, tripsByCycle]);

  // Primera columna visible de cada ciclo — ahí (y solo ahí) se muestra el
  // total de transporte de ese ciclo, para no duplicarlo cuando un ciclo
  // tiene varias labores/columnas y así no inflar el gran total.
  const firstColKeyForCycle = useMemo(() => {
    const seen = new Map();
    for (const d of dataByColumn) {
      if (!seen.has(d.col.cycleId)) seen.set(d.col.cycleId, d.col.key);
    }
    return seen;
  }, [dataByColumn]);

  const grandTotalTransport = useMemo(() => {
    const cycleIds = new Set(dataByColumn.map((d) => d.col.cycleId));
    let sum = 0;
    for (const cid of cycleIds) sum += transportByCycle.get(cid)?.total || 0;
    return sum;
  }, [dataByColumn, transportByCycle]);

  return (
    <Modal open={open} onClose={onClose} title={title} size="2xl">
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
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={typeFilter.tratoEtapas}
            onChange={(e) => setTypeFilter((p) => ({ ...p, tratoEtapas: e.target.checked }))}
          />
          <span>🏕 Por etapas</span>
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={typeFilter.main}
            onChange={(e) => setTypeFilter((p) => ({ ...p, main: e.target.checked }))}
          />
          <span>💰 Jornadas</span>
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={typeFilter.supervision}
            onChange={(e) => setTypeFilter((p) => ({ ...p, supervision: e.target.checked }))}
          />
          <span>🧑‍💼 Supervisión</span>
        </label>
        <span className="mx-1 h-4 w-px bg-[var(--color-border)]" />
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={includeTransport}
            onChange={(e) => setIncludeTransport(e.target.checked)}
          />
          <span>🚐 Transporte</span>
        </label>
      </div>

      {/* Selector de ciclos como tabla: mucho más legible que los chips que
          tenía antes cuando hay varios ciclos — se ve de un vistazo el
          estado y los días trabajados de cada uno. Los cerrados se colapsan
          por defecto (son los que más se acumulan) detrás de un resumen
          "+N cerrados". El on/off de cada ciclo se persiste por id en
          localStorage (ver `computeEnabledCycles`), así la selección se
          mantiene aunque se reabra el resumen otro día. */}
      {cycles.length > 1 && (
        <div className="mb-3 overflow-hidden rounded-md border border-[var(--color-border)]">
          <div className="flex items-center justify-between bg-[var(--color-surface-2)] px-2 py-1.5 text-xs">
            <span className="font-medium text-[var(--color-muted)]">Ciclos incluidos</span>
            <button
              type="button"
              onClick={() => setAllClosedCollapsed((v) => !v)}
              className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-0.5 text-[11px] hover:bg-[var(--color-accent-soft)]"
              title="Colapsa o expande los ciclos cerrados de la tabla, para que no ocupen tanto espacio"
            >
              {allClosedCollapsed ? "▸ Expandir cerrados" : "▾ Colapsar cerrados"}
            </button>
          </div>
          <div className="max-h-44 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[var(--color-surface)] text-left text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
                <tr>
                  <th className="w-7 px-2 py-1"></th>
                  <th className="px-2 py-1">Ciclo</th>
                  <th className="px-2 py-1 text-right">Días trabajados</th>
                  <th className="px-2 py-1">Estado</th>
                </tr>
              </thead>
              <tbody>
                {orderedCycles.map((c) => {
                  if (allClosedCollapsed && c.status === "closed") return null;
                  const on = enabledCycles.has(c.id);
                  const days = Array.isArray(c.days) ? c.days : [];
                  const dayCount = days.length;
                  const range = dayCount > 0
                    ? [...days].sort().reduce((r, d) => ({ from: r.from < d ? r.from : d, to: r.to > d ? r.to : d }), { from: days[0], to: days[0] })
                    : null;
                  return (
                    <tr
                      key={c.id}
                      onClick={() => setEnabledCycles((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.id)) next.delete(c.id);
                        else next.add(c.id);
                        return next;
                      })}
                      title={range ? `${range.from} → ${range.to}` : "sin días trabajados"}
                      className={`cursor-pointer border-t border-[var(--color-border)] ${on ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-surface-2)]"}`}
                    >
                      <td className="px-2 py-1">
                        <input type="checkbox" checked={on} readOnly className="pointer-events-none" />
                      </td>
                      <td className="px-2 py-1 font-medium">{c.label || c.id}</td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        <div>{dayCount} día{dayCount === 1 ? "" : "s"}</div>
                        {range && (
                          <div className="text-[10px] font-normal text-[var(--color-muted)]">
                            {shortDate(range.from)} → {shortDate(range.to)}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1">
                        {c.status === "closed" ? (
                          <span className="rounded-full bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--color-muted)]">🔒 cerrado</span>
                        ) : (
                          <span className="rounded-full bg-[var(--color-success-soft)] px-1.5 py-0.5 text-[10px] text-[var(--color-success)]">abierto</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {allClosedCollapsed && (() => {
            const closedCount = orderedCycles.filter((c) => c.status === "closed").length;
            if (closedCount === 0) return null;
            return (
              <button
                type="button"
                onClick={() => setAllClosedCollapsed(false)}
                className="w-full border-t border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-center text-[11px] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
              >
                🔒 +{closedCount} cerrado{closedCount === 1 ? "" : "s"} — mostrar
              </button>
            );
          })()}
        </div>
      )}

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
            <CombinedSummaryCard
              dataByColumn={dataByColumn}
              days={days}
              transportByCycle={transportByCycle}
              firstColKeyForCycle={firstColKeyForCycle}
              grandTotalTransport={grandTotalTransport}
              includeTransport={includeTransport}
            />
          )}
          {dataByColumn.map((d) => (
            <LaborSummaryCard key={d.col.key} data={d} catalogs={catalogs} allClosedCollapsed={allClosedCollapsed} />
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
function CombinedSummaryCard({ dataByColumn, days, transportByCycle, firstColKeyForCycle, grandTotalTransport, includeTransport }) {
  const toast = useToast();
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState("");
  const captureRef = useRef(null);
  // Ganancia por labor: para labores de trato/cosecha/por-etapas se calcula
  // como monto × %, editable de forma independiente por columna. `generalPct`
  // es un control "maestro": al cambiarlo se pisan todos los % individuales
  // (pctOverrides se vacía) para que todas las columnas vuelvan a seguirlo.
  // Para labores de pago al día (jornadas) no hay % — se ingresa a mano lo
  // que nos pagarán por esa labor, y la ganancia es la diferencia contra el
  // monto (lo que le debemos a los trabajadores). Si ya les pagamos ese
  // monto (checkbox "workersPaid"), el monto pasa a ser solo informativo —
  // ya no se resta, así que TODO lo que nos paguen es ganancia. Todo esto se
  // persiste en localStorage por colKey (cycleId__laborId) para no tener que
  // re-ingresarlo cada vez que se reabre el modal.
  const [generalPct, setGeneralPct] = useState(() => loadJSON("generalPct", 40));
  useEffect(() => { saveJSON("generalPct", generalPct); }, [generalPct]);
  const [pctOverrides, setPctOverrides] = useState(() => loadJSON("pctOverrides", {})); // colKey -> % (solo no-jornada)
  useEffect(() => { saveJSON("pctOverrides", pctOverrides); }, [pctOverrides]);
  const [paidToUs, setPaidToUs] = useState(() => loadJSON("paidToUs", {})); // colKey -> $ pagado a nosotros (solo jornada)
  useEffect(() => { saveJSON("paidToUs", paidToUs); }, [paidToUs]);
  const [workersPaid, setWorkersPaid] = useState(() => loadJSON("workersPaid", {})); // colKey -> bool (solo jornada)
  useEffect(() => { saveJSON("workersPaid", workersPaid); }, [workersPaid]);
  // Si el resumen va con IVA: agrega una fila final que suma 19% solo sobre
  // el gran total (columna "Total día"), las columnas por labor quedan en
  // blanco en esa fila.
  const [ivaEnabled, setIvaEnabled] = useState(() => loadJSON("ivaEnabled", false));
  useEffect(() => { saveJSON("ivaEnabled", ivaEnabled); }, [ivaEnabled]);

  const isJornadaCol = (col) => col.labor.type === "main";
  // Supervisión no se cobra aparte: normalmente ya está considerada dentro
  // del % de ganancia del resto de las labores, así que en vez de sumarle
  // su propio % se descuenta completa (monto negativo) — reduce la ganancia
  // total y su "total general" queda en $0 (no se le cobra nada al cliente
  // por esta línea, es un costo interno ya cubierto por el margen general).
  const isSupervisionCol = (col) => col.labor.type === "supervision";
  const effectivePct = (colKey) => pctOverrides[colKey] ?? generalPct;
  const gananciaFor = (col, totalAmount) => {
    if (isJornadaCol(col)) {
      const paid = Number(paidToUs[col.key]) || 0;
      if (workersPaid[col.key]) return paid;
      return paid - totalAmount;
    }
    if (isSupervisionCol(col)) return -totalAmount;
    return (totalAmount * effectivePct(col.key)) / 100;
  };
  // Total general por columna: monto + ganancia, salvo el caso de jornada ya
  // pagada — ahí el monto ya está cubierto aparte (no se vuelve a sumar) y
  // solo se considera lo que nos van a pagar, que es 100% ganancia.
  // Supervisión SIEMPRE es $0 acá — no es que "monto + ganancia" den cero por
  // casualidad, es una regla explícita: lo que se factura al cliente no debe
  // depender jamás de cuánto se gastó en supervisión, ese costo se cubre con
  // el margen de las demás labores y solo se refleja como descuento
  // informativo en la fila GANANCIAS, nunca en lo facturado.
  const totalGeneralFor = (col, totalAmount) => {
    if (isSupervisionCol(col)) return 0;
    if (isJornadaCol(col) && workersPaid[col.key]) {
      return Number(paidToUs[col.key]) || 0;
    }
    return totalAmount + gananciaFor(col, totalAmount);
  };
  const handleGeneralPctChange = (v) => {
    setGeneralPct(v);
    setPctOverrides({});
  };

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

  const totalGanancia = useMemo(
    () => dataByColumn.reduce((s, d) => s + gananciaFor(d.col, d.totalAmount), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataByColumn, generalPct, pctOverrides, paidToUs, workersPaid],
  );
  // GANANCIAS y SUPERVISIÓN son filas separadas: GANANCIAS muestra el margen
  // puro de las labores facturables, sin tocar por el descuento de
  // supervisión. El "monto libre" (ganancia − supervisión) se calcula y
  // muestra únicamente en la celda de gran total de la fila SUPERVISIÓN,
  // mostrando los dos montos de la resta — no reemplaza ni reduce el total
  // de GANANCIAS.
  const totalGananciaBillable = useMemo(
    () => dataByColumn.reduce((s, d) => s + (isSupervisionCol(d.col) ? 0 : gananciaFor(d.col, d.totalAmount)), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataByColumn, generalPct, pctOverrides, paidToUs, workersPaid],
  );
  const totalSupervisionDeduction = useMemo(
    () => dataByColumn.reduce((s, d) => s + (isSupervisionCol(d.col) ? gananciaFor(d.col, d.totalAmount) : 0), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataByColumn, generalPct, pctOverrides, paidToUs, workersPaid],
  );
  const hasSupervisionCols = dataByColumn.some((d) => isSupervisionCol(d.col));
  const grandTotalGeneral = useMemo(
    () => dataByColumn.reduce((s, d) => s + totalGeneralFor(d.col, d.totalAmount), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataByColumn, generalPct, pctOverrides, paidToUs, workersPaid],
  );
  const grandTotalIva = grandTotalGeneral * 0.19;
  const grandTotalBruto = grandTotalGeneral + grandTotalIva;

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
    const totalRow = ["TOTAL A PAGAR"];
    for (const d of dataByColumn) {
      const paidTag = isJornadaCol(d.col) && workersPaid[d.col.key] ? " [ya pagado]" : "";
      totalRow.push(`${fmtNum(d.totalQty)}${d.unit ? " " + d.unit : ""} · ${fmtCLP(d.totalAmount)}${paidTag}`);
    }
    totalRow.push(fmtCLP(grandTotal));
    lines.push(totalRow.join(" | "));
    lines.push("");
    lines.push("💰 GANANCIAS");
    for (const d of dataByColumn) {
      if (isSupervisionCol(d.col)) continue;
      const g = gananciaFor(d.col, d.totalAmount);
      const detail = isJornadaCol(d.col)
        ? (workersPaid[d.col.key] ? `pagan ${fmtCLP(Number(paidToUs[d.col.key]) || 0)}, ya pagado` : `pagan ${fmtCLP(Number(paidToUs[d.col.key]) || 0)}`)
        : `${effectivePct(d.col.key)}%`;
      lines.push(`${d.col.labor.name} (${d.col.cycleLabel}) [${detail}]: ${fmtCLP(g)}`);
    }
    lines.push(`TOTAL GANANCIAS: ${fmtCLP(totalGananciaBillable)}`);
    lines.push("");
    if (includeTransport) {
      lines.push("🚐 TRANSPORTE (por ciclo)");
      const seenCycles = new Set();
      for (const d of dataByColumn) {
        if (seenCycles.has(d.col.cycleId)) continue;
        seenCycles.add(d.col.cycleId);
        const t = transportByCycle.get(d.col.cycleId) || { total: 0, hasTrips: false };
        const tag = t.total === 0 ? (t.hasTrips ? " [vueltas creadas]" : " [sin vueltas]") : "";
        lines.push(`${d.col.cycleLabel}: ${fmtCLP(t.total)}${tag}`);
      }
      lines.push(`TOTAL TRANSPORTE: ${fmtCLP(grandTotalTransport)}`);
      lines.push("");
    }
    if (hasSupervisionCols) {
      lines.push("➖ MONTO LIBRE (descuento por supervisión, informativo, no afecta lo facturado)");
      for (const d of dataByColumn) {
        if (!isSupervisionCol(d.col)) continue;
        lines.push(`${d.col.labor.name} (${d.col.cycleLabel}): ${fmtCLP(gananciaFor(d.col, d.totalAmount))}`);
      }
      lines.push(`TOTAL SUPERVISIÓN: ${fmtCLP(totalSupervisionDeduction)}`);
      lines.push(`MONTO LIBRE (${fmtCLP(totalGananciaBillable)} − ${fmtCLP(Math.abs(totalSupervisionDeduction))}): ${fmtCLP(totalGanancia)}`);
      lines.push("");
    }
    if (includeTransport && grandTotalTransport !== 0) {
      lines.push(`MONTO LIBRE NETO (${fmtCLP(totalGanancia)} − ${fmtCLP(grandTotalTransport)}, descuenta también transporte): ${fmtCLP(totalGanancia - grandTotalTransport)}`);
      lines.push("");
    }
    const generalRow = ["TOTAL GENERAL"];
    for (const d of dataByColumn) generalRow.push(fmtCLP(totalGeneralFor(d.col, d.totalAmount)));
    generalRow.push(fmtCLP(grandTotalGeneral));
    lines.push(generalRow.join(" | "));
    if (ivaEnabled) {
      lines.push("");
      lines.push(`IVA (19%): ${fmtCLP(grandTotalIva)}`);
      lines.push(`BRUTO: ${fmtCLP(grandTotalBruto)}`);
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
    } finally { setBusy(""); }
  };

  const handleCopyImage = async () => {
    if (!captureRef.current) return;
    setBusy("image");
    try {
      const blob = await captureFullWidthBlob(captureRef.current);
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
        <>
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
                  <td style={{ ...cell, borderColor: "#3d6b2e" }}>TOTAL A PAGAR</td>
                  {dataByColumn.map((d) => (
                    <td key={d.col.key} style={{ ...cell, textAlign: "right", borderColor: "#3d6b2e" }}>
                      <div style={{ fontSize: 10, opacity: 0.9 }}>
                        {fmtNum(d.totalQty)}{d.unit ? ` ${d.unit}` : ""}
                      </div>
                      <div>{fmtCLP(d.totalAmount)}</div>
                      {isJornadaCol(d.col) && workersPaid[d.col.key] && (
                        <div style={{ fontSize: 9, fontWeight: 400, marginTop: 1, color: "#d4f5d4" }}>✅ ya pagado</div>
                      )}
                      {isSupervisionCol(d.col) && (
                        <div style={{ fontSize: 9, fontWeight: 400, marginTop: 1, color: "#d4f5d4" }}>➖NF</div>
                      )}
                    </td>
                  ))}
                  <td style={{ ...cell, textAlign: "right", borderColor: "#3d6b2e", fontSize: 13 }}>
                    {fmtCLP(grandTotal)}
                  </td>
                </tr>
                <tr style={{ background: ROW_GANANCIAS, color: "#1a2e0f", fontWeight: 700 }}>
                  <td style={{ ...cell, borderColor: "#6aa84f" }}>GANANCIAS</td>
                  {dataByColumn.map((d) => (
                    <td key={d.col.key} style={{ ...cell, textAlign: "right", borderColor: "#6aa84f" }}>
                      {isSupervisionCol(d.col) ? "—" : fmtCLP(gananciaFor(d.col, d.totalAmount))}
                    </td>
                  ))}
                  <td style={{ ...cell, textAlign: "right", borderColor: "#6aa84f", fontSize: 13 }}>
                    {fmtCLP(totalGananciaBillable)}
                  </td>
                </tr>
                {includeTransport && (
                  <tr style={{ background: ROW_TOTAL_DARK, color: "#fff", fontWeight: 700 }}>
                    <td style={{ ...cell, borderColor: "#3d6b2e" }}>TRANSPORTE</td>
                    {dataByColumn.map((d) => {
                      const isFirst = firstColKeyForCycle.get(d.col.cycleId) === d.col.key;
                      if (!isFirst) {
                        return (
                          <td key={d.col.key} style={{ ...cell, textAlign: "right", borderColor: "#3d6b2e" }}>—</td>
                        );
                      }
                      const t = transportByCycle.get(d.col.cycleId) || { total: 0, hasTrips: false };
                      return (
                        <td key={d.col.key} style={{ ...cell, textAlign: "right", borderColor: "#3d6b2e" }}>
                          {fmtCLP(t.total)}
                          {t.total === 0 && (
                            <div style={{ fontSize: 9, fontWeight: 400, marginTop: 1, color: "#d4f5d4" }}>
                              {t.hasTrips ? "vueltas creadas" : "sin vueltas"}
                            </div>
                          )}
                        </td>
                      );
                    })}
                    <td style={{ ...cell, textAlign: "right", borderColor: "#3d6b2e", fontSize: 13 }}>
                      {fmtCLP(grandTotalTransport)}
                    </td>
                  </tr>
                )}
                {hasSupervisionCols && (
                  <tr style={{ background: ROW_IVA, color: "#274e13", fontWeight: 700 }}>
                    <td style={{ ...cell, borderColor: "#93c47d" }}>MONTO LIBRE</td>
                    {dataByColumn.map((d) => (
                      <td key={d.col.key} style={{ ...cell, textAlign: "right", borderColor: "#93c47d" }}>
                        {isSupervisionCol(d.col) ? fmtCLP(gananciaFor(d.col, d.totalAmount)) : "—"}
                      </td>
                    ))}
                    <td style={{ ...cell, textAlign: "right", borderColor: "#93c47d", fontSize: 13 }}>
                      <div style={{ fontSize: 9, fontWeight: 400 }}>
                        {fmtCLP(totalGananciaBillable)} − {fmtCLP(Math.abs(totalSupervisionDeduction))}
                      </div>
                      <div>{fmtCLP(totalGanancia)}</div>
                    </td>
                  </tr>
                )}
                {includeTransport && grandTotalTransport !== 0 && (
                  <tr style={{ background: ROW_IVA, color: "#274e13", fontWeight: 700 }}>
                    <td style={{ ...cell, borderColor: "#93c47d" }}>MONTO LIBRE NETO</td>
                    {dataByColumn.map((d) => (
                      <td key={d.col.key} style={{ ...cell, borderColor: "#93c47d" }}></td>
                    ))}
                    <td style={{ ...cell, textAlign: "right", borderColor: "#93c47d", fontSize: 13 }}>
                      <div style={{ fontSize: 9, fontWeight: 400 }}>
                        {fmtCLP(totalGanancia)} − {fmtCLP(grandTotalTransport)}
                      </div>
                      <div>{fmtCLP(totalGanancia - grandTotalTransport)}</div>
                    </td>
                  </tr>
                )}
                <tr style={{ background: ROW_TOTAL_GENERAL, color: "#fff", fontWeight: 700 }}>
                  <td style={{ ...cell, borderColor: "#274e13" }}>TOTAL GENERAL</td>
                  {dataByColumn.map((d) => (
                    <td key={d.col.key} style={{ ...cell, textAlign: "right", borderColor: "#274e13" }}>
                      {fmtCLP(totalGeneralFor(d.col, d.totalAmount))}
                      {isSupervisionCol(d.col) && (
                        <div style={{ fontSize: 9, fontWeight: 400, marginTop: 1, color: "#d4f5d4" }}>➖NF</div>
                      )}
                    </td>
                  ))}
                  <td style={{ ...cell, textAlign: "right", borderColor: "#274e13", fontSize: 13 }}>
                    {fmtCLP(grandTotalGeneral)}
                  </td>
                </tr>
                {ivaEnabled && (
                  <>
                    <tr style={{ background: ROW_IVA, color: "#274e13", fontWeight: 700 }}>
                      <td style={{ ...cell, borderColor: "#93c47d" }}>IVA (19%)</td>
                      {dataByColumn.map((d) => (
                        <td key={d.col.key} style={{ ...cell, borderColor: "#93c47d" }}></td>
                      ))}
                      <td style={{ ...cell, textAlign: "right", borderColor: "#93c47d", fontSize: 13 }}>
                        {fmtCLP(grandTotalIva)}
                      </td>
                    </tr>
                    <tr style={{ background: ROW_BRUTO, color: "#fff", fontWeight: 700 }}>
                      <td style={{ ...cell, borderColor: "#16260a" }}>BRUTO</td>
                      {dataByColumn.map((d) => (
                        <td key={d.col.key} style={{ ...cell, borderColor: "#16260a" }}></td>
                      ))}
                      <td style={{ ...cell, textAlign: "right", borderColor: "#16260a", fontSize: 13 }}>
                        {fmtCLP(grandTotalBruto)}
                      </td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Tabla auxiliar para AJUSTAR la ganancia — a propósito FUERA de
            captureRef: no debe salir al copiar/imprimir, solo ayuda en
            pantalla a editar los % (o lo que paga el cliente en labores de
            jornada), lo que alimenta las filas GANANCIAS/TOTAL GENERAL de
            la tabla de arriba. */}
        <div style={{ marginTop: 12, borderTop: "2px solid #ccc", paddingTop: 10, padding: "10px 12px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 13, fontWeight: 700 }}>
              <span>💰 Ajustar ganancia</span>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 400, color: "#444", marginLeft: 8 }}>
                % general:
                <input
                  type="number"
                  min="0"
                  value={generalPct}
                  onChange={(e) => handleGeneralPctChange(Math.max(0, Number(e.target.value) || 0))}
                  title="Al cambiarlo se aplica a todas las labores que no sean de jornada, pisando cualquier % propio editado abajo"
                  style={{ width: 56, padding: "2px 5px", border: "1px solid #999", borderRadius: 4, textAlign: "right" }}
                />
                %
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 400, color: "#444", marginLeft: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={ivaEnabled}
                  onChange={(e) => setIvaEnabled(e.target.checked)}
                />
                Resumen con IVA (19%)
              </label>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr style={{ background: HDR_GREEN }}>
                    <th style={cellH}>Labor</th>
                    <th style={{ ...cellH, textAlign: "right" }}>Monto</th>
                    <th style={{ ...cellH, textAlign: "right" }}>% / pagan</th>
                    <th style={{ ...cellH, textAlign: "right" }}>Ganancia</th>
                  </tr>
                </thead>
                <tbody>
                  {dataByColumn.map((d) => (
                    <tr key={d.col.key}>
                      <td style={cell}>
                        {d.col.labor.name}
                        <span style={{ marginLeft: 4, fontSize: 9, color: "#888" }}>· {d.col.cycleLabel}</span>
                      </td>
                      <td style={{ ...cell, textAlign: "right" }}>
                        {fmtCLP(d.totalAmount)}
                        {isJornadaCol(d.col) && workersPaid[d.col.key] && (
                          <div style={{ fontSize: 9, fontWeight: 700, color: "#2e7d32", marginTop: 1 }}>
                            ✅ ya pagado <span style={{ fontWeight: 400, color: "#666" }}>(solo informativo)</span>
                          </div>
                        )}
                        {isSupervisionCol(d.col) && (
                          <div style={{ fontSize: 9, fontWeight: 700, color: "#b91c1c", marginTop: 1 }}>
                            ➖ descuento <span style={{ fontWeight: 400, color: "#666" }}>(cubierto por el % general)</span>
                          </div>
                        )}
                      </td>
                      <td style={{ ...cell, textAlign: "right" }}>
                        {isSupervisionCol(d.col) ? (
                          <span style={{ fontSize: 10, color: "#666", fontStyle: "italic" }}>
                            −100% (automático)
                          </span>
                        ) : isJornadaCol(d.col) ? (
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                              $
                              <input
                                type="number"
                                min="0"
                                value={paidToUs[d.col.key] ?? ""}
                                onChange={(e) => setPaidToUs((p) => ({ ...p, [d.col.key]: e.target.value }))}
                                placeholder="0"
                                title="Lo que nos van a pagar por esta labor"
                                style={{ width: 80, padding: "2px 4px", border: "1px solid #999", borderRadius: 4, textAlign: "right" }}
                              />
                            </span>
                            <label style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9, color: "#444", cursor: "pointer" }}>
                              <input
                                type="checkbox"
                                checked={!!workersPaid[d.col.key]}
                                onChange={(e) => setWorkersPaid((p) => ({ ...p, [d.col.key]: e.target.checked }))}
                              />
                              ya pagamos a los trabajadores
                            </label>
                          </div>
                        ) : (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                            <input
                              type="number"
                              min="0"
                              value={effectivePct(d.col.key)}
                              onChange={(e) => setPctOverrides((p) => ({ ...p, [d.col.key]: Math.max(0, Number(e.target.value) || 0) }))}
                              title="% propio de esta labor — edítalo para separarlo del % general"
                              style={{ width: 50, padding: "2px 4px", border: "1px solid #999", borderRadius: 4, textAlign: "right" }}
                            />
                            %
                          </span>
                        )}
                      </td>
                      <td style={{ ...cell, textAlign: "right", fontWeight: 600 }}>
                        {fmtCLP(gananciaFor(d.col, d.totalAmount))}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ background: ROW_TOTAL_DARK, color: "#fff", fontWeight: 700 }}>
                    <td style={{ ...cell, borderColor: "#3d6b2e" }}>TOTAL</td>
                    <td style={{ ...cell, textAlign: "right", borderColor: "#3d6b2e" }}>{fmtCLP(grandTotal)}</td>
                    <td style={{ ...cell, borderColor: "#3d6b2e" }}></td>
                    <td style={{ ...cell, textAlign: "right", borderColor: "#3d6b2e", fontSize: 13 }}>
                      {fmtCLP(totalGanancia)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Card independiente por labor — header con título + total + chevron +
// botones de copiar/imprimir, body con la tabla día por día. Default
// colapsado para labores de ciclos cerrados; abierto para ciclos en curso.
function LaborSummaryCard({ data, catalogs, allClosedCollapsed }) {
  const toast = useToast();
  const { col, rows, totalQty, totalAmount, unit, persons } = data;
  const isClosed = col.cycleStatus === "closed";
  const [collapsed, setCollapsed] = useState(isClosed);
  const [busy, setBusy] = useState("");
  const captureRef = useRef(null);

  // El toggle maestro del modal fuerza el colapso de todas las tarjetas
  // cerradas a la vez; una tarjeta abierta nunca se ve afectada por esto. El
  // usuario puede seguir expandiendo/colapsando cada una manualmente después
  // — el próximo click al toggle maestro vuelve a sincronizar todas.
  useEffect(() => {
    if (isClosed) setCollapsed(allClosedCollapsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allClosedCollapsed]);

  const typeLabel = col.labor.type === "cosecha"
    ? "🌾 Cosecha"
    : col.labor.type === "tratoEtapas"
      ? "🏕 Por etapas"
      : col.labor.type === "main"
        ? "💰 Jornadas"
        : col.labor.type === "supervision"
          ? "🧑‍💼 Supervisión"
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
      const blob = await captureFullWidthBlob(captureRef.current);
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
  if (labor.type === "tratoEtapas") {
    // Conteo del día (qty) = solo etapas que cuentan; pago (amount) = todas.
    // El desglose por etapa del día (priceLabel) también se limita a las que
    // cuentan — las demás no aportan al conteo, así que no van en el detalle.
    const counting = countingStageIds(labor);
    let qty = 0;
    let amount = 0;
    const ruts = new Set();
    const byStage = new Map(); // stageId → qty del día
    for (const wd of workdays) {
      if (wd.pisoOnly) continue;
      amount += Number(wd.amount) || 0;
      const q = Number(wd.qty) || 0;
      const sid = String(wd.stageId ?? "");
      byStage.set(sid, (byStage.get(sid) || 0) + q);
      if (counting.has(sid)) {
        qty += q;
        if (q > 0 && wd.workerRut) ruts.add(wd.workerRut);
      }
    }
    if (qty === 0 && amount === 0) return null;
    // Desglose "Inst 5" con solo las etapas que cuentan — las que no cuentan
    // no aportan al conteo de unidades, así que no van en el detalle.
    const stages = normalizeStages(labor.stages);
    const priceLabel = stages
      .filter((s) => s.counts && (byStage.get(String(s.id)) || 0) > 0)
      .map((s) => `${s.name} ${fmtNum(byStage.get(String(s.id)))}`)
      .join(" · ");
    const persons = ruts.size;
    const avg = persons > 0 ? qty / persons : 0;
    return { qty, amount, unit: "unid", priceLabel, persons, avg };
  }
  if (labor.type === "main" || labor.type === "supervision") {
    // Pago al día: no hay precio/unidad que calcular, el monto ya viene
    // directo en cada workday. La "cantidad" es el número de jornadas
    // (trabajadores distintos pagados ese día). Supervisión usa la misma
    // mecánica de monto-por-día-por-trabajador que jornadas (main).
    let amount = 0;
    const ruts = new Set();
    for (const wd of workdays) {
      if (wd.pisoOnly) continue;
      const amt = Number(wd.amount) || 0;
      amount += amt;
      if (amt > 0 && wd.workerRut) ruts.add(wd.workerRut);
    }
    if (amount === 0) return null;
    const qty = ruts.size;
    const persons = ruts.size;
    const avg = qty > 0 ? amount / qty : 0;
    const priceLabel = qty > 0 ? `~${fmtCLP(avg)}/jornada` : "";
    return { qty, amount, unit: "jornadas", priceLabel, persons, avg };
  }
  return null;
}
