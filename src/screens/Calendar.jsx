import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "../firebase";
import { faenasService, subfaenasService, cyclesService, workersService } from "../services";
import { tripsService } from "../services/transportsService";
import { useCarriers } from "../contexts/CarriersContext";
import { useCatalogs } from "../contexts/CatalogsContext";
import { tratoTypeLabel, cosechaUnit, qualityLabel, containerLabel, getTratoTierTotals } from "../utils/cosechaCombos";
import { useIsMobile } from "../hooks/useIsMobile";

// ============================================================================
// CALENDARIO DE PRODUCCIÓN
// ============================================================================
// Muestra un mes con celdas por día. Cada celda lista las subfaenas que
// trabajaron ese día como barras de color. Click en una barra (o en la
// celda completa) abre un drawer con el detalle del día.
//
// ESTRATEGIA DE LECTURAS — hoy y mañana
// ─────────────────────────────────────
// Hoy (Option A): leemos los workdays del rango del mes y agregamos en el
// cliente. A escala actual (~700-3,000 workdays/mes en pico) son ~3k reads
// por vista del mes, costo ~US$0.02. Cache de sesión (5 min) reduce reads
// si el usuario navega para atrás/adelante.
//
// FUTURO — snapshot para ciclos cerrados:
//   Cuando los meses superen consistentemente los 5,000 workdays:
//   1. Al CERRAR un ciclo, escribir un doc por (date, faenaId) en una
//      colección `daySummary` con los agregados ya calculados
//      (workdaysByLabor, transports, totales).
//   2. `loadMonth` cambia internamente: para días que pertenecen a ciclos
//      cerrados → lee `daySummary` (1 doc por día × faena = ~150 reads/mes);
//      para días que pertenecen a ciclos abiertos → leve igual que hoy.
//   3. La UI no cambia: el contract de retorno de `loadMonth` se mantiene.
//
// Esa migración es agregar `daySummary` collection + cambiar UNA función,
// no romper nada del calendario en sí.
// ============================================================================

const COLOR_PALETTE = [
  "#0ea5e9", "#f59e0b", "#10b981", "#8b5cf6",
  "#ef4444", "#06b6d4", "#ec4899", "#84cc16",
  "#f97316", "#6366f1", "#14b8a6", "#a855f7",
  "#dc2626", "#7c3aed", "#059669", "#d97706",
];

// Color estable basado en hash del id. Si en el futuro queremos que el
// usuario elija color, basta agregar `subfaena.color` y caer al hash.
function colorForSubfaena(subfaenaId) {
  const s = String(subfaenaId || "");
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length];
}

const fmtCurrency = (v) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 }).format(
    Number(v) || 0,
  );

const fmtNumber = (v) =>
  new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 }).format(Number(v) || 0);

const MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

// Sábado/domingo — la convención del proyecto los marca en rojo (igual que
// los grids de tratoHE). Los feriados configurados a nivel labor viven en
// dayPrices y no están disponibles acá, así que solo cubrimos finde.
function isWeekendDate(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return false;
  const dow = d.getDay();
  return dow === 0 || dow === 6;
}

const WEEKDAY_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MONTH_SHORT_LIST = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
// "vie 16-may-2026" — más leíble que la ISO cruda en los headers de modales.
function humanDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return dateStr;
  return `${WEEKDAY_SHORT[d.getDay()]} ${String(d.getDate()).padStart(2, "0")}-${MONTH_SHORT_LIST[d.getMonth()]}-${d.getFullYear()}`;
}

const LABOR_TYPE_LABEL = {
  cosecha: "cosecha",
  trato: "a trato",
  tratoHE: "jornadas (HE)",
  main: "al día",
  supervision: "supervisión",
  extra: "adicional",
};

// Texto a mostrar en la columna "Métrica" según tipo de labor. Devuelve
// vacío para labores al día (no aportan número, el monto cuenta la historia).
// Para trato usa el label del catálogo (ej. "poda") en vez del literal "trato".
function laborMetricLabel(l, catalogs) {
  if (l.laborType === "cosecha") {
    if (!(l.kilos > 0)) return "";
    const unit = cosechaUnit(catalogs, l.containers).toLowerCase();
    return `${fmtNumber(l.kilos)} ${unit}`;
  }
  if (l.laborType === "trato") {
    if (!(l.tratoQty > 0)) return "";
    const unit = tratoTypeLabel(catalogs, l.tratoType ?? 0);
    return `${fmtNumber(l.tratoQty)} ${unit}`;
  }
  if (l.laborType === "tratoHE") {
    const parts = [];
    if (l.jornadas > 0) parts.push(`${fmtNumber(l.jornadas)} j`);
    if (l.overtimeHours > 0) parts.push(`${fmtNumber(l.overtimeHours)} HE`);
    return parts.join(" + ");
  }
  // main / supervision / extra → solo jornadas
  return l.jornadas > 0 ? `${fmtNumber(l.jornadas)} j` : "";
}

// ============================================================================
// Cache de sesión por mes — TTL 5 min
// ============================================================================

const CACHE_TTL = 5 * 60 * 1000;
const cacheKey = (y, m) => `af.calendar.${y}.${String(m).padStart(2, "0")}`;

function readMonthCache(y, m) {
  try {
    const raw = sessionStorage.getItem(cacheKey(y, m));
    if (!raw) return null;
    const { ts, workdays } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) return null;
    return workdays;
  } catch {
    return null;
  }
}

