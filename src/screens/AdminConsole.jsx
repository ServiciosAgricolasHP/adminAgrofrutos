import { useEffect, useMemo, useState } from "react";
import { collection, query, where, getCountFromServer, doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";
import { faenasService, cyclesService, workersService } from "../services";
import { toProperName } from "../utils/nameUtils";
import { useAuth } from "../contexts/AuthContext";

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

      <AuthDebugSection />
      <CollectionCountsSection />
      <WorkdaysByMonthSection />
      <WorkdaysByRangeSection />
      <WorkdaysByCycleSection />
      <NormalizeWorkerNamesSection />
    </div>
  );
}

// ============================================================
// Sección Debug: por qué no soy admin
// ============================================================
// Muestra qué le llega al AuthContext (uid, email, role calculado) y qué
// contiene realmente el doc `users/{uid}` en Firestore. Sirve para diagnosticar
// por qué `isAdmin === false` cuando el usuario cree que debería ser true.
//
// Casos típicos:
//   1. El doc `users/{uid}` NO existe → AuthContext cae a role: "supervisor".
//      Fix: crear el doc en Firestore Console con { role: "admin" }.
//   2. El doc existe pero `role !== "admin"` (ej: "ADMIN" en mayúsculas,
//      "administrador", o el campo se llama `rol` en vez de `role`).
//   3. La security rule bloquea el read → error visible acá, y el AuthContext
//      cae al catch → role: "supervisor". Fix: rule tipo
//      `match /users/{uid} { allow read: if request.auth.uid == uid; }`.
function AuthDebugSection() {
  const { user, isAdmin } = useAuth();
  const [docState, setDocState] = useState({ loading: true });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!user?.uid) return;
    (async () => {
      setDocState({ loading: true });
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (!snap.exists()) {
          setDocState({ loading: false, exists: false });
        } else {
          setDocState({ loading: false, exists: true, data: snap.data() });
        }
      } catch (err) {
        setDocState({ loading: false, error: err.message || String(err), code: err.code });
      }
    })();
  }, [user?.uid]);

  const copyUid = async () => {
    if (!user?.uid) return;
    try {
      await navigator.clipboard.writeText(user.uid);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  };

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <h2 className="mb-2 text-sm font-semibold">🕵️ Debug de rol admin</h2>
      <p className="mb-3 text-xs text-[var(--color-muted)]">
        El AuthContext lee <code>users/{"{uid}"}</code> y toma el campo <code>role</code>.
        Si dice <code>"admin"</code> exactamente, activa el flag.
      </p>

      <div className="space-y-3 text-sm">
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
            Sesión actual
          </div>
          <div className="grid gap-1 text-xs sm:grid-cols-[80px_1fr]">
            <div className="text-[var(--color-muted)]">Email:</div>
            <div className="font-mono">{user?.email || "(sin sesión)"}</div>
            <div className="text-[var(--color-muted)]">UID:</div>
            <div className="flex items-center gap-2">
              <code className="break-all font-mono text-xs">{user?.uid || "—"}</code>
              {user?.uid && (
                <button
                  type="button"
                  onClick={copyUid}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-accent-soft)]"
                >
                  {copied ? "✓ Copiado" : "📋 Copiar"}
                </button>
              )}
            </div>
            <div className="text-[var(--color-muted)]">Role visto por AuthContext:</div>
            <div>
              <code className="font-mono">{user?.role || "(ninguno)"}</code>
            </div>
            <div className="text-[var(--color-muted)]">isAdmin:</div>
            <div>
              <span className={isAdmin ? "font-semibold text-[var(--color-success)]" : "font-semibold text-[var(--color-danger)]"}>
                {isAdmin ? "✓ TRUE" : "✗ FALSE"}
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
            Firestore <code>users/{user?.uid || "—"}</code>
          </div>
          {docState.loading ? (
            <div className="text-xs text-[var(--color-muted)]">Consultando…</div>
          ) : docState.error ? (
            <>
              <div className="text-xs text-[var(--color-danger)]">
                ✖ Error al leer: <code>{docState.code || "?"}</code>
              </div>
              <div className="mt-1 text-[10px] text-[var(--color-muted)]">
                {docState.error}
              </div>
              <div className="mt-2 rounded bg-[var(--color-surface)] p-2 text-[10px]">
                <strong>Probable causa:</strong> las security rules de Firestore
                bloquean el read. Necesitás una rule tipo:
                <pre className="mt-1 overflow-auto text-[10px]">{`match /users/{uid} {
  allow read: if request.auth.uid == uid;
}`}</pre>
              </div>
            </>
          ) : !docState.exists ? (
            <>
              <div className="text-xs text-[var(--color-danger)]">
                ✖ El doc <code>users/{user?.uid}</code> NO existe.
              </div>
              <div className="mt-2 rounded bg-[var(--color-surface)] p-2 text-[10px]">
                <strong>Fix</strong>: en Firestore Console, crear el doc con id{" "}
                <code>{user?.uid}</code> en la colección <code>users</code> y
                agregar el campo <code>role</code> (string) con valor{" "}
                <code>"admin"</code> exactamente en minúscula. Después
                relogueate en la app.
              </div>
            </>
          ) : (
            <>
              <div className="text-xs text-[var(--color-success)]">
                ✓ Existe. Contenido:
              </div>
              <pre className="mt-1 overflow-auto rounded bg-[var(--color-surface)] p-2 text-[10px]">
                {JSON.stringify(docState.data, null, 2)}
              </pre>
              {docState.data?.role !== "admin" && (
                <div className="mt-2 rounded bg-[var(--color-surface)] p-2 text-[10px] text-[var(--color-danger)]">
                  El campo <code>role</code> es <code>{JSON.stringify(docState.data?.role)}</code>,
                  no <code>"admin"</code>. Corregí a exactamente{" "}
                  <code>"admin"</code> en minúsculas y relogueate.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
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

// ============================================================
// Sección 5: normalizar nombres de trabajadores a Proper Case
// ============================================================
// Aplica `toProperName` a todos los `worker.name` que difieran del formato
// esperado ("Juan Pérez", "Juan de la Cruz"). Flujo en 2 pasos: primero un
// preview que lista los cambios propuestos (leer no escribe), y después el
// botón de aplicar corre updates uno-a-uno con progreso.
//
// El costo es 1 read por worker (list completo — no cacheado) + 1 write por
// nombre cambiado. Los que ya están bien no se tocan.
function NormalizeWorkerNamesSection() {
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [diffs, setDiffs] = useState([]); // [{ id, oldName, newName }]
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState(null); // { updated, errors }
  const [showAll, setShowAll] = useState(false);

  const preview = async () => {
    setLoading(true);
    setResult(null);
    setDiffs([]);
    setShowAll(false);
    try {
      // No caché — queremos datos frescos antes de escribir.
      const list = await workersService.list();
      setScanned(list.length);
      const changes = [];
      for (const w of list) {
        const oldName = String(w.name || "");
        const newName = toProperName(oldName);
        if (newName && newName !== oldName) {
          changes.push({ id: w.id, oldName, newName });
        }
      }
      // Orden alfabético por nombre nuevo para revisar cómodo.
      changes.sort((a, b) => a.newName.localeCompare(b.newName));
      setDiffs(changes);
    } catch (err) {
      alert("Error al leer trabajadores: " + (err.message || String(err)));
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    if (diffs.length === 0) return;
    if (!confirm(
      `¿Aplicar ${diffs.length} cambio(s) de nombre?\n\n` +
      `Esta operación no se puede deshacer automáticamente. ` +
      `Revisá el preview antes de continuar.`,
    )) return;
    setRunning(true);
    setProgress({ done: 0, total: diffs.length });
    let updated = 0;
    const errors = [];
    for (let i = 0; i < diffs.length; i++) {
      const d = diffs[i];
      try {
        await workersService.update(d.id, { name: d.newName });
        updated++;
      } catch (err) {
        errors.push({ id: d.id, oldName: d.oldName, error: err.message || String(err) });
      }
      setProgress({ done: i + 1, total: diffs.length });
    }
    setResult({ updated, errors });
    setDiffs([]); // limpia el preview — para re-verificar, pedir preview de nuevo
    setRunning(false);
  };

  const displayDiffs = showAll ? diffs : diffs.slice(0, 20);

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Normalizar nombres de trabajadores</h2>
          <p className="text-xs text-[var(--color-muted)]">
            Convierte los <code>name</code> al formato "Juan Pérez" (primera letra
            mayúscula, resto minúscula, conectores en minúscula).
            Preview primero, después aplicar.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={preview}
            disabled={loading || running}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
          >
            {loading ? "Analizando…" : "🔎 Preview cambios"}
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={running || diffs.length === 0}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {running
              ? `Aplicando… ${progress.done}/${progress.total}`
              : `✔ Aplicar ${diffs.length || ""} cambio${diffs.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>

      {scanned > 0 && !loading && (
        <p className="mb-3 text-xs text-[var(--color-muted)]">
          Escaneados: <span className="font-semibold tabular-nums text-[var(--color-text)]">{fmtNumber(scanned)}</span>{" "}
          trabajadores · A cambiar:{" "}
          <span className={`font-semibold tabular-nums ${diffs.length > 0 ? "text-[var(--color-accent)]" : "text-[var(--color-muted)]"}`}>
            {fmtNumber(diffs.length)}
          </span>
        </p>
      )}

      {diffs.length > 0 && (
        <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
          <table className="w-full text-xs">
            <thead className="bg-[var(--color-surface-2)] text-left text-[var(--color-muted)]">
              <tr>
                <th className="px-3 py-1.5">RUT</th>
                <th className="px-3 py-1.5">Antes</th>
                <th className="px-3 py-1.5">Después</th>
              </tr>
            </thead>
            <tbody>
              {displayDiffs.map((d) => (
                <tr key={d.id} className="border-t border-[var(--color-border)]">
                  <td className="px-3 py-1 font-mono text-[10px] text-[var(--color-muted)]">{d.id}</td>
                  <td className="px-3 py-1 text-[var(--color-muted)] line-through">{d.oldName}</td>
                  <td className="px-3 py-1 font-medium">{d.newName}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {diffs.length > 20 && !showAll && (
            <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-center">
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="text-xs text-[var(--color-accent)] hover:underline"
              >
                Ver los {diffs.length - 20} restantes…
              </button>
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-sm">
          <div>
            ✔ Actualizados:{" "}
            <span className="font-semibold tabular-nums text-[var(--color-success)]">
              {result.updated}
            </span>
          </div>
          {result.errors.length > 0 && (
            <>
              <div className="mt-1 text-[var(--color-danger)]">
                ✖ Errores: {result.errors.length}
              </div>
              <ul className="mt-1 max-h-40 overflow-y-auto text-xs text-[var(--color-muted)]">
                {result.errors.slice(0, 20).map((e, i) => (
                  <li key={i}>
                    <span className="font-mono">{e.id}</span> ({e.oldName}): {e.error}
                  </li>
                ))}
                {result.errors.length > 20 && <li>… y {result.errors.length - 20} más</li>}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
