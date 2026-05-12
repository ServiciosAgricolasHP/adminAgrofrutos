import { useEffect, useState } from "react";
import { interestLinksService } from "../services";
import Modal from "../components/Modal";
import TextField from "../components/TextField";
import ConfirmDialog from "../components/ConfirmDialog";

const SEED = { text: "De PDF a Word", url: "https://www.ilovepdf.com/es/pdf_a_word" };

function normalizeUrl(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

function safeHost(url) {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; }
}

export default function InterestLinks() {
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null); // null | { mode: "create"|"edit", data }
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [seedBusy, setSeedBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      // Sort by `order` if present, otherwise by text. Lets the user drag to
      // reorder while keeping a stable display for older docs without order.
      const list = await interestLinksService.list();
      list.sort((a, b) => {
        const ao = Number.isFinite(a.order) ? a.order : 1e9;
        const bo = Number.isFinite(b.order) ? b.order : 1e9;
        if (ao !== bo) return ao - bo;
        return String(a.text || "").localeCompare(String(b.text || ""));
      });
      setLinks(list);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);

  const onDragStart = (i) => (e) => {
    setDragIndex(i);
    e.dataTransfer.effectAllowed = "move";
    // Required for Firefox to start the drag.
    try { e.dataTransfer.setData("text/plain", String(i)); } catch { /* noop */ }
  };
  const onDragOver = (i) => (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverIndex !== i) setDragOverIndex(i);
  };
  const onDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };
  const onDrop = (target) => async (e) => {
    e.preventDefault();
    const src = dragIndex;
    setDragIndex(null);
    setDragOverIndex(null);
    if (src == null || src === target) return;
    const next = links.slice();
    const [moved] = next.splice(src, 1);
    next.splice(target, 0, moved);
    setLinks(next);
    // Persist new order. Only write the docs whose position actually changed.
    const updates = [];
    next.forEach((l, idx) => {
      if (l.order !== idx) updates.push({ id: l.id, idx });
    });
    for (const u of updates) {
      try { await interestLinksService.update(u.id, { order: u.idx }); } catch { /* noop */ }
    }
  };

  const openCreate = () =>
    setForm({ mode: "create", data: { text: "", url: "" } });

  const openEdit = (link) =>
    setForm({ mode: "edit", data: { id: link.id, text: link.text || "", url: link.url || "" } });

  const submitForm = async (e) => {
    e.preventDefault();
    const text = String(form.data.text || "").trim();
    const url = normalizeUrl(form.data.url);
    if (!text || !url) return;
    setBusy(true);
    try {
      if (form.mode === "create") await interestLinksService.create({ text, url });
      else await interestLinksService.update(form.data.id, { text, url });
      setForm(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      await interestLinksService.remove(confirmDelete.id);
      setConfirmDelete(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const seedFirst = async () => {
    setSeedBusy(true);
    try {
      await interestLinksService.create({ text: SEED.text, url: SEED.url });
      await load();
    } finally {
      setSeedBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Links de interés</h1>
          <p className="text-sm text-[var(--color-muted)]">Atajos a herramientas externas que uses seguido.</p>
        </div>
        <button
          onClick={openCreate}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
        >
          + Nuevo link
        </button>
      </div>

      {loading ? (
        <div className="text-[var(--color-muted)]">Cargando...</div>
      ) : links.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center">
          <p className="mb-3 text-sm text-[var(--color-muted)]">
            Todavía no hay links. ¿Empezamos con uno útil?
          </p>
          <button
            onClick={seedFirst}
            disabled={seedBusy}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
          >
            {seedBusy ? "Creando..." : `+ ${SEED.text} (iLovePDF)`}
          </button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {links.map((l, i) => {
            const isDragging = dragIndex === i;
            const isDropTarget = dragOverIndex === i && dragIndex !== null && dragIndex !== i;
            return (
              <div
                key={l.id}
                draggable
                onDragStart={onDragStart(i)}
                onDragOver={onDragOver(i)}
                onDrop={onDrop(i)}
                onDragEnd={onDragEnd}
                className={`group flex flex-col gap-2 rounded-lg border bg-[var(--color-surface)] p-4 transition-all hover:border-[var(--color-accent)] ${
                  isDragging
                    ? "border-[var(--color-accent)] opacity-50"
                    : isDropTarget
                      ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]/40"
                      : "border-[var(--color-border)]"
                }`}
                title="Arrastra para reordenar"
              >
                <div className="flex items-center justify-between text-[10px] text-[var(--color-muted)]">
                  <span className="cursor-grab select-none active:cursor-grabbing" aria-hidden>⋮⋮ arrastrar</span>
                </div>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1"
                  onClick={(e) => { if (dragIndex !== null) e.preventDefault(); }}
                >
                  <div className="mb-1 text-base font-semibold text-[var(--color-text)] group-hover:text-[var(--color-accent)]">
                    🔗 {l.text}
                  </div>
                  <div className="break-all text-xs text-[var(--color-muted)]">{safeHost(l.url) || l.url}</div>
                </a>
                <div className="flex gap-1 border-t border-[var(--color-border)] pt-2 text-xs">
                  <button
                    onClick={() => openEdit(l)}
                    className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => setConfirmDelete(l)}
                    className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={!!form}
        onClose={() => !busy && setForm(null)}
        title={form?.mode === "create" ? "Nuevo link" : "Editar link"}
      >
        {form && (
          <form onSubmit={submitForm} className="space-y-3">
            <TextField
              label="Texto"
              required
              autoFocus
              placeholder="Ej. De PDF a Word"
              value={form.data.text}
              onChange={(v) => setForm({ ...form, data: { ...form.data, text: v } })}
            />
            <TextField
              label="URL"
              required
              placeholder="https://..."
              value={form.data.url}
              onChange={(v) => setForm({ ...form, data: { ...form.data, url: v } })}
            />
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setForm(null)}
                disabled={busy}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              >
                {busy ? "..." : form.mode === "create" ? "Crear" : "Guardar"}
              </button>
            </div>
          </form>
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirmDelete}
        title="Eliminar link"
        message={confirmDelete ? `¿Eliminar "${confirmDelete.text}"?` : ""}
        confirmLabel="Eliminar"
        danger
        busy={busy}
        onCancel={() => !busy && setConfirmDelete(null)}
        onConfirm={doDelete}
      />
    </div>
  );
}