function writeMonthCache(y, m, workdays) {
  try {
    sessionStorage.setItem(
      cacheKey(y, m),
      JSON.stringify({ ts: Date.now(), workdays }),
    );
  } catch {
    // quota exceeded — silencioso, no crashea el render
  }
}

function invalidateMonthCache(y, m) {
  try { sessionStorage.removeItem(cacheKey(y, m)); } catch { /* noop */ }
}

// ============================================================================
// Data loaders
// ============================================================================

function monthBounds(year, month) {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { start, end, lastDay };
}

// Trae los workdays crudos del rango. Es la query que paga reads — N por mes.
// Helper aparte para que el día que migremos a snapshot, sea LA función que
// cambia (ver bloque doc arriba).
async function fetchWorkdaysInRange(start, end) {
  const snap = await getDocs(
    query(
      collection(db, "workdays"),
      where("date", ">=", start),
      where("date", "<=", end),
    ),
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function fetchTripsInRange(start, end) {
  const snap = await getDocs(
    query(
      collection(db, "transports"),
      where("date", ">=", start),
      where("date", "<=", end),
    ),
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ============================================================================
// Component
// ============================================================================

export default function Calendar() {
  const { carriers } = useCarriers();
  const { catalogs } = useCatalogs();
  const today = useMemo(() => new Date(), []);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1); // 1..12

  const [workdays, setWorkdays] = useState([]);
  const [trips, setTrips] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [faenas, setFaenas] = useState([]);
  const [subfaenas, setSubfaenas] = useState([]);
  // Lista completa de trabajadores — necesaria para mostrar nombres en el
  // drawer del día. Compartido con el módulo Workers via cache 2h en
  // localStorage; primera carga ~500-2000 reads, después gratis.
  const [workers, setWorkers] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [readCount, setReadCount] = useState(0); // info para mostrar lecturas
  const [fromCache, setFromCache] = useState(false);

  const [selectedDay, setSelectedDay] = useState(null); // { date, subfaenaId? }

  // Filtro UI-only de subfaenas. `null` = mostrar todas. Cuando se activa el
  // filtro guardamos el Set serializado en localStorage para que persista
  // entre sesiones. NO afecta a la query de Firestore — solo oculta las
  // barras en la grilla, en el modal del día y en la leyenda.
  const [excludedSubfaenas, setExcludedSubfaenas] = useState(() => {
    try {
      const raw = localStorage.getItem("calendar.excludedSubfaenas");
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  });
  useEffect(() => {
    try {
      localStorage.setItem("calendar.excludedSubfaenas", JSON.stringify([...excludedSubfaenas]));
    } catch { /* noop */ }
  }, [excludedSubfaenas]);
  const toggleSubfaenaFilter = (id) => {
    setExcludedSubfaenas((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const clearSubfaenaFilter = () => setExcludedSubfaenas(new Set());
  // Aislar = mostrar solo esta subfaena y ocultar el resto. Requiere conocer
  // todas las subfaenas presentes en el mes; se las pasamos a la Legend
  // calculadas más abajo y nos las devuelve en el callback.
  const isolateSubfaena = (idToKeep, allIds) => {
    const next = new Set();
    for (const id of allIds) if (id !== idToKeep) next.add(id);
    setExcludedSubfaenas(next);
  };

  const isMobile = useIsMobile();

  // Carga inicial de metadata (cycles/faenas/subfaenas). Usa el cache de los
  // services. No cuenta como reads "calendario" porque es metadata estable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c, f, s, w] = await Promise.all([
          cyclesService.list({ cache: true, ttl: 5 * 60 * 1000 }),
          faenasService.list({ cache: true, persist: true, ttl: 10 * 60 * 1000 }),
          subfaenasService.list({ cache: true, persist: true, ttl: 10 * 60 * 1000 }),
          workersService.list({
            order: ["name", "asc"],
            cache: true,
            persist: true,
            ttl: 2 * 60 * 60 * 1000,
          }),
        ]);
        if (cancelled) return;
        setCycles(c);
        setFaenas(f);
        setSubfaenas(s);
        setWorkers(w);
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Carga workdays + trips del mes seleccionado. Usa cache de sesión (5min)
  // y los trips se cargan en paralelo (también N reads pero suelen ser pocos).
  const loadMonth = async (y, m, { forceFresh = false } = {}) => {
    setLoading(true);
    setError("");
    setFromCache(false);
    try {
      const { start, end } = monthBounds(y, m);
      let wds = forceFresh ? null : readMonthCache(y, m);
      if (wds) {
        setWorkdays(wds);
        setReadCount(0);
        setFromCache(true);
      } else {
        wds = await fetchWorkdaysInRange(start, end);
        writeMonthCache(y, m, wds);
        setWorkdays(wds);
        setReadCount(wds.length);
      }
      // Trips se cargan siempre frescos por ahora — son chicos.
      const ts = await fetchTripsInRange(start, end);
      setTrips(ts);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMonth(year, month);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month]);

  // ─── Índices y agregaciones ──────────────────────────────────────────────

  const cycleById = useMemo(() => {
    const m = new Map();
    for (const c of cycles) m.set(c.id, c);
    return m;
  }, [cycles]);

  const faenaById = useMemo(() => {
    const m = new Map();
    for (const f of faenas) m.set(f.id, f);
    return m;
  }, [faenas]);

  const subfaenaById = useMemo(() => {
    const m = new Map();
    for (const s of subfaenas) m.set(s.id, s);
    return m;
  }, [subfaenas]);

  const carrierById = useMemo(() => {
    const m = new Map();
    for (const c of carriers) m.set(c.id, c);
    return m;
  }, [carriers]);

  const workerById = useMemo(() => {
    const m = new Map();
    for (const w of workers) m.set(w.id, w);
    return m;
  }, [workers]);

  // Para cada día, qué subfaenas trabajaron y con cuánta actividad.
  // Forma: { [date]: { [subfaenaId]: { workerCount, kilos, jornadas, amount, name, faenaName } } }
  const dayIndex = useMemo(() => {
    const idx = {};
    for (const wd of workdays) {
      const date = wd.date;
      if (!date) continue;
      const cycle = cycleById.get(wd.cycleId);
      if (!cycle) continue;
      const subfaenaId = cycle.subfaenaId || "(sin-subfaena)";
      if (!idx[date]) idx[date] = {};
      if (!idx[date][subfaenaId]) {
        const sub = subfaenaById.get(subfaenaId);
        const faena = sub ? faenaById.get(sub.faenaId) : null;
        idx[date][subfaenaId] = {
          subfaenaId,
          name: sub?.name || "Sin subfaena",
          faenaName: faena?.name || "",
          color: colorForSubfaena(subfaenaId),
          workers: new Set(),
          kilos: 0,
          jornadas: 0,
          amount: 0,
        };
      }
      const e = idx[date][subfaenaId];
      e.workers.add(wd.workerRut);
      e.kilos += Number(wd.qty) || 0;
      e.amount += Number(wd.amount) || 0;
      // jornadas: 1 por workday no-cosecha-no-trato (simplificación para vista mensual)
      const labor = (cycle.labors || []).find((l) => l.id === wd.laborId);
      const t = labor?.type;
      if (t === "tratoHE") e.jornadas += Number(wd.qty) || 0;
      else if (t === "main" || t === "supervision" || t === "extra") e.jornadas += 1;
    }
    // Convertir Sets en counts y array por día
    const out = {};
    for (const date in idx) {
      out[date] = Object.values(idx[date])
        .map((e) => ({ ...e, workerCount: e.workers.size, workers: undefined }))
        .sort((a, b) => b.workerCount - a.workerCount);
    }
    return out;
  }, [workdays, cycleById, subfaenaById, faenaById]);

  // Vista filtrada del dayIndex que respeta `excludedSubfaenas`. Solo afecta
  // a la grilla, leyenda y modal del día — los datos crudos quedan igual.
  const visibleDayIndex = useMemo(() => {
    if (!excludedSubfaenas || excludedSubfaenas.size === 0) return dayIndex;
    const out = {};
    for (const date in dayIndex) {
      const arr = dayIndex[date].filter((it) => !excludedSubfaenas.has(it.subfaenaId));
      if (arr.length > 0) out[date] = arr;
    }
    return out;
  }, [dayIndex, excludedSubfaenas]);

  // ─── Navegación de mes ───────────────────────────────────────────────────

  const goPrev = () => {
    if (month === 1) {
      setMonth(12);
      setYear(year - 1);
    } else {
      setMonth(month - 1);
    }
    setSelectedDay(null);
  };
  const goNext = () => {
    if (month === 12) {
      setMonth(1);
      setYear(year + 1);
    } else {
      setMonth(month + 1);
    }
    setSelectedDay(null);
  };
  const goToday = () => {
    setYear(today.getFullYear());
    setMonth(today.getMonth() + 1);
    setSelectedDay(null);
  };
  const refresh = () => {
    invalidateMonthCache(year, month);
    loadMonth(year, month, { forceFresh: true });
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Calendario</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Producción diaria por subfaena.
            {fromCache ? " · resultado de caché" : ` · ${readCount} reads`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={goPrev}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
            title="Mes anterior"
          >
            ◀
          </button>
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-medium">
            {MONTH_NAMES[month - 1]} {year}
          </div>
          <button
            type="button"
            onClick={goNext}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
            title="Mes siguiente"
          >
            ▶
          </button>
          <button
            type="button"
            onClick={goToday}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
          >
            Hoy
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
            title="Forzar refresh (ignora cache)"
          >
            ↻
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 p-3 text-sm text-[var(--color-danger)]">
          {error}
        </div>
      )}

      <MonthGrid
        year={year}
        month={month}
        dayIndex={visibleDayIndex}
        loading={loading}
        // En mobile el click en la barra (que es chiquita) cae al cell click:
        // siempre abre el modal del día y desde ahí el usuario tapea la subfaena.
        onCellClick={(date) => setSelectedDay({ date, mode: "all" })}
        onBarClick={
          isMobile
            ? (date) => setSelectedDay({ date, mode: "all" })
            : (date, subfaenaId) => setSelectedDay({ date, mode: "subfaena", subfaenaId })
        }
      />

      <Legend
        dayIndex={dayIndex}
        excludedSubfaenas={excludedSubfaenas}
        onToggle={toggleSubfaenaFilter}
        onIsolate={isolateSubfaena}
        onClear={clearSubfaenaFilter}
      />

      {selectedDay && selectedDay.mode === "subfaena" && (
        <DayDetailDrawer
          date={selectedDay.date}
          subfaenaId={selectedDay.subfaenaId}
          workdays={workdays.filter((wd) => wd.date === selectedDay.date)}
          trips={trips.filter((t) => t.date === selectedDay.date)}
          cycleById={cycleById}
          subfaenaById={subfaenaById}
          faenaById={faenaById}
          carrierById={carrierById}
          workerById={workerById}
          catalogs={catalogs}
          onClose={() => {
            // Si veníamos del modal de expansión del día (click en zona
            // blanca), volvemos a esa vista en vez de cerrar todo. Mantiene
            // la cadena para navegar entre subfaenas sin perder contexto.
            if (selectedDay.from === "all") {
              setSelectedDay({ date: selectedDay.date, mode: "all" });
            } else {
              setSelectedDay(null);
            }
          }}
        />
      )}

      {selectedDay && selectedDay.mode === "all" && (
        <DayExpandedModal
          date={selectedDay.date}
          subfaenasOfDay={visibleDayIndex[selectedDay.date] || []}
          subfaenaById={subfaenaById}
          faenaById={faenaById}
          onClose={() => setSelectedDay(null)}
          onPickSubfaena={(subfaenaId) =>
            setSelectedDay({ date: selectedDay.date, mode: "subfaena", subfaenaId, from: "all" })
          }
        />
      )}
    </div>
  );
}

// ============================================================================
// Month grid
// ============================================================================

function MonthGrid({ year, month, dayIndex, loading, onCellClick, onBarClick }) {
  const { lastDay } = monthBounds(year, month);
  const firstWeekday = new Date(year, month - 1, 1).getDay(); // 0=Domingo
  // Offset si la semana arranca en lunes (sun=0 → 6, mon=1 → 0, etc.)
  const offset = (firstWeekday + 6) % 7;
  const todayStr = new Date().toISOString().slice(0, 10);

  const cells = [];
  for (let i = 0; i < offset; i++) cells.push({ empty: true, key: `e${i}` });
  for (let d = 1; d <= lastDay; d++) {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push({ date, day: d });
  }
  while (cells.length % 7 !== 0) cells.push({ empty: true, key: `f${cells.length}` });

  return (
    <div>
      <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
        {["L", "M", "M", "J", "V", "S", "D"].map((d, i) => (
          <div key={`h${i}`} className="py-1">{d}</div>
        ))}
      </div>
      <div className={`grid grid-cols-7 gap-1 ${loading ? "opacity-50 pointer-events-none" : ""}`}>
        {cells.map((c) => {
          if (c.empty) return <div key={c.key} className="aspect-square" />;
          const items = dayIndex[c.date] || [];
          const isToday = c.date === todayStr;
          return (
            <div
              key={c.date}
              onClick={() => onCellClick(c.date)}
              className={`flex aspect-square cursor-pointer flex-col rounded border p-1 transition-colors hover:border-[var(--color-accent)] ${
                isToday
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]/30"
                  : "border-[var(--color-border)] bg-[var(--color-surface)]"
              }`}
            >
              <div
                className={`text-xs ${
                  isToday
                    ? "font-semibold text-[var(--color-accent)]"
                    : isWeekendDate(c.date)
                      ? "font-medium text-[#dc2626]"
                      : "text-[var(--color-muted)]"
                }`}
              >
                {c.day}
              </div>
              <div className="mt-1 flex-1 space-y-0.5 overflow-hidden">
                {items.slice(0, 4).map((it) => (
                  <button
                    key={it.subfaenaId}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onBarClick(c.date, it.subfaenaId);
                    }}
                    className="block w-full truncate rounded px-1 py-0.5 text-left text-[10px] font-medium leading-tight text-white hover:opacity-90"
                    style={{ backgroundColor: it.color }}
                    title={`${it.faenaName ? it.faenaName + " · " : ""}${it.name} · ${it.workerCount} trabajador${it.workerCount === 1 ? "" : "es"}`}
                  >
                    {it.name}
                  </button>
                ))}
                {items.length > 4 && (
                  <div className="text-[9px] text-[var(--color-muted)]">
                    +{items.length - 4} más
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Legend de colores
// ============================================================================

// Leyenda interactiva: cada chip toggleable filtra la subfaena en la grilla y
// el modal del día. Doble-click aísla esa subfaena (oculta el resto). Si todas
// están visibles no aparece el botón "limpiar". Para evitar el flicker entre
// el primer click y el dblclick, usamos un pequeño timer (~220ms) que aplaza
// el toggle hasta confirmar que no era un doble-click.
function Legend({ dayIndex, excludedSubfaenas, onToggle, onIsolate, onClear }) {
  const subfaenas = useMemo(() => {
    const seen = new Map();
    for (const date in dayIndex) {
      for (const it of dayIndex[date]) {
        if (!seen.has(it.subfaenaId)) {
          seen.set(it.subfaenaId, {
            subfaenaId: it.subfaenaId,
            name: it.name,
            faenaName: it.faenaName,
            color: it.color,
          });
        }
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [dayIndex]);

  const allIds = useMemo(() => subfaenas.map((s) => s.subfaenaId), [subfaenas]);
  const clickTimer = useRef(null);
  const cancelPendingClick = () => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
  };
  const handleClick = (id) => {
    cancelPendingClick();
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      onToggle(id);
    }, 220);
  };
  const handleDoubleClick = (id) => {
    cancelPendingClick();
    onIsolate(id, allIds);
  };
  useEffect(() => () => cancelPendingClick(), []);

  if (subfaenas.length === 0) return null;
  const hasFilter = excludedSubfaenas && excludedSubfaenas.size > 0;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-[11px]">
      <span className="text-[var(--color-muted)]">
        Subfaenas{hasFilter ? " (click para mostrar/ocultar · doble-click para aislar)" : " (doble-click para aislar)"}:
      </span>
      {subfaenas.map((s) => {
        const excluded = excludedSubfaenas?.has(s.subfaenaId);
        return (
          <button
            type="button"
            key={s.subfaenaId}
            onClick={() => handleClick(s.subfaenaId)}
            onDoubleClick={() => handleDoubleClick(s.subfaenaId)}
            title={excluded ? "Click: mostrar · doble-click: aislar" : "Click: ocultar · doble-click: aislar"}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition-opacity ${
              excluded
                ? "border-dashed border-[var(--color-border)] bg-transparent opacity-40"
                : "border-transparent bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"
            }`}
          >
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
            <span className={excluded ? "line-through" : ""}>{s.name}</span>
            {s.faenaName && <span className="text-[var(--color-muted)]">· {s.faenaName}</span>}
          </button>
        );
      })}
      {hasFilter && (
        <button
          type="button"
          onClick={onClear}
          className="ml-auto rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[var(--color-muted)] hover:text-[var(--color-accent)]"
        >
          Mostrar todas
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Day detail drawer
// ============================================================================

function DayDetailDrawer({ date, subfaenaId, workdays, trips, cycleById, subfaenaById, faenaById, carrierById, workerById, catalogs, onClose }) {
  // Set de labors expandidas para mostrar el desglose por trabajador +
  // distribución por calidad. Cerrado por default para mantener compacto.
  const [expandedLabors, setExpandedLabors] = useState(() => new Set());
  const toggleLabor = (key) =>
    setExpandedLabors((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // Si subfaenaId está set, filtramos workdays/trips a esa subfaena. Caemos
  // por cycle.subfaenaId para workdays; trips heredan via cycle.
  const filteredWorkdays = useMemo(() => {
    if (!subfaenaId) return workdays;
    return workdays.filter((wd) => {
      const cycle = cycleById.get(wd.cycleId);
      return cycle?.subfaenaId === subfaenaId;
    });
  }, [workdays, subfaenaId, cycleById]);

  const filteredTrips = useMemo(() => {
    if (!subfaenaId) return trips;
    return trips.filter((t) => {
      const cycle = cycleById.get(t.cycleId);
      return cycle?.subfaenaId === subfaenaId;
    });
  }, [trips, subfaenaId, cycleById]);

  // Aggregations. Cada métrica suma solo lo que corresponde a su tipo de
  // labor: kilos viene de cosecha, tratoQty de labors a trato, etc. En el
  // render abajo escondemos las tarjetas que queden en 0 para que el
  // resumen refleje lo que de verdad pasó ese día.
  const totals = useMemo(() => {
    const workers = new Set();
    let kilos = 0;
    let tratoQty = 0;
    let amount = 0;
    let jornadas = 0;
    let overtimeHours = 0;
    let pisoAmount = 0;
    let pisoCount = 0;
    const tratoTypes = new Set();
    const cosechaContainers = new Set();
    for (const wd of filteredWorkdays) {
      workers.add(wd.workerRut);
      amount += Number(wd.amount) || 0;
      if (wd.pisoOnly) {
        pisoAmount += Number(wd.amount) || 0;
        pisoCount += 1;
        continue; // ya contamos el monto, no aporta producción/jornada
      }
      const cycle = cycleById.get(wd.cycleId);
      const labor = cycle?.labors?.find((l) => l.id === wd.laborId);
      const t = labor?.type;
      if (t === "cosecha") {
        kilos += Number(wd.qty) || 0;
        cosechaContainers.add(Number(wd.containerY) || 0);
      } else if (t === "trato") {
        tratoTypes.add(labor?.tratoType ?? 0);
        tratoQty += getTratoTierTotals(wd).qty;
      } else if (t === "tratoHE") {
        jornadas += Number(wd.qty) || 0;
        overtimeHours += Number(wd.overtimeHours) || 0;
      } else {
        jornadas += 1;
      }
    }
    const tripsTotal = filteredTrips.reduce((s, t) => s + (Number(t.amount) || 0), 0);
    const tratoLabel = tratoTypes.size === 1
      ? tratoTypeLabel(catalogs, [...tratoTypes][0])
      : "Trato";
    const cosechaUnitLabel = cosechaUnit(catalogs, cosechaContainers);
    return {
      workerCount: workers.size,
      kilos,
      cosechaUnitLabel,
      tratoQty,
      tratoLabel,
      amount,
      jornadas,
      overtimeHours,
      pisoAmount,
      pisoCount,
      tripsCount: filteredTrips.length,
      tripsTotal,
    };
  }, [filteredWorkdays, filteredTrips, cycleById, catalogs]);

  // Por labor: agrupa workdays por (cycleId, laborId). Mostramos solo las
  // métricas que aplican al tipo de labor (no inventamos kilos en supervisión
  // ni jornadas en cosecha). Además guarda dos breakdowns para expandir en
  // el drawer:
  //   - `workersMap`: per-trabajador con su producción (kilos / tratoQty /
  //     jornadas / monto / piso). Se convierte a array `workersBreakdown`.
  //   - `qualityMap`: para cosecha, totales por combo (calidadX/envaseY).
  const byLabor = useMemo(() => {
    const map = new Map();
    for (const wd of filteredWorkdays) {
      const key = `${wd.cycleId}__${wd.laborId}`;
      if (!map.has(key)) {
        const cycle = cycleById.get(wd.cycleId);
        const labor = cycle?.labors?.find((l) => l.id === wd.laborId);
        const sub = cycle ? subfaenaById.get(cycle.subfaenaId) : null;
        const faena = sub ? faenaById.get(sub.faenaId) : null;
        map.set(key, {
          key,
          cycleLabel: cycle?.label || wd.cycleId,
          laborName: labor?.name || wd.laborId,
          laborType: labor?.type || "main",
          tratoType: labor?.tratoType ?? 0,
          subfaenaName: sub?.name || "",
          faenaName: faena?.name || "",
          workers: new Set(),
          containers: new Set(),
          kilos: 0,
          tratoQty: 0,
          jornadas: 0,
          overtimeHours: 0,
          amount: 0,
          workersMap: new Map(),
          qualityMap: new Map(),
        });
      }
      const e = map.get(key);
      e.workers.add(wd.workerRut);
      e.amount += Number(wd.amount) || 0;

      // Inicializar entrada de trabajador en el breakdown.
      if (!e.workersMap.has(wd.workerRut)) {
        e.workersMap.set(wd.workerRut, {
          rut: wd.workerRut,
          kilos: 0,
          tratoQty: 0,
          jornadas: 0,
          overtimeHours: 0,
          amount: 0,
          pisoAmount: 0,
        });
      }
      const wEntry = e.workersMap.get(wd.workerRut);
      const wdAmount = Number(wd.amount) || 0;
      wEntry.amount += wdAmount;

      if (wd.pisoOnly) {
        e.pisoAmount = (e.pisoAmount || 0) + wdAmount;
        e.pisoCount = (e.pisoCount || 0) + 1;
        wEntry.pisoAmount += wdAmount;
        continue;
      }
      const t = e.laborType;
      if (t === "cosecha") {
        const kg = Number(wd.qty) || 0;
        const qx = Number(wd.qualityX) || 0;
        const cy = Number(wd.containerY) || 0;
        e.kilos += kg;
        e.containers.add(cy);
        wEntry.kilos += kg;
        // Distribución por (calidad, envase): kilos + monto.
        const qk = `${qx}_${cy}`;
        if (!e.qualityMap.has(qk)) {
          e.qualityMap.set(qk, { qx, cy, kilos: 0, amount: 0 });
        }
        const q = e.qualityMap.get(qk);
        q.kilos += kg;
        q.amount += wdAmount;
      } else if (t === "trato") {
        const q = getTratoTierTotals(wd).qty;
        e.tratoQty += q;
        wEntry.tratoQty += q;
      } else if (t === "tratoHE") {
        const j = Number(wd.qty) || 0;
        const oh = Number(wd.overtimeHours) || 0;
        e.jornadas += j;
        e.overtimeHours += oh;
        wEntry.jornadas += j;
        wEntry.overtimeHours += oh;
      } else {
        e.jornadas += 1;
        wEntry.jornadas += 1;
      }
    }
    return [...map.values()]
      .map((e) => {
        const workersBreakdown = [...e.workersMap.values()]
          .map((w) => ({ ...w, name: workerById?.get?.(w.rut)?.name || w.rut }))
          .sort((a, b) => b.amount - a.amount);
        const qualityDist = [...e.qualityMap.values()].sort(
          (a, b) => b.kilos - a.kilos || b.amount - a.amount,
        );
        const { workersMap: _wm, qualityMap: _qm, ...rest } = e;
        return { ...rest, workerCount: e.workers.size, workersBreakdown, qualityDist };
      })
      .sort((a, b) => b.amount - a.amount);
  }, [filteredWorkdays, cycleById, subfaenaById, faenaById, workerById]);

  // Por transportista — el nombre viene del lookup de carriers, no del id.
  const byCarrier = useMemo(() => {
    const map = new Map();
    for (const t of filteredTrips) {
      const key = t.carrierId || "(sin id)";
      if (!map.has(key)) {
        const carrier = carrierById?.get?.(key);
        map.set(key, {
          carrierId: key,
          alias: carrier?.alias || carrier?.name || "(transportista eliminado)",
          name: carrier?.name || "",
          tripCount: 0,
          total: 0,
        });
      }
      const e = map.get(key);
      e.tripCount += 1;
      e.total += Number(t.amount) || 0;
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [filteredTrips, carrierById]);

  const subfaenaLabel = subfaenaId ? subfaenaById.get(subfaenaId)?.name : "Todas las subfaenas";

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-xl flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div>
            <h2 className={`text-lg font-semibold ${isWeekendDate(date) ? "text-[#dc2626]" : ""}`}>
              {humanDate(date)}
            </h2>
            <p className="text-xs text-[var(--color-muted)]">{subfaenaLabel}</p>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {/* Totales — mostramos solo las métricas que aplican al día. */}
          <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Trabajadores" value={fmtNumber(totals.workerCount)} />
            {totals.jornadas > 0 && <Stat label="Jornadas" value={fmtNumber(totals.jornadas)} />}
            {totals.kilos > 0 && <Stat label={totals.cosechaUnitLabel} value={fmtNumber(totals.kilos)} />}
            {totals.tratoQty > 0 && <Stat label={totals.tratoLabel} value={fmtNumber(totals.tratoQty)} />}
            {totals.overtimeHours > 0 && <Stat label="HE (horas)" value={fmtNumber(totals.overtimeHours)} />}
            {totals.pisoAmount > 0 && (
              <Stat label={`Pisos (${totals.pisoCount})`} value={fmtCurrency(totals.pisoAmount)} />
            )}
            <Stat label="Producción $" value={fmtCurrency(totals.amount)} />
          </section>

          {/* Por labor */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
              Por labor ({byLabor.length})
            </h3>
            {byLabor.length === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">Sin actividad registrada.</p>
            ) : (
              <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--color-surface-2)] text-left text-xs text-[var(--color-muted)]">
                    <tr>
                      <th className="px-2 py-1.5">Ciclo / Labor</th>
                      <th className="px-2 py-1.5 text-right">Personas</th>
                      <th className="px-2 py-1.5 text-right">Métrica</th>
                      <th className="px-2 py-1.5 text-right">Monto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byLabor.map((l) => {
                      const isOpen = expandedLabors.has(l.key);
                      const cosechaUnitForLabor = l.laborType === "cosecha"
                        ? cosechaUnit(catalogs, l.containers).toLowerCase()
                        : "";
                      const tratoUnitForLabor = l.laborType === "trato"
                        ? tratoTypeLabel(catalogs, l.tratoType ?? 0)
                        : "";
                      return (
                        <Fragment key={l.key}>
                          <tr
                            className="cursor-pointer border-t border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]"
                            onClick={() => toggleLabor(l.key)}
                          >
                            <td className="px-2 py-1.5">
                              <div className="flex items-center gap-1">
                                <span className="text-[10px] text-[var(--color-muted)]">{isOpen ? "▾" : "▸"}</span>
                                <div>
                                  <div className="text-sm font-medium">{l.laborName}</div>
                                  <div className="text-[10px] text-[var(--color-muted)]">
                                    {l.cycleLabel} · {LABOR_TYPE_LABEL[l.laborType] || l.laborType}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{l.workerCount}</td>
                            <td className="px-2 py-1.5 text-right text-xs tabular-nums">
                              {l.laborType === "tratoHE" ? (
                                <div className="flex flex-col items-end leading-tight">
                                  {l.jornadas > 0 && (
                                    <span>
                                      {fmtNumber(l.jornadas)}{" "}
                                      <span className="text-[var(--color-muted)]">jorn.</span>
                                    </span>
                                  )}
                                  {l.overtimeHours > 0 && (
                                    <span>
                                      {fmtNumber(l.overtimeHours)}{" "}
                                      <span className="text-[var(--color-muted)]">HE</span>
                                    </span>
                                  )}
                                </div>
                              ) : (
                                laborMetricLabel(l, catalogs)
                              )}
                            </td>
                            <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                              {fmtCurrency(l.amount)}
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="border-t border-[var(--color-border)] bg-[var(--color-surface-2)]/40">
                              <td colSpan={4} className="px-3 py-2">
                                {l.laborType === "cosecha" && l.qualityDist.length > 0 && (
                                  <div className="mb-2">
                                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
                                      Distribución por calidad / envase
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                      {l.qualityDist.map((q) => {
                                        const lblQ = qualityLabel(catalogs, q.qx);
                                        const lblC = containerLabel(catalogs, q.cy);
                                        const pct = l.kilos > 0 ? (q.kilos / l.kilos) * 100 : 0;
                                        return (
                                          <div
                                            key={`${q.qx}_${q.cy}`}
                                            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px]"
                                          >
                                            <div className="font-medium">{lblQ} / {lblC}</div>
                                            <div className="tabular-nums">
                                              {fmtNumber(q.kilos)} {lblC.toLowerCase()}
                                              <span className="ml-1 text-[var(--color-muted)]">
                                                ({pct.toFixed(0)}%)
                                              </span>
                                            </div>
                                            <div className="text-[10px] tabular-nums text-[var(--color-muted)]">
                                              {fmtCurrency(q.amount)}
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}
                                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
                                  Trabajadores ({l.workersBreakdown.length})
                                </div>
                                <table className="w-full text-xs">
                                  <thead className="text-left text-[var(--color-muted)]">
                                    <tr>
                                      <th className="px-1 py-1">Nombre</th>
                                      <th className="px-1 py-1 text-right">Producción</th>
                                      <th className="px-1 py-1 text-right">Monto</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {l.workersBreakdown.map((w) => {
                                      const prodParts = [];
                                      if (l.laborType === "cosecha" && w.kilos > 0) {
                                        prodParts.push(`${fmtNumber(w.kilos)} ${cosechaUnitForLabor}`);
                                      }
                                      if (l.laborType === "trato" && w.tratoQty > 0) {
                                        prodParts.push(`${fmtNumber(w.tratoQty)} ${tratoUnitForLabor}`);
                                      }
                                      if (w.jornadas > 0) {
                                        prodParts.push(`${fmtNumber(w.jornadas)} j`);
                                      }
                                      if (w.overtimeHours > 0) {
                                        prodParts.push(`${fmtNumber(w.overtimeHours)} HE`);
                                      }
                                      if (w.pisoAmount > 0) {
                                        prodParts.push(`🪙 ${fmtCurrency(w.pisoAmount)}`);
                                      }
                                      return (
                                        <tr key={w.rut} className="border-t border-[var(--color-border)]">
                                          <td className="px-1 py-1">
                                            <div>{w.name}</div>
                                            <div className="font-mono text-[10px] text-[var(--color-muted)]">{w.rut}</div>
                                          </td>
                                          <td className="px-1 py-1 text-right tabular-nums">
                                            {l.laborType === "tratoHE" ? (
                                              <div className="flex flex-col items-end leading-tight">
                                                {w.jornadas > 0 && (
                                                  <span>
                                                    {fmtNumber(w.jornadas)}{" "}
                                                    <span className="text-[var(--color-muted)]">jorn.</span>
                                                  </span>
                                                )}
                                                {w.overtimeHours > 0 && (
                                                  <span>
                                                    {fmtNumber(w.overtimeHours)}{" "}
                                                    <span className="text-[var(--color-muted)]">HE</span>
                                                  </span>
                                                )}
                                                {w.pisoAmount > 0 && (
                                                  <span>🪙 {fmtCurrency(w.pisoAmount)}</span>
                                                )}
                                                {w.jornadas === 0 && w.overtimeHours === 0 && w.pisoAmount === 0 && "—"}
                                              </div>
                                            ) : (
                                              prodParts.join(" · ") || "—"
                                            )}
                                          </td>
                                          <td className="px-1 py-1 text-right font-medium tabular-nums">
                                            {fmtCurrency(w.amount)}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Por transportista */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
              Transportes ({totals.tripsCount} · {fmtCurrency(totals.tripsTotal)})
            </h3>
            {byCarrier.length === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">Sin transportes.</p>
            ) : (
              <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--color-surface-2)] text-left text-xs text-[var(--color-muted)]">
                    <tr>
                      <th className="px-2 py-1.5">Transportista</th>
                      <th className="px-2 py-1.5 text-right">Vueltas</th>
                      <th className="px-2 py-1.5 text-right">Monto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byCarrier.map((c) => (
                      <tr key={c.carrierId} className="border-t border-[var(--color-border)]">
                        <td className="px-2 py-1.5">{c.alias}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{c.tripCount}</td>
                        <td className="px-2 py-1.5 text-right font-medium tabular-nums">
                          {fmtCurrency(c.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
      <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className="mt-0.5 text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}

// ============================================================================
// Modal: expansión del día (zoom de la celda con todas las subfaenas)
// ============================================================================
//
// Se abre al hacer click en la zona blanca de la celda — sirve para los días
// con muchas subfaenas que no entran en el cuadrado (más de 4). No agrega
// información nueva: solo muestra todas las subfaenas como botones grandes
// agrupadas por faena. Click en cualquiera → abre el drawer de detalle de
// esa subfaena (mismo flujo que clickear la barrita en la celda).
function DayExpandedModal({ date, subfaenasOfDay, subfaenaById, faenaById, onClose, onPickSubfaena }) {
  // Agrupar las subfaenas activas por faena.
  const groupedByFaena = useMemo(() => {
    const map = new Map();
    for (const s of subfaenasOfDay) {
      const sub = subfaenaById.get(s.subfaenaId);
      const faena = sub ? faenaById.get(sub.faenaId) : null;
      const faenaId = faena?.id || "(sin-faena)";
      if (!map.has(faenaId)) {
        map.set(faenaId, { faena, items: [] });
      }
      map.get(faenaId).items.push(s);
    }
    return [...map.values()].sort((a, b) =>
      (a.faena?.name || "").localeCompare(b.faena?.name || ""),
    );
  }, [subfaenasOfDay, subfaenaById, faenaById]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-baseline justify-between border-b border-[var(--color-border)] px-5 py-3">
          <div>
            <h2 className={`text-lg font-semibold ${isWeekendDate(date) ? "text-[#dc2626]" : ""}`}>
              {humanDate(date)}
            </h2>
            <p className="text-xs text-[var(--color-muted)]">
              {subfaenasOfDay.length} subfaena{subfaenasOfDay.length === 1 ? "" : "s"} activa{subfaenasOfDay.length === 1 ? "" : "s"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {groupedByFaena.length === 0 ? (
            <p className="rounded-md border border-dashed border-[var(--color-border)] py-6 text-center text-sm text-[var(--color-muted)]">
              Sin actividad registrada este día.
            </p>
          ) : (
            groupedByFaena.map((g) => (
              <section key={g.faena?.id || "(sin-faena)"}>
                <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
                  {g.faena?.name || "Sin faena"}
                </h3>
                <div className="space-y-1.5">
                  {g.items.map((s) => (
                    <button
                      key={s.subfaenaId}
                      type="button"
                      onClick={() => onPickSubfaena(s.subfaenaId)}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm font-medium text-white shadow-sm hover:opacity-90"
                      style={{ backgroundColor: s.color }}
                    >
                      <span className="truncate">{s.name}</span>
                      <span className="shrink-0 text-xs opacity-90">
                        {s.workerCount} {s.workerCount === 1 ? "trabajador" : "trabajadores"}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
