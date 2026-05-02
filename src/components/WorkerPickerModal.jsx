import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import TextField from "./TextField";
import { workersService } from "../services";
import { findWorkerByRut, createWorker } from "../services/workersService";
import { formatRutForDisplay, normalizeRut, validateRut } from "../utils/rutUtils";

export default function WorkerPickerModal({ open, onClose, onPick, excludeRuts = [] }) {
  const [allWorkers, setAllWorkers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [newWorker, setNewWorker] = useState({ rut: "", name: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setCreating(false);
    setNewWorker({ rut: "", name: "" });
    setError("");
    (async () => {
      setLoading(true);
      try {
        const list = await workersService.list({
          order: ["name", "asc"],
          cache: true,
          persist: true,
          ttl: 5 * 60 * 1000,
        });
        setAllWorkers(list);
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  const excluded = useMemo(() => new Set(excludeRuts.map((r) => normalizeRut(r))), [excludeRuts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allWorkers
      .filter((w) => !excluded.has(w.id))
      .filter((w) => !q || w.id.toLowerCase().includes(q) || w.name?.toLowerCase().includes(q))
      .slice(0, 30);
  }, [allWorkers, search, excluded]);

  const submitNew = async (e) => {
    e.preventDefault();
    setError("");
    const rut = normalizeRut(newWorker.rut);
    if (!validateRut(rut)) return setError("RUT inválido");
    if (excluded.has(rut)) return setError("El trabajador ya está en el ciclo");
    if (!newWorker.name.trim()) return setError("Ingresa el nombre");
    setBusy(true);
    try {
      const existing = await findWorkerByRut(rut);
      const worker = existing || (await createWorker({ rut, name: newWorker.name }));
      onPick({ rut: worker.id, name: worker.name });
    } catch (err) {
      setError(err.message || "Error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Agregar trabajador" size="md">
      {!creating ? (
        <div className="space-y-3">
          <TextField label="Buscar por RUT o nombre" value={search} onChange={setSearch} autoFocus />
          <div className="max-h-72 overflow-y-auto rounded-md border border-[var(--color-border)]">
            {loading ? (
              <div className="p-3 text-sm text-[var(--color-muted)]">Cargando...</div>
            ) : filtered.length === 0 ? (
              <div className="p-3 text-sm text-[var(--color-muted)]">Sin coincidencias.</div>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {filtered.map((w) => (
                  <li key={w.id}>
                    <button
                      onClick={() => onPick({ rut: w.id, name: w.name })}
                      className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-[var(--color-accent-soft)]"
                    >
                      <span className="text-sm font-medium">{w.name}</span>
                      <span className="text-xs text-[var(--color-muted)]">{formatRutForDisplay(w.id)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            onClick={() => setCreating(true)}
            className="w-full rounded-md border border-dashed border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
          >
            + Crear nuevo trabajador
          </button>
        </div>
      ) : (
        <form onSubmit={submitNew} className="space-y-4">
          <TextField
            label="RUT"
            required
            autoFocus
            placeholder="12345678-K o 12345678-B"
            value={newWorker.rut}
            onChange={(v) => setNewWorker((w) => ({ ...w, rut: v }))}
          />
          <TextField
            label="Nombre"
            required
            value={newWorker.name}
            onChange={(v) => setNewWorker((w) => ({ ...w, name: v }))}
          />
          {error && <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-[var(--color-danger)]">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setCreating(false)}
              disabled={busy}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
            >
              Volver
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
            >
              {busy ? "..." : "Crear y agregar"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
