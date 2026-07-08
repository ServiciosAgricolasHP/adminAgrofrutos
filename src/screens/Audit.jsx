import { useEffect, useMemo, useState } from "react";
import { logsService } from "../services";

// Auditoría con sesionizado idle-based. Fetcheamos los logs del rango elegido,
// los agrupamos por usuario y armamos "sesiones" cerrando cada vez que el gap
// entre acciones consecutivas del mismo usuario supera `gapMinutes`.
//
// Limitación aceptada: si el mismo usuario tiene 2 pestañas abiertas al mismo
// tiempo, se ven como una sola sesión. Para uso interno es aceptable.
//
// Costo: 1 read por log en el rango (Firestore no cobra por doc sino por
// query, pero un rango grande puede pasar 10k docs y salir caro). Por eso el
// range default es "últimos 7 días" y hay un hard cap de 5000 logs.

const HARD_CAP = 5000;

const todayISO = () => new Date().toISOString().slice(0, 10);
const daysAgoISO = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

// Firestore Timestamp → JS Date. Si viene `null` (log recién escrito antes de
// que el server settleee el `serverTimestamp`), asumimos ahora.
const toDate = (ts) => {
  if (!ts) return new Date();
  if (typeof ts.toDate === "function") return ts.toDate();
  if (ts.seconds != null) return new Date(ts.seconds * 1000);
  if (typeof ts === "string" || typeof ts === "number") return new Date(ts);
  return new Date();
};

