import { useEffect, useMemo, useState } from "react";
import { collection, query, where, getCountFromServer } from "firebase/firestore";
import { db } from "../firebase";
import { faenasService, cyclesService } from "../services";

// Módulo de consola admin. Sirve para inspeccionar la escala de los datos
// antes de tomar decisiones de costo (snapshots, paginación, etc.). Todas
// las consultas usan `getCountFromServer` que cuesta ~1 read por cada 1000
// docs contados — barato a propósito.
//
// Nada se ejecuta solo: cada botón dispara su query individual y mostramos
// el costo estimado al lado. Si alguna query devuelve mucho, el contador
// real puede ser >1.

const MAIN_COLLECTIONS = [
  { id: "workdays", label: "Workdays", note: "jornadas registradas (la tabla más grande)" },
  { id: "worker", label: "Trabajadores", note: "doc id = RUT" },
  { id: "cycles", label: "Ciclos", note: "abiertos y cerrados" },
  { id: "payrolls", label: "Nóminas", note: "" },
  { id: "payrollSnapshots", label: "Snapshots de nómina", note: "1:1 con payrolls" },
  { id: "advances", label: "Anticipos/Adelantos", note: "" },
  { id: "transports", label: "Vueltas de transporte", note: "" },
  { id: "transportPayments", label: "Resúmenes de transporte", note: "" },
  { id: "carriers", label: "Transportistas", note: "" },
  { id: "faenas", label: "Faenas", note: "" },
  { id: "subfaenas", label: "Subfaenas", note: "" },
  { id: "logs", label: "Logs de auditoría", note: "puede ser MUY grande" },
];

const monthRange = (y, m) => {
  // m: 1..12
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
};

const fmtNumber = (n) => new Intl.NumberFormat("es-CL").format(Number(n) || 0);

async function countCollection(collName) {
  const snap = await getCountFromServer(collection(db, collName));
  return snap.data().count;
}

async function countWorkdaysInRange(from, to) {
  const q = query(
    collection(db, "workdays"),
    where("date", ">=", from),
    where("date", "<=", to),
  );
  const snap = await getCountFromServer(q);
  return snap.data().count;
}

async function countWorkdaysByCycle(cycleId) {
  const q = query(collection(db, "workdays"), where("cycleId", "==", cycleId));
  const snap = await getCountFromServer(q);
  return snap.data().count;
}

export default function AdminConsole() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Consola admin</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Inspección de escala. Cada botón dispara una consulta de recuento
          (~1 lectura por 1000 docs). No se ejecuta nada hasta que lo dispares.
        </p>
      </div>

      <CollectionCountsSection />
      <WorkdaysByMonthSection />
      <WorkdaysByRangeSection />
      <WorkdaysByCycleSection />
    </div>
  );
}

