// TEMPORARY admin/cleanup screen.
// Shows workdays marked as paid for a given cycle and lets you "release"
// them (clear payrollId + paidAt + paidBy). Useful when a payroll was
// deleted manually and its workdays still point at the dead doc.
//
// Delete this file + its route in App.jsx once the cleanup is done.
import { useEffect, useMemo, useState } from "react";
import { doc, writeBatch, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";
import { workdaysService, cyclesService, workersService } from "../services";

const fmtCurrency = (v) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 }).format(
    Number(v) || 0,
  );

const fmtTimestamp = (ts) => {
  if (!ts) return "—";
  if (ts.toDate) return ts.toDate().toLocaleString("es-CL");
  if (typeof ts === "string") return ts;
  return String(ts);
};

export default function CleanupPaidWorkdays() {
  const [cycleId, setCycleId] = useState("9HFfcheRD29nR72NT5mG");
  const [payrollFilter, setPayrollFilter] = useState("");
  const [rows, setRows] = useState([]);
  const [labors, setLabors] = useState({}); // laborId → { name, type }
  const [workersByRut, setWorkersByRut] = useState({});
  const [selected, setSelected] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = async () => {
    if (!cycleId.trim()) return;
    setLoading(true);
    setMessage("");
    setSelected(new Set());
    try {
      const [cycle, wds] = await Promise.all([
        cyclesService.getById(cycleId.trim()),
        workdaysService.list({ wheres: [["cycleId", "==", cycleId.trim()]] }),
      ]);
      const laborMap = {};
      for (const l of cycle?.labors || []) laborMap[l.id] = { name: l.name, type: l.type };
      setLabors(laborMap);

      const paid = wds.filter((w) => w.paidAt || w.payrollId);
      paid.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      setRows(paid);

      // Load worker names for display (chunked by 30 — Firestore "in" limit).
      const ruts = [...new Set(paid.map((w) => w.workerRut).filter(Boolean))];
      const map = {};
      for (let i = 0; i < ruts.length; i += 30) {
        const chunk = ruts.slice(i, i + 30);
        if (chunk.length === 0) continue;
        const list = await workersService.list({
          wheres: [["__name__", "in", chunk]],
        });
        for (const w of list) map[w.id] = w;
      }
      setWorkersByRut(map);
    } catch (err) {
      setMessage(`Error: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Auto-load on first render if cycleId is prefilled.
    if (cycleId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    if (!payrollFilter.trim()) return rows;
    return rows.filter((r) => (r.payrollId || "") === payrollFilter.trim());
  }, [rows, payrollFilter]);

  const uniquePayrollIds = useMemo(() => {
    const set = new Set();
    for (const r of rows) if (r.payrollId) set.add(r.payrollId);
    return [...set];
  }, [rows]);

  const totalAmount = filtered.reduce((s, r) => s + (Number(r.amount) || 0), 0);

  const toggleOne = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    if (filtered.every((r) => selected.has(r.id))) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const r of filtered) next.delete(r.id);
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const r of filtered) next.add(r.id);
        return next;
      });
    }
  };

  const releaseSelected = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Liberar (poner payrollId/paidAt en null) ${selected.size} workday(s)? No se puede deshacer fácilmente.`)) return;
    setBusy(true);
    setMessage("");
    try {
      const ids = [...selected];
      const chunkSize = 450;
      for (let i = 0; i < ids.length; i += chunkSize) {
        const batch = writeBatch(db);
        for (const id of ids.slice(i, i + chunkSize)) {
          batch.update(doc(db, "workdays", id), {
            payrollId: null,
            paidAt: null,
            paidBy: null,
            updatedAt: serverTimestamp(),
          });
        }
        await batch.commit();
      }
      workdaysService.invalidate();
      setMessage(`✓ Liberados ${ids.length} workday(s).`);
      await load();
    } catch (err) {
      setMessage(`Error al liberar: ${err.message || err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">⚠️ Limpiar workdays pagados</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Vista temporal. Lista los workdays con <code>paidAt</code> o <code>payrollId</code> seteados para un ciclo,
          y permite liberarlos (set a null). Útil cuando se borró una nómina manualmente y quedaron huérfanos.
        </p>
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">cycleId</label>
          <input
            value={cycleId}
            onChange={(e) => setCycleId(e.target.value)}
            className="w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-xs"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">filtrar por payrollId (opcional)</label>
          <select
            value={payrollFilter}
            onChange={(e) => setPayrollFilter(e.target.value)}
            className="w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-xs"
          >
            <option value="">Todos ({rows.length})</option>
            {uniquePayrollIds.map((pid) => (
              <option key={pid} value={pid}>{pid}</option>
            ))}
          </select>
        </div>
        <button
          onClick={load}
          disabled={loading || !cycleId.trim()}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
        >
          {loading ? "Cargando..." : "🔄 Recargar"}
        </button>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <span><span className="text-[var(--color-muted)]">Visibles:</span> <b>{filtered.length}</b></span>
          <span><span className="text-[var(--color-muted)]">Seleccionados:</span> <b>{selected.size}</b></span>
          <span><span className="text-[var(--color-muted)]">Total $:</span> <b>{fmtCurrency(totalAmount)}</b></span>
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          onClick={releaseSelected}
          disabled={busy || selected.size === 0}
          className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-1.5 text-sm font-medium text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white disabled:opacity-50"
        >
          {busy ? "Procesando..." : `🔓 Liberar ${selected.size} seleccionado(s)`}
        </button>
        <button
          onClick={() => setSelected(new Set(filtered.map((r) => r.id)))}
          disabled={filtered.length === 0}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
        >
          Marcar todos visibles
        </button>
        <button
          onClick={() => setSelected(new Set())}
          disabled={selected.size === 0}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
        >
          Desmarcar todos
        </button>
        {message && (
          <span className="ml-auto text-sm">
            {message}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        {loading ? (
          <div className="flex h-40 items-center justify-center text-[var(--color-muted)]">Cargando...</div>
        ) : filtered.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-[var(--color-muted)]">
            {rows.length === 0 ? "Sin workdays pagados en este ciclo." : "Sin coincidencias con el filtro."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--color-surface-2)] text-left text-xs">
              <tr>
                <th className="px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={filtered.length > 0 && filtered.every((r) => selected.has(r.id))}
                    onChange={toggleAllVisible}
                  />
                </th>
                <th className="px-2 py-1.5">Fecha</th>
                <th className="px-2 py-1.5">Trabajador</th>
                <th className="px-2 py-1.5">RUT</th>
                <th className="px-2 py-1.5">Labor</th>
                <th className="px-2 py-1.5 text-right">Cant.</th>
                <th className="px-2 py-1.5 text-right">$</th>
                <th className="px-2 py-1.5">payrollId</th>
                <th className="px-2 py-1.5">paidAt</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const w = workersByRut[r.workerRut];
                const labor = labors[r.laborId];
                return (
                  <tr key={r.id} className="border-t border-[var(--color-border)]">
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggleOne(r.id)}
                      />
                    </td>
                    <td className="px-2 py-1 font-mono text-xs">{r.date}</td>
                    <td className="px-2 py-1">{w?.name || "—"}</td>
                    <td className="px-2 py-1 font-mono text-xs">{r.workerRut}</td>
                    <td className="px-2 py-1 text-xs">
                      {labor?.name || r.laborId}
                      {labor?.type && <span className="text-[var(--color-muted)]"> · {labor.type}</span>}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">{Number(r.qty) || 0}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmtCurrency(r.amount)}</td>
                    <td className="px-2 py-1 font-mono text-[10px]">{r.payrollId || "—"}</td>
                    <td className="px-2 py-1 text-[10px]">{fmtTimestamp(r.paidAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
