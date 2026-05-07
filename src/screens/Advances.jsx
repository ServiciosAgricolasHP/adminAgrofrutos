import { useEffect, useMemo, useRef, useState } from "react";
import { advancesService, ADVANCE_TYPES } from "../services/advancesService";
import { searchWorkers } from "../services/workersService";
import { formatRutForDisplay } from "../utils/rutUtils";
import ConfirmDialog from "../components/ConfirmDialog";
import Modal from "../components/Modal";

const fmtCurrency = (v) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 }).format(
    Number(v) || 0,
  );

const todayStr = () => new Date().toISOString().slice(0, 10);

const STATUS_LABEL = {
  pending: "Pendiente",
  applied: "Aplicado",
  cancelled: "Cancelado",
};

const STATUS_CLASS = {
  pending: "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
  applied: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
  cancelled: "bg-[var(--color-surface-2)] text-[var(--color-muted)]",
};

export default function Advances() {
  const [tab, setTab] = useState("anticipo"); // anticipo | adelanto
  const [statusFilter, setStatusFilter] = useState("pending");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const list = await advancesService.list({ order: ["date", "desc"] });
      setItems(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((a) => {
      if (a.type !== tab) return false;
      if (statusFilter !== "all" && (a.status || "pending") !== statusFilter) return false;
      if (q) {
        const hay = `${a.workerName || ""} ${a.workerRut || ""} ${a.note || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, tab, statusFilter, search]);

  const totals = useMemo(() => {
    let pending = 0, applied = 0;
    for (const a of filtered) {
      if ((a.status || "pending") === "applied") applied += Number(a.amount) || 0;
      else if ((a.status || "pending") === "pending") pending += Number(a.amount) || 0;
    }
    return { pending, applied };
  }, [filtered]);

  const onSaved = async () => {
    setEditing(null);
    await load();
  };

  const onDelete = async () => {
    if (!confirmDelete) return;
    if (confirmDelete.status === "applied") {
      alert("No se puede eliminar un anticipo/adelanto ya aplicado a una nómina. Elimina la nómina primero.");
      setConfirmDelete(null);
      return;
    }
    await advancesService.remove(confirmDelete.id);
    setConfirmDelete(null);
    await load();
  };

  const tabLabel = (t) => ADVANCE_TYPES.find((x) => x.value === t);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Anticipos y Adelantos</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Se descuentan automáticamente al generar la próxima nómina
          </p>
        </div>
        <button
          onClick={() => setEditing({ type: tab, mode: "create" })}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] shadow-sm hover:bg-[var(--color-accent-hover)]"
        >
          + Nuevo {tabLabel(tab).label.toLowerCase()}
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1 text-sm">
          {ADVANCE_TYPES.map((t) => (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={`rounded px-3 py-1 ${
                tab === t.value ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "text-[var(--color-muted)]"
              }`}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre, RUT o nota..."
          className="w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-2 text-sm"
        >
          <option value="all">Todos</option>
          <option value="pending">Pendientes</option>
          <option value="applied">Aplicados</option>
          <option value="cancelled">Cancelados</option>
        </select>
        <div className="ml-auto flex gap-3 text-xs">
          <span><span className="text-[var(--color-muted)]">Pendientes:</span> <span className="font-semibold text-[var(--color-warning)]">{fmtCurrency(totals.pending)}</span></span>
          <span><span className="text-[var(--color-muted)]">Aplicados:</span> <span className="font-semibold text-[var(--color-success)]">{fmtCurrency(totals.applied)}</span></span>
        </div>
      </div>

      <div className="flex-1 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        {loading ? (
          <div className="flex h-40 items-center justify-center text-[var(--color-muted)]">Cargando...</div>
        ) : filtered.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-[var(--color-muted)]">
            Sin {tabLabel(tab).label.toLowerCase()}s.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--color-surface-2)] text-left">
              <tr>
                <th className="px-3 py-2">Fecha</th>
                <th className="px-3 py-2">Trabajador</th>
                <th className="px-3 py-2">RUT</th>
                <th className="px-3 py-2 text-right">Monto</th>
                <th className="px-3 py-2">Nota</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id} className="border-t border-[var(--color-border)]">
                  <td className="px-3 py-2 font-mono text-xs">{a.date}</td>
                  <td className="px-3 py-2">{a.workerName}</td>
                  <td className="px-3 py-2 font-mono text-xs">{formatRutForDisplay(a.workerRut)}</td>
                  <td className="px-3 py-2 text-right font-medium">{fmtCurrency(a.amount)}</td>
                  <td className="px-3 py-2 text-xs text-[var(--color-muted)]">{a.note || "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_CLASS[a.status || "pending"]}`}>
                      {STATUS_LABEL[a.status || "pending"]}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => setEditing({ ...a, mode: "edit" })}
                        disabled={a.status === "applied"}
                        title={a.status === "applied" ? "No editable: ya aplicado" : "Editar"}
                        className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-40"
                      >
                        Editar
                      </button>
                      <button
                        onClick={() => setConfirmDelete(a)}
                        disabled={a.status === "applied"}
                        title={a.status === "applied" ? "Elimina la nómina primero" : "Eliminar"}
                        className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] disabled:opacity-40"
                      >
                        Eliminar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <AdvanceFormModal
        open={!!editing}
        item={editing}
        onClose={() => setEditing(null)}
        onSaved={onSaved}
      />
      <ConfirmDialog
        open={!!confirmDelete}
        title="Eliminar"
        message={confirmDelete ? `¿Eliminar ${confirmDelete.type} de ${confirmDelete.workerName} por ${fmtCurrency(confirmDelete.amount)}?` : ""}
        confirmLabel="Eliminar"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={onDelete}
      />
    </div>
  );
}