// ============================================================
// Sección 1: counts de todas las colecciones principales
// ============================================================
function CollectionCountsSection() {
  const [results, setResults] = useState({}); // id → { count?, error?, busy? }
  const [runningAll, setRunningAll] = useState(false);

  const runOne = async (id) => {
    setResults((r) => ({ ...r, [id]: { busy: true } }));
    try {
      const count = await countCollection(id);
      setResults((r) => ({ ...r, [id]: { count } }));
    } catch (err) {
      setResults((r) => ({ ...r, [id]: { error: err.message || String(err) } }));
    }
  };

  const runAll = async () => {
    setRunningAll(true);
    try {
      for (const c of MAIN_COLLECTIONS) {
        await runOne(c.id);
      }
    } finally {
      setRunningAll(false);
    }
  };

  const totalRuns = Object.values(results).filter((r) => r.count != null).length;

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Counts por colección</h2>
          <p className="text-xs text-[var(--color-muted)]">
            ~1 lectura por colección (Firestore aggregation).
          </p>
        </div>
        <button
          type="button"
          onClick={runAll}
          disabled={runningAll}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
        >
          {runningAll ? "Ejecutando…" : `▶ Contar todas (~${MAIN_COLLECTIONS.length} reads)`}
        </button>
      </div>
      <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface-2)] text-left text-xs text-[var(--color-muted)]">
            <tr>
              <th className="px-3 py-2">Colección</th>
              <th className="px-3 py-2 text-right">Documentos</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {MAIN_COLLECTIONS.map((c) => {
              const r = results[c.id] || {};
              return (
                <tr key={c.id} className="border-t border-[var(--color-border)]">
                  <td className="px-3 py-2">
                    <div className="font-mono text-xs">{c.id}</div>
                    <div className="text-[10px] text-[var(--color-muted)]">
                      {c.label}
                      {c.note ? ` · ${c.note}` : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.busy ? (
                      <span className="text-[var(--color-muted)]">…</span>
                    ) : r.error ? (
                      <span className="text-[var(--color-danger)]">err</span>
                    ) : r.count != null ? (
                      <span className="font-semibold">{fmtNumber(r.count)}</span>
                    ) : (
                      <span className="text-[var(--color-muted)]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => runOne(c.id)}
                      disabled={r.busy}
                      className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[11px] hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
                    >
                      Contar
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {totalRuns > 0 && (
        <p className="mt-2 text-[11px] text-[var(--color-muted)]">
          {totalRuns} consulta{totalRuns === 1 ? "" : "s"} ejecutada{totalRuns === 1 ? "" : "s"}.
        </p>
      )}
    </section>
  );
}

// ============================================================
// Sección 2: workdays por mes del año seleccionado
// ============================================================
function WorkdaysByMonthSection() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [rows, setRows] = useState([]); // [{ month, start, end, count, busy, error }]
  const [running, setRunning] = useState(false);

  const months = useMemo(
    () => [
      "Ene", "Feb", "Mar", "Abr", "May", "Jun",
      "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
    ],
    [],
  );

  const reset = () => {
    setRows(
      Array.from({ length: 12 }, (_, i) => {
        const { start, end } = monthRange(year, i + 1);
        return { month: i + 1, start, end, count: null };
      }),
    );
  };

  useEffect(() => {
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  const runYear = async () => {
    setRunning(true);
    try {
      for (let i = 0; i < 12; i++) {
        const { start, end } = monthRange(year, i + 1);
        setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, busy: true } : r)));
        try {
          const count = await countWorkdaysInRange(start, end);
          setRows((prev) =>
            prev.map((r, idx) => (idx === i ? { ...r, count, busy: false } : r)),
          );
        } catch (err) {
          setRows((prev) =>
            prev.map((r, idx) =>
              idx === i ? { ...r, error: err.message || String(err), busy: false } : r,
            ),
          );
        }
      }
    } finally {
      setRunning(false);
    }
  };

  const total = rows.reduce((s, r) => s + (r.count || 0), 0);
  const totalRuns = rows.filter((r) => r.count != null).length;

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Workdays por mes</h2>
          <p className="text-xs text-[var(--color-muted)]">
            12 consultas, ~12 reads totales. Útil para ver estacionalidad.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-[var(--color-muted)]">Año</label>
          <input
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value) || currentYear)}
            className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-sm"
          />
          <button
            type="button"
            onClick={runYear}
            disabled={running}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {running ? "Ejecutando…" : "▶ Contar año (~12 reads)"}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {rows.map((r, i) => (
          <div
            key={r.month}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2"
          >
            <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
              {months[i]} {year}
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {r.busy ? "…" : r.error ? "err" : r.count != null ? fmtNumber(r.count) : "—"}
            </div>
          </div>
        ))}
      </div>
      {totalRuns > 0 && (
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          Total año:{" "}
          <span className="font-semibold tabular-nums text-[var(--color-text)]">
            {fmtNumber(total)}
          </span>{" "}
          workdays
        </p>
      )}
    </section>
  );
}

