import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { faenasService, subfaenasService, harvestsService, cyclesService } from "../services";
import Modal from "../components/Modal";
import ConfirmDialog from "../components/ConfirmDialog";
import TextField from "../components/TextField";
import Select from "../components/Select";

const emptyHarvest = { name: "", faenaId: "", subfaenaId: "", startDate: "", notes: "" };
const emptyCycle = { label: "", startDate: "", notes: "" };

const todayStr = () => new Date().toISOString().slice(0, 10);

export default function Harvests() {
  const [faenas, setFaenas] = useState([]);
  const [subfaenas, setSubfaenas] = useState([]);
  const [harvests, setHarvests] = useState([]);
  const [cyclesByHarvest, setCyclesByHarvest] = useState({});
  const [loading, setLoading] = useState(true);
  const [filterFaena, setFilterFaena] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [expanded, setExpanded] = useState({});

  const [harvestForm, setHarvestForm] = useState(null);
  const [cycleForm, setCycleForm] = useState(null);
  const [closeFlow, setCloseFlow] = useState(null); // { cycle, harvestId, askNext, copyWorkers }
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const reloadAll = async () => {
    setLoading(true);
    try {
      const [f, s, h] = await Promise.all([
        faenasService.list({ order: ["name", "asc"] }),
        subfaenasService.list({ order: ["name", "asc"] }),
        harvestsService.list({ order: ["startDate", "desc"] }),
      ]);
      setFaenas(f);
      setSubfaenas(s);
      setHarvests(h);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reloadAll();
  }, []);

  const loadCycles = async (harvestId) => {
    const list = await cyclesService.list({
      wheres: [["harvestId", "==", harvestId]],
      order: ["createdAt", "asc"],
    });
    setCyclesByHarvest((prev) => ({ ...prev, [harvestId]: list }));
  };

  const toggleExpand = async (id) => {
    const next = !expanded[id];
    setExpanded((prev) => ({ ...prev, [id]: next }));
    if (next && !cyclesByHarvest[id]) await loadCycles(id);
  };

  const filteredHarvests = useMemo(() => {
    return harvests.filter((h) => {
      if (filterFaena && h.faenaId !== filterFaena) return false;
      if (!showClosed && h.status === "closed") return false;
      return true;
    });
  }, [harvests, filterFaena, showClosed]);

  const subsOf = (faenaId) => subfaenas.filter((s) => s.faenaId === faenaId);
  const faenaName = (id) => faenas.find((f) => f.id === id)?.name || "—";
  const subfaenaName = (id) => subfaenas.find((s) => s.id === id)?.name;

  const submitHarvest = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { mode, data } = harvestForm;
      const payload = {
        name: data.name.trim(),
        faenaId: data.faenaId,
        subfaenaId: data.subfaenaId || null,
        startDate: data.startDate || todayStr(),
        notes: data.notes || "",
        status: data.status || "active",
      };
      if (mode === "create") await harvestsService.create(payload);
      else await harvestsService.update(data.id, payload);
      setHarvestForm(null);
      await reloadAll();
    } finally {
      setBusy(false);
    }
  };

  const toggleHarvestStatus = async (h) => {
    const next = h.status === "closed" ? "active" : "closed";
    await harvestsService.update(h.id, { status: next });
    await reloadAll();
  };

  const deleteHarvest = async () => {
    if (!confirm) return;
    setConfirm((c) => ({ ...c, busy: true }));
    try {
      const cycles = await cyclesService.list({ wheres: [["harvestId", "==", confirm.item.id]], take: 1 });
      if (cycles.length) {
        alert("No se puede eliminar: la cosecha tiene ciclos asociados.");
        setConfirm(null);
        return;
      }
      await harvestsService.remove(confirm.item.id);
      setConfirm(null);
      await reloadAll();
    } finally {
      setConfirm((c) => (c ? { ...c, busy: false } : null));
    }
  };

  const submitCycle = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { mode, harvestId, data } = cycleForm;
      const payload = {
        harvestId,
        label: data.label.trim(),
        startDate: data.startDate || todayStr(),
        notes: data.notes || "",
        status: data.status || "open",
        workerIds: data.workerIds || [],
      };
      if (mode === "create") await cyclesService.create(payload);
      else await cyclesService.update(data.id, payload);
      setCycleForm(null);
      await loadCycles(harvestId);
    } finally {
      setBusy(false);
    }
  };

  const openCloseFlow = (cycle, harvestId) => {
    setCloseFlow({ cycle, harvestId, askNext: false, copyWorkers: true });
  };

  const confirmCloseCycle = async () => {
    if (!closeFlow) return;
    setBusy(true);
    try {
      await cyclesService.update(closeFlow.cycle.id, { status: "closed", endDate: todayStr() });
      setCloseFlow((s) => ({ ...s, askNext: true }));
      await loadCycles(closeFlow.harvestId);
    } finally {
      setBusy(false);
    }
  };

  const createNextCycle = async (copy) => {
    if (!closeFlow) return;
    setBusy(true);
    try {
      const prev = closeFlow.cycle;
      const cycles = cyclesByHarvest[closeFlow.harvestId] || [];
      const nextNumber = cycles.length + 1;
      await cyclesService.create({
        harvestId: closeFlow.harvestId,
        label: `Ciclo ${nextNumber}`,
        startDate: todayStr(),
        notes: "",
        status: "open",
        workerIds: copy ? prev.workerIds || [] : [],
      });
      setCloseFlow(null);
      await loadCycles(closeFlow.harvestId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Cosechas</h1>
          <p className="text-sm text-[var(--color-muted)]">Cosechas y ciclos por faena.</p>
        </div>
        <button
          onClick={() => setHarvestForm({ mode: "create", data: { ...emptyHarvest, startDate: todayStr() } })}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)]"
        >
          + Nueva cosecha
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-64">
          <Select
            label="Filtrar por faena"
            value={filterFaena}
            onChange={setFilterFaena}
            options={faenas.map((f) => ({ value: f.id, label: f.name }))}
            placeholder="Todas las faenas"
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-[var(--color-muted)]">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Mostrar cerradas
        </label>
      </div>

      {loading ? (
        <div className="text-[var(--color-muted)]">Cargando...</div>
      ) : filteredHarvests.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-8 text-center text-[var(--color-muted)]">
          No hay cosechas.
        </div>
      ) : (
        <div className="space-y-3">
          {filteredHarvests.map((h) => {
            const isOpen = !!expanded[h.id];
            const cycles = cyclesByHarvest[h.id];
            return (
              <div key={h.id} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <button onClick={() => toggleExpand(h.id)} className="flex flex-1 items-center gap-3 text-left">
                    <span className="text-[var(--color-muted)]">{isOpen ? "▼" : "▶"}</span>
                    <div>
                      <div className="flex items-center gap-2 font-medium">
                        {h.name}
                        <span
                          className={`rounded px-2 py-0.5 text-xs ${
                            h.status === "closed"
                              ? "bg-[var(--color-surface-2)] text-[var(--color-muted)]"
                              : "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                          }`}
                        >
                          {h.status === "closed" ? "cerrada" : "activa"}
                        </span>
                      </div>
                      <div className="text-xs text-[var(--color-muted)]">
                        {faenaName(h.faenaId)}
                        {h.subfaenaId && ` · ${subfaenaName(h.subfaenaId) || ""}`}
                        {h.startDate && ` · inicio ${h.startDate}`}
                      </div>
                    </div>
                  </button>
                  <div className="flex gap-2">
                    <button
                      onClick={() => toggleHarvestStatus(h)}
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs hover:bg-[var(--color-accent-soft)]"
                    >
                      {h.status === "closed" ? "Reabrir" : "Cerrar"}
                    </button>
                    <button
                      onClick={() => setHarvestForm({ mode: "edit", data: { ...h } })}
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs hover:bg-[var(--color-accent-soft)]"
                    >
                      Editar
                    </button>
                    <button
                      onClick={() => setConfirm({ item: h, message: `¿Eliminar la cosecha "${h.name}"?` })}
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs text-[var(--color-danger)] hover:bg-red-500/10"
                    >
                      Eliminar
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
                    <div className="mb-3 flex items-center justify-between">
                      <div className="text-xs uppercase tracking-wide text-[var(--color-muted)]">Ciclos</div>
                      <button
                        onClick={() =>
                          setCycleForm({
                            mode: "create",
                            harvestId: h.id,
                            data: {
                              ...emptyCycle,
                              startDate: todayStr(),
                              label: `Ciclo ${(cyclesByHarvest[h.id]?.length || 0) + 1}`,
                            },
                          })
                        }
                        className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-white hover:bg-[var(--color-accent-hover)]"
                      >
                        + Ciclo
                      </button>
                    </div>
                    {!cycles ? (
                      <div className="text-sm text-[var(--color-muted)]">Cargando...</div>
                    ) : cycles.length === 0 ? (
                      <div className="text-sm text-[var(--color-muted)]">Sin ciclos.</div>
                    ) : (
                      <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
                        {cycles.map((c) => (
                          <li key={c.id} className="flex items-center justify-between px-3 py-2">
                            <div>
                              <div className="flex items-center gap-2 text-sm font-medium">
                                {c.label}
                                <span
                                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                                    c.status === "closed"
                                      ? "bg-[var(--color-surface-2)] text-[var(--color-muted)]"
                                      : "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                                  }`}
                                >
                                  {c.status}
                                </span>
                              </div>
                              <div className="text-xs text-[var(--color-muted)]">
                                {c.startDate || "—"}
                                {c.endDate && ` → ${c.endDate}`}
                                {` · ${(c.workerIds || []).length} trabajadores`}
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <Link
                                to={`/cycles/${c.id}`}
                                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                              >
                                Abrir
                              </Link>
                              {c.status !== "closed" && (
                                <button
                                  onClick={() => openCloseFlow(c, h.id)}
                                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                                >
                                  Cerrar
                                </button>
                              )}
                              <button
                                onClick={() => setCycleForm({ mode: "edit", harvestId: h.id, data: { ...c } })}
                                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                              >
                                Editar
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

      {/* Harvest modal */}
      <Modal
        open={!!harvestForm}
        onClose={() => !busy && setHarvestForm(null)}
        title={harvestForm?.mode === "edit" ? "Editar cosecha" : "Nueva cosecha"}
      >
        {harvestForm && (
          <form onSubmit={submitHarvest} className="space-y-4">
            <TextField
              label="Nombre"
              required
              autoFocus
              value={harvestForm.data.name}
              onChange={(v) => setHarvestForm((f) => ({ ...f, data: { ...f.data, name: v } }))}
            />
            <Select
              label="Faena"
              required
              value={harvestForm.data.faenaId}
              onChange={(v) => setHarvestForm((f) => ({ ...f, data: { ...f.data, faenaId: v, subfaenaId: "" } }))}
              options={faenas.map((f) => ({ value: f.id, label: f.name }))}
            />
            {harvestForm.data.faenaId && subsOf(harvestForm.data.faenaId).length > 0 && (
              <Select
                label="Subfaena (opcional)"
                value={harvestForm.data.subfaenaId}
                onChange={(v) => setHarvestForm((f) => ({ ...f, data: { ...f.data, subfaenaId: v } }))}
                options={subsOf(harvestForm.data.faenaId).map((s) => ({ value: s.id, label: s.name }))}
              />
            )}
            <TextField
              label="Fecha inicio"
              type="date"
              value={harvestForm.data.startDate}
              onChange={(v) => setHarvestForm((f) => ({ ...f, data: { ...f.data, startDate: v } }))}
            />
            <TextField
              label="Notas"
              value={harvestForm.data.notes}
              onChange={(v) => setHarvestForm((f) => ({ ...f, data: { ...f.data, notes: v } }))}
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setHarvestForm(null)}
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

      {/* Cycle modal */}
      <Modal
        open={!!cycleForm}
        onClose={() => !busy && setCycleForm(null)}
        title={cycleForm?.mode === "edit" ? "Editar ciclo" : "Nuevo ciclo"}
      >
        {cycleForm && (
          <form onSubmit={submitCycle} className="space-y-4">
            <TextField
              label="Etiqueta"
              required
              autoFocus
              value={cycleForm.data.label}
              onChange={(v) => setCycleForm((c) => ({ ...c, data: { ...c.data, label: v } }))}
            />
            <TextField
              label="Fecha inicio"
              type="date"
              value={cycleForm.data.startDate}
              onChange={(v) => setCycleForm((c) => ({ ...c, data: { ...c.data, startDate: v } }))}
            />
            <TextField
              label="Notas"
              value={cycleForm.data.notes}
              onChange={(v) => setCycleForm((c) => ({ ...c, data: { ...c.data, notes: v } }))}
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCycleForm(null)}
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

      {/* Close cycle flow */}
      <Modal
        open={!!closeFlow}
        onClose={() => !busy && setCloseFlow(null)}
        title={closeFlow?.askNext ? "¿Crear nuevo ciclo?" : "Cerrar ciclo"}
        footer={
          closeFlow?.askNext ? (
            <>
              <button
                onClick={() => setCloseFlow(null)}
                disabled={busy}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
              >
                No, gracias
              </button>
              <button
                onClick={() => createNextCycle(closeFlow.copyWorkers)}
                disabled={busy}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              >
                {busy ? "..." : "Crear ciclo"}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setCloseFlow(null)}
                disabled={busy}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
              >
                Cancelar
              </button>
              <button
                onClick={confirmCloseCycle}
                disabled={busy}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
              >
                {busy ? "..." : "Cerrar ciclo"}
              </button>
            </>
          )
        }
      >
        {closeFlow && !closeFlow.askNext && (
          <p className="text-sm text-[var(--color-muted)]">
            Vas a cerrar <span className="text-[var(--color-text)]">{closeFlow.cycle.label}</span>. Después podrás iniciar un nuevo ciclo.
          </p>
        )}
        {closeFlow?.askNext && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--color-muted)]">
              El ciclo fue cerrado. ¿Quieres crear un ciclo nuevo a continuación?
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={closeFlow.copyWorkers}
                onChange={(e) => setCloseFlow((s) => ({ ...s, copyWorkers: e.target.checked }))}
              />
              Copiar trabajadores del ciclo anterior ({(closeFlow.cycle.workerIds || []).length})
            </label>
          </div>
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
        onConfirm={deleteHarvest}
      />
    </div>
  );
}