const fmtDateTime = (d) =>
  new Intl.DateTimeFormat("es-CL", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(d);

const fmtTime = (d) =>
  new Intl.DateTimeFormat("es-CL", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(d);

const fmtDuration = (ms) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  return `${h}h ${mr}m`;
};

const fmtNumber = (n) => new Intl.NumberFormat("es-CL").format(Number(n) || 0);

const ACTION_STYLE = {
  create: { color: "#166534", bg: "#dcfce7", label: "crear" },
  update: { color: "#92400e", bg: "#fef3c7", label: "editar" },
  delete: { color: "#b91c1c", bg: "#fee2e2", label: "eliminar" },
};

function actionPill(action) {
  const s = ACTION_STYLE[action] || { color: "#374151", bg: "#f3f4f6", label: action || "?" };
  return (
    <span
      style={{ color: s.color, background: s.bg }}
      className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
    >
      {s.label}
    </span>
  );
}

// Convierte un rango JS Date en JS Date (inclusive) y arma la query. Devuelve
// los logs ordenados por timestamp asc (más viejo primero) — más cómodo para
// sesionizar.
async function fetchLogsInRange(fromDate, toDate) {
  const raw = await logsService.list({
    wheres: [
      ["timestamp", ">=", fromDate],
      ["timestamp", "<=", toDate],
    ],
    order: ["timestamp", "asc"],
    take: HARD_CAP,
  });
  return raw;
}

// Agrupa logs en sesiones. Input: logs ordenados por timestamp asc. Output:
// array de sesiones ordenadas por start desc (más reciente primero).
function sessionize(logs, gapMinutes) {
  const gapMs = gapMinutes * 60 * 1000;
  // Agrupamos primero por email (fallback uid, fallback "unknown"). Dentro
  // de cada grupo caminamos cronológicamente.
  const byUser = new Map();
  for (const log of logs) {
    const key = log.email || log.uid || "unknown";
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(log);
  }
  const sessions = [];
  for (const [userKey, userLogs] of byUser) {
    userLogs.sort((a, b) => toDate(a.timestamp) - toDate(b.timestamp));
    let current = null;
    for (const log of userLogs) {
      const t = toDate(log.timestamp);
      if (!current || t - current.endDate > gapMs) {
        // Cerrar la anterior, arrancar una nueva.
        if (current) sessions.push(current);
        current = {
          userKey,
          email: log.email || null,
          uid: log.uid || null,
          startDate: t,
          endDate: t,
          logs: [log],
        };
      } else {
        current.endDate = t;
        current.logs.push(log);
      }
    }
    if (current) sessions.push(current);
  }
  sessions.sort((a, b) => b.startDate - a.startDate);
  // Agregamos resumen por entidad
  return sessions.map((s, idx) => {
    const byEntity = new Map();
    const byAction = { create: 0, update: 0, delete: 0 };
    for (const l of s.logs) {
      const e = l.entity || "?";
      byEntity.set(e, (byEntity.get(e) || 0) + 1);
      if (byAction[l.action] != null) byAction[l.action]++;
    }
    return {
      ...s,
      id: `s_${idx}_${s.userKey}_${s.startDate.getTime()}`,
      durationMs: s.endDate - s.startDate,
      count: s.logs.length,
      byEntity: [...byEntity.entries()].sort((a, b) => b[1] - a[1]),
      byAction,
    };
  });
}

export default function Audit() {
  const [fromDate, setFromDate] = useState(daysAgoISO(7));
  const [toDate, setToDateStr] = useState(todayISO());
  const [gapMinutes, setGapMinutes] = useState(30);
  const [emailFilter, setEmailFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState([]);
  const [ranAt, setRanAt] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [expandAll, setExpandAll] = useState(false);

  const load = async () => {
    setError("");
    setLoading(true);
    try {
      const from = new Date(fromDate + "T00:00:00");
      const to = new Date(toDate + "T23:59:59");
      const raw = await fetchLogsInRange(from, to);
      setLogs(raw);
      setRanAt(new Date());
      setExpanded(new Set());
      setExpandAll(false);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const sessions = useMemo(() => {
    let filtered = logs;
    if (emailFilter.trim()) {
      const q = emailFilter.trim().toLowerCase();
      filtered = filtered.filter((l) => String(l.email || l.uid || "").toLowerCase().includes(q));
    }
    return sessionize(filtered, gapMinutes);
  }, [logs, gapMinutes, emailFilter]);

  const toggleSession = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const doExpandAll = () => {
    if (expandAll) {
      setExpanded(new Set());
      setExpandAll(false);
    } else {
      setExpanded(new Set(sessions.map((s) => s.id)));
      setExpandAll(true);
    }
  };

  const totalActions = sessions.reduce((s, x) => s + x.count, 0);
  const uniqueUsers = new Set(sessions.map((s) => s.userKey)).size;
  const capReached = logs.length >= HARD_CAP;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Auditoría</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Sesiones inferidas por gaps de inactividad. Cada sesión agrupa
          acciones consecutivas del mismo usuario separadas por menos del
          gap configurado.
        </p>
      </div>

      {/* Filtros */}
      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[var(--color-muted)]">Desde</span>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[var(--color-muted)]">Hasta</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDateStr(e.target.value)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[var(--color-muted)]">Gap sesión (min)</span>
            <input
              type="number"
              min={1}
              max={720}
              value={gapMinutes}
              onChange={(e) => setGapMinutes(Math.max(1, Number(e.target.value) || 30))}
              className="w-24 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm"
              title="Minutos de inactividad para cortar sesión. 30 típico."
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[var(--color-muted)]">Filtrar email</span>
            <input
              type="text"
              value={emailFilter}
              onChange={(e) => setEmailFilter(e.target.value)}
              placeholder="bruno..."
              className="w-48 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {loading ? "Cargando…" : "▶ Cargar"}
          </button>
          {sessions.length > 0 && (
            <button
              type="button"
              onClick={doExpandAll}
              className="ml-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
            >
              {expandAll ? "▸ Colapsar todo" : "▾ Expandir todo"}
            </button>
          )}
        </div>
        {ranAt && !loading && (
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            {fmtNumber(logs.length)} log{logs.length === 1 ? "" : "s"} leídos ·{" "}
            {fmtNumber(sessions.length)} sesión{sessions.length === 1 ? "" : "es"} ·{" "}
            {fmtNumber(totalActions)} acciones ·{" "}
            {uniqueUsers} usuario{uniqueUsers === 1 ? "" : "s"} distinto{uniqueUsers === 1 ? "" : "s"}
            {capReached && (
              <span className="ml-2 rounded bg-[var(--color-danger)]/10 px-1.5 py-0.5 text-[var(--color-danger)]">
                ⚠ tope de {HARD_CAP} logs alcanzado — reducí el rango
              </span>
            )}
          </p>
        )}
        {error && <p className="mt-2 text-xs text-[var(--color-danger)]">{error}</p>}
      </section>

      {/* Sesiones */}
      {loading ? (
        <div className="py-8 text-center text-sm text-[var(--color-muted)]">Cargando…</div>
      ) : ranAt && sessions.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] py-8 text-center text-sm text-[var(--color-muted)]">
          Sin actividad en el rango seleccionado.
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => {
            const isOpen = expanded.has(s.id);
            return (
              <div key={s.id} className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
                <button
                  type="button"
                  onClick={() => toggleSession(s.id)}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-[var(--color-surface-2)]"
                >
                  <span className="mt-0.5 text-[var(--color-muted)]">
                    {isOpen ? "▾" : "▸"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="font-medium">{s.email || s.uid || "(desconocido)"}</span>
                      <span className="text-xs text-[var(--color-muted)]">
                        {fmtDateTime(s.startDate)}
                        {s.count > 1 && ` → ${fmtTime(s.endDate)} (${fmtDuration(s.durationMs)})`}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 font-semibold">
                        {s.count} acc.
                      </span>
                      {s.byAction.create > 0 && (
                        <span className="rounded bg-[#dcfce7] px-1.5 py-0.5 text-[#166534]">
                          +{s.byAction.create}
                        </span>
                      )}
                      {s.byAction.update > 0 && (
                        <span className="rounded bg-[#fef3c7] px-1.5 py-0.5 text-[#92400e]">
                          ✎{s.byAction.update}
                        </span>
                      )}
                      {s.byAction.delete > 0 && (
                        <span className="rounded bg-[#fee2e2] px-1.5 py-0.5 text-[#b91c1c]">
                          −{s.byAction.delete}
                        </span>
                      )}
                      <span className="text-[var(--color-muted)]">·</span>
                      {s.byEntity.map(([e, n]) => (
                        <span key={e} className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[var(--color-muted)]">
                          {e} × {n}
                        </span>
                      ))}
                    </div>
                  </div>
                </button>
                {isOpen && (
                  <SessionDetail logs={s.logs} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Detalle de una sesión — tabla de acciones ordenadas cronológicamente. Al
// hacer click en un row se muestra el JSON completo del log (changes/before/
// after/meta) para debuggear qué pasó.
function SessionDetail({ logs }) {
  const [openIdx, setOpenIdx] = useState(null);
  const sorted = useMemo(
    () => [...logs].sort((a, b) => toDate(a.timestamp) - toDate(b.timestamp)),
    [logs],
  );
  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
      <div className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-xs">
          <thead className="bg-[var(--color-surface-2)] text-left text-[var(--color-muted)]">
            <tr>
              <th className="px-2 py-1.5 w-24">Hora</th>
              <th className="px-2 py-1.5 w-20">Acción</th>
              <th className="px-2 py-1.5">Entidad</th>
              <th className="px-2 py-1.5">ID</th>
              <th className="px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((l, idx) => {
              const isOpen = openIdx === idx;
              const hasDetails = l.changes || l.before || l.after || l.meta;
              return (
                <>
                  <tr
                    key={l.id || idx}
                    className="cursor-pointer border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"
                    onClick={() => hasDetails && setOpenIdx(isOpen ? null : idx)}
                  >
                    <td className="px-2 py-1 font-mono text-[10px] text-[var(--color-muted)]">
                      {fmtTime(toDate(l.timestamp))}
                    </td>
                    <td className="px-2 py-1">{actionPill(l.action)}</td>
                    <td className="px-2 py-1 font-medium">{l.entity || "—"}</td>
                    <td className="px-2 py-1 font-mono text-[10px] text-[var(--color-muted)]">
                      {l.entityId || "—"}
                    </td>
                    <td className="px-2 py-1 text-right text-[var(--color-muted)]">
                      {hasDetails ? (isOpen ? "▾" : "▸") : ""}
                    </td>
                  </tr>
                  {isOpen && hasDetails && (
                    <tr key={`d_${idx}`} className="border-t border-[var(--color-border)]">
                      <td colSpan={5} className="bg-[var(--color-surface-2)] px-3 py-2">
                        <div className="grid gap-2 md:grid-cols-2">
                          {l.changes && (
                            <DetailBlock title="Cambios" data={l.changes} />
                          )}
                          {l.before && (
                            <DetailBlock title="Antes" data={l.before} />
                          )}
                          {l.after && (
                            <DetailBlock title="Después" data={l.after} />
                          )}
                          {l.meta && (
                            <DetailBlock title="Meta" data={l.meta} />
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DetailBlock({ title, data }) {
  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        {title}
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-[10px]">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}