// ============================================================
// Sección 3: workdays por rango custom
// ============================================================
function WorkdaysByRangeSection() {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + "01";
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [count, setCount] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    if (!from || !to) {
      setError("Completá ambas fechas");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const c = await countWorkdaysInRange(from, to);
      setCount(c);
    } catch (err) {
      setError(err.message || String(err));
      setCount(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <h2 className="mb-2 text-sm font-semibold">Workdays por rango custom</h2>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-[var(--color-muted)]">Desde</label>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-sm"
        />
        <label className="text-xs text-[var(--color-muted)]">Hasta</label>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-sm"
        />
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
        >
          {busy ? "Ejecutando…" : "▶ Contar (~1 read)"}
        </button>
        {count != null && (
          <span className="ml-auto text-sm">
            <span className="text-[var(--color-muted)]">Resultado: </span>
            <span className="font-semibold tabular-nums">{fmtNumber(count)}</span>{" "}
            workdays
          </span>
        )}
      </div>
      {error && (
        <p className="mt-2 text-xs text-[var(--color-danger)]">{error}</p>
      )}
    </section>
  );
}

// ============================================================
// Sección 4: workdays por ciclo activo
// ============================================================
function WorkdaysByCycleSection() {
  const [cycles, setCycles] = useState([]);
  const [faenas, setFaenas] = useState([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [counts, setCounts] = useState({}); // cycleId → count | "err" | "..."
  const [includeClosed, setIncludeClosed] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [c, f] = await Promise.all([
          cyclesService.list({ cache: true, ttl: 60_000 }),
          faenasService.list({ cache: true, persist: true, ttl: 10 * 60 * 1000 }),
        ]);
        setCycles(c);
        setFaenas(f);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const visibleCycles = useMemo(() => {
    const list = includeClosed ? cycles : cycles.filter((c) => c.status !== "closed");
    const faenaName = (id) => faenas.find((f) => f.id === id)?.name || "—";
    return list
      .map((c) => ({ ...c, faenaName: faenaName(c.faenaId) }))
      .sort((a, b) =>
        String(a.faenaName).localeCompare(b.faenaName) ||
        String(a.label || "").localeCompare(b.label || ""),
      );
  }, [cycles, faenas, includeClosed]);

  const runAll = async () => {
    setRunning(true);
    try {
      for (const c of visibleCycles) {
        setCounts((prev) => ({ ...prev, [c.id]: "..." }));
        try {
          const n = await countWorkdaysByCycle(c.id);
          setCounts((prev) => ({ ...prev, [c.id]: n }));
        } catch {
          setCounts((prev) => ({ ...prev, [c.id]: "err" }));
        }
      }
    } finally {
      setRunning(false);
    }
  };

  const numericCounts = Object.values(counts).filter((v) => typeof v === "number");
  const total = numericCounts.reduce((s, n) => s + n, 0);

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Workdays por ciclo</h2>
          <p className="text-xs text-[var(--color-muted)]">
            1 lectura por ciclo. Útil para ver dónde está concentrada la data.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={includeClosed}
              onChange={(e) => setIncludeClosed(e.target.checked)}
            />
            incluir cerrados
          </label>
          <button
            type="button"
            onClick={runAll}
            disabled={running || loading || visibleCycles.length === 0}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {running
              ? "Ejecutando…"
              : `▶ Contar ${visibleCycles.length} ciclo${visibleCycles.length === 1 ? "" : "s"} (~${visibleCycles.length} reads)`}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-[var(--color-muted)]">Cargando ciclos…</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface-2)] text-left text-xs text-[var(--color-muted)]">
              <tr>
                <th className="px-3 py-2">Faena</th>
                <th className="px-3 py-2">Ciclo</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2 text-right">Workdays</th>
              </tr>
            </thead>
            <tbody>
              {visibleCycles.map((c) => {
                const v = counts[c.id];
                return (
                  <tr key={c.id} className="border-t border-[var(--color-border)]">
                    <td className="px-3 py-1.5 text-xs text-[var(--color-muted)]">{c.faenaName}</td>
                    <td className="px-3 py-1.5">{c.label}</td>
                    <td className="px-3 py-1.5 text-xs">
                      {c.status === "closed" ? (
                        <span className="text-[var(--color-muted)]">cerrado</span>
                      ) : (
                        <span className="text-[var(--color-accent)]">abierto</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {v === "..." ? (
                        <span className="text-[var(--color-muted)]">…</span>
                      ) : v === "err" ? (
                        <span className="text-[var(--color-danger)]">err</span>
                      ) : typeof v === "number" ? (
                        <span className="font-semibold">{fmtNumber(v)}</span>
                      ) : (
                        <span className="text-[var(--color-muted)]">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {numericCounts.length > 0 && (
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          Suma de los {numericCounts.length} ciclo
          {numericCounts.length === 1 ? "" : "s"} contados:{" "}
          <span className="font-semibold tabular-nums text-[var(--color-text)]">
            {fmtNumber(total)}
          </span>{" "}
          workdays
        </p>
      )}
    </section>
  );
}