function AdvanceFormModal({ open, item, onClose, onSaved }) {
  const isEdit = item?.mode === "edit";
  const [form, setForm] = useState({
    type: "anticipo",
    workerRut: "",
    workerName: "",
    amount: 0,
    date: todayStr(),
    note: "",
  });
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState({ q: "", results: [], open: false });
  const debRef = useRef(null);

  useEffect(() => {
    if (open) {
      setForm({
        type: item?.type || "anticipo",
        workerRut: item?.workerRut || "",
        workerName: item?.workerName || "",
        amount: item?.amount || 0,
        date: item?.date || todayStr(),
        note: item?.note || "",
      });
      setPicker({ q: "", results: [], open: false });
    }
  }, [open, item]);

  useEffect(() => {
    if (debRef.current) clearTimeout(debRef.current);
    if (!picker.open || picker.q.trim().length < 2) return;
    debRef.current = setTimeout(async () => {
      const r = await searchWorkers(picker.q.trim(), { take: 20 });
      setPicker((s) => ({ ...s, results: r }));
    }, 250);
    return () => clearTimeout(debRef.current);
  }, [picker.q, picker.open]);

  const submit = async () => {
    if (!form.workerRut) return alert("Selecciona un trabajador.");
    if (!form.amount || form.amount <= 0) return alert("Monto debe ser mayor a 0.");
    setBusy(true);
    try {
      const data = {
        type: form.type,
        workerRut: form.workerRut,
        workerName: form.workerName,
        amount: Math.round(Number(form.amount) || 0),
        date: form.date,
        note: form.note,
        status: item?.status || "pending",
      };
      if (isEdit) await advancesService.update(item.id, data);
      else await advancesService.create(data);
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${isEdit ? "Editar" : "Nuevo"} ${form.type === "anticipo" ? "anticipo" : "adelanto"}`}
      size="md"
      footer={
        <>
          <button onClick={onClose} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm">
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
          >
            {busy ? "Guardando..." : "Guardar"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">Tipo</label>
          <div className="flex gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1 text-sm">
            {ADVANCE_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setForm((f) => ({ ...f, type: t.value }))}
                className={`flex-1 rounded px-3 py-1 ${
                  form.type === t.value ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "text-[var(--color-muted)]"
                }`}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="relative">
          <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">Trabajador</label>
          {form.workerRut && !picker.open ? (
            <div className="flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm">
              <span>
                <span className="font-medium">{form.workerName}</span>
                <span className="ml-2 font-mono text-xs text-[var(--color-muted)]">{formatRutForDisplay(form.workerRut)}</span>
              </span>
              <button
                onClick={() => setPicker({ q: "", results: [], open: true })}
                className="text-xs text-[var(--color-accent)]"
              >
                Cambiar
              </button>
            </div>
          ) : (
            <>
              <input
                autoFocus
                value={picker.q}
                onChange={(e) => setPicker((s) => ({ ...s, q: e.target.value, open: true }))}
                placeholder="Buscar por RUT o nombre..."
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
              />
              {picker.open && picker.results.length > 0 && (
                <div className="absolute left-0 right-0 z-10 mt-1 max-h-60 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg">
                  {picker.results.map((w) => (
                    <button
                      key={w.id}
                      onClick={() =>
                        setForm((f) => ({ ...f, workerRut: w.id, workerName: w.name })) ||
                        setPicker({ q: "", results: [], open: false })
                      }
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-[var(--color-accent-soft)]"
                    >
                      <span>{w.name}</span>
                      <span className="font-mono text-xs text-[var(--color-muted)]">{formatRutForDisplay(w.id)}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">Monto</label>
            <input
              type="number"
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: Number(e.target.value) || 0 }))}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">Fecha</label>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">Nota (opcional)</label>
          <input
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            placeholder="Motivo, referencia..."
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          />
        </div>
      </div>
    </Modal>
  );
}
