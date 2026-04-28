import { useEffect, useState } from "react";
import { faenasService, subfaenasService } from "../services";
import Modal from "../components/Modal";
import ConfirmDialog from "../components/ConfirmDialog";
import TextField from "../components/TextField";

const emptyFaena = { name: "", location: "", notes: "" };
const emptySub = { name: "", notes: "" };

export default function Faenas() {
  const [faenas, setFaenas] = useState([]);
  const [subsByFaena, setSubsByFaena] = useState({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});

  const [faenaForm, setFaenaForm] = useState(null); // {mode, data}
  const [subForm, setSubForm] = useState(null); // {mode, faenaId, data}
  const [confirm, setConfirm] = useState(null); // {kind, item, message, busy}
  const [busy, setBusy] = useState(false);

  const loadFaenas = async () => {
    setLoading(true);
    try {
      const list = await faenasService.list({ order: ["name", "asc"] });
      setFaenas(list);
    } finally {
      setLoading(false);
    }
  };

  const loadSubs = async (faenaId) => {
    const list = await subfaenasService.list({ wheres: [["faenaId", "==", faenaId]], order: ["name", "asc"] });
    setSubsByFaena((prev) => ({ ...prev, [faenaId]: list }));
  };

  useEffect(() => {
    loadFaenas();
  }, []);

  const toggleExpand = async (id) => {
    const next = !expanded[id];
    setExpanded((prev) => ({ ...prev, [id]: next }));
    if (next && !subsByFaena[id]) await loadSubs(id);
  };

  const submitFaena = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (faenaForm.mode === "create") await faenasService.create(faenaForm.data);
      else await faenasService.update(faenaForm.data.id, {
        name: faenaForm.data.name,
        location: faenaForm.data.location || "",
        notes: faenaForm.data.notes || "",
      });
      setFaenaForm(null);
      await loadFaenas();
    } finally {
      setBusy(false);
    }
  };

  const submitSub = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { mode, faenaId, data } = subForm;
      if (mode === "create") await subfaenasService.create({ ...data, faenaId });
      else await subfaenasService.update(data.id, { name: data.name, notes: data.notes || "" });
      setSubForm(null);
      await loadSubs(faenaId);
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!confirm) return;
    setConfirm((c) => ({ ...c, busy: true }));
    try {
      if (confirm.kind === "faena") {
        const subs = await subfaenasService.list({ wheres: [["faenaId", "==", confirm.item.id]], take: 1 });
        if (subs.length) {
          alert("No se puede eliminar: la faena tiene subfaenas asociadas.");
          setConfirm(null);
          return;
        }
        await faenasService.remove(confirm.item.id);
        await loadFaenas();
      } else {
        await subfaenasService.remove(confirm.item.id);
        await loadSubs(confirm.item.faenaId);
      }
      setConfirm(null);
    } finally {
      setConfirm((c) => (c ? { ...c, busy: false } : null));
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Faenas</h1>
          <p className="text-sm text-[var(--color-muted)]">Faenas y subfaenas del sistema.</p>
        </div>
        <button
          onClick={() => setFaenaForm({ mode: "create", data: { ...emptyFaena } })}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)]"
        >
          + Nueva faena
        </button>
      </div>

      {loading ? (
        <div className="text-[var(--color-muted)]">Cargando...</div>
      ) : faenas.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-8 text-center text-[var(--color-muted)]">
          No hay faenas. Crea la primera.
        </div>
      ) : (
        <div className="space-y-3">
          {faenas.map((f) => {
            const isOpen = !!expanded[f.id];
            const subs = subsByFaena[f.id];
            return (
              <div key={f.id} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <button onClick={() => toggleExpand(f.id)} className="flex flex-1 items-center gap-3 text-left">
                    <span className="text-[var(--color-muted)]">{isOpen ? "▼" : "▶"}</span>
                    <div>
                      <div className="font-medium">{f.name}</div>
                      {f.location && <div className="text-xs text-[var(--color-muted)]">{f.location}</div>}
                    </div>
                  </button>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setFaenaForm({ mode: "edit", data: { ...f } })}
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs hover:bg-[var(--color-accent-soft)]"
                    >
                      Editar
                    </button>
                    <button
                      onClick={() => setConfirm({ kind: "faena", item: f, message: `¿Eliminar la faena "${f.name}"?` })}
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs text-[var(--color-danger)] hover:bg-red-500/10"
                    >
                      Eliminar
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
                    <div className="mb-3 flex items-center justify-between">
                      <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">Subfaenas</div>
                      <button
                        onClick={() => setSubForm({ mode: "create", faenaId: f.id, data: { ...emptySub } })}
                        className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-white hover:bg-[var(--color-accent-hover)]"
                      >
                        + Subfaena
                      </button>
                    </div>
                    {!subs ? (
                      <div className="text-sm text-[var(--color-muted)]">Cargando...</div>
                    ) : subs.length === 0 ? (
                      <div className="text-sm text-[var(--color-muted)]">Sin subfaenas.</div>
                    ) : (
                      <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
                        {subs.map((s) => (
                          <li key={s.id} className="flex items-center justify-between px-3 py-2">
                            <div>
                              <div className="text-sm font-medium">{s.name}</div>
                              {s.notes && <div className="text-xs text-[var(--color-muted)]">{s.notes}</div>}
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={() => setSubForm({ mode: "edit", faenaId: f.id, data: { ...s } })}
                                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                              >
                                Editar
                              </button>
                              <button
                                onClick={() => setConfirm({ kind: "sub", item: s, message: `¿Eliminar la subfaena "${s.name}"?` })}
                                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-[var(--color-danger)] hover:bg-red-500/10"
                              >
                                Eliminar
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Faena modal */}
      <Modal
        open={!!faenaForm}
        onClose={() => !busy && setFaenaForm(null)}
        title={faenaForm?.mode === "edit" ? "Editar faena" : "Nueva faena"}
      >
        {faenaForm && (
          <form id="faena-form" onSubmit={submitFaena} className="space-y-4">
            <TextField
              label="Nombre"
              required
              autoFocus
              value={faenaForm.data.name}
              onChange={(v) => setFaenaForm((f) => ({ ...f, data: { ...f.data, name: v } }))}
            />
            <TextField
              label="Ubicación"
              value={faenaForm.data.location}
              onChange={(v) => setFaenaForm((f) => ({ ...f, data: { ...f.data, location: v } }))}
            />
            <TextField
              label="Notas"
              value={faenaForm.data.notes}
              onChange={(v) => setFaenaForm((f) => ({ ...f, data: { ...f.data, notes: v } }))}
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setFaenaForm(null)}
                disabled={busy}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              >
                {busy ? "..." : "Guardar"}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* Subfaena modal */}
      <Modal
        open={!!subForm}
        onClose={() => !busy && setSubForm(null)}
        title={subForm?.mode === "edit" ? "Editar subfaena" : "Nueva subfaena"}
      >
        {subForm && (
          <form onSubmit={submitSub} className="space-y-4">
            <TextField
              label="Nombre"
              required
              autoFocus
              value={subForm.data.name}
              onChange={(v) => setSubForm((s) => ({ ...s, data: { ...s.data, name: v } }))}
            />
            <TextField
              label="Notas"
              value={subForm.data.notes}
              onChange={(v) => setSubForm((s) => ({ ...s, data: { ...s.data, notes: v } }))}
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setSubForm(null)}
                disabled={busy}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              >
                {busy ? "..." : "Guardar"}
              </button>
            </div>
          </form>
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirm}
        title="Eliminar"
        confirmLabel="Eliminar"
        danger
        message={confirm?.message}
        busy={confirm?.busy}
        onCancel={() => !confirm?.busy && setConfirm(null)}
        onConfirm={doDelete}
      />
    </div>
  );
}
