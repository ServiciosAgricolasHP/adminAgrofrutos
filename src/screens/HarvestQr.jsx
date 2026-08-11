import { useEffect, useMemo, useState } from "react";
import { useToast } from "../contexts/ToastContext";
import { faenasService, cyclesService, workdaysService, harvestWeightsService, qrPrefixesService } from "../services";
import { comboKey, getDayCombos, workdayDocId } from "../utils/cosechaCombos";
import Modal from "../Components/Modal";
import Select from "../Components/Select";
import ConfirmDialog from "../components/ConfirmDialog";

// Puente entre los prefijos QR físicos (impresos de antemano, app scan_IS) y
// el (faena, ciclo, labor) vigente al que hay que sincronizar sus pesajes.
//
// Por qué el ciclo/labor vigente se reapunta a mano: los ciclos son un límite
// de negocio (cuándo se cierra uno y se abre el siguiente), no algo que el
// sistema pueda inferir con confianza — "el ciclo más reciente" no siempre es
// el vigente. Es una decisión deliberada, no una automatización pendiente.
const todayKey = () => new Date().toLocaleDateString("sv-SE");
const daysAgoKey = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("sv-SE");
};

function healthOf(prefix, cyclesById) {
  if (!prefix.cycleId || !prefix.laborId) {
    return { level: "red", label: "Sin ciclo/labor configurado" };
  }
  const cycle = cyclesById.get(prefix.cycleId);
  if (!cycle) return { level: "red", label: "El ciclo configurado ya no existe" };
  const cosechaLabors = (cycle.labors || []).filter((l) => l.type === "cosecha");
  const labor = cosechaLabors.find((l) => l.id === prefix.laborId);
  if (!labor) {
    if (cosechaLabors.length === 0) {
      return { level: "red", label: "El ciclo vigente no tiene ninguna labor de cosecha" };
    }
    return { level: "red", label: "La labor configurada ya no es de tipo cosecha en este ciclo" };
  }
  if (cosechaLabors.length > 1) {
    return { level: "yellow", label: `Hay ${cosechaLabors.length} labores de cosecha en este ciclo — verifica que sea la correcta` };
  }
  return { level: "green", label: "OK" };
}

const HEALTH_STYLES = {
  green: "border-[var(--color-success,#16a34a)] text-[var(--color-success,#16a34a)] bg-[var(--color-success-soft,rgba(22,163,74,0.12))]",
  yellow: "border-[var(--color-warning,#d97706)] text-[var(--color-warning,#d97706)] bg-[var(--color-warning-soft,rgba(217,119,6,0.12))]",
  red: "border-[var(--color-danger,#dc2626)] text-[var(--color-danger,#dc2626)] bg-[var(--color-danger-soft,rgba(220,38,38,0.12))]",
};

export default function HarvestQr() {
  const toast = useToast();
  const [prefixes, setPrefixes] = useState([]);
  const [faenas, setFaenas] = useState([]);
  const [cyclesById, setCyclesById] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [formState, setFormState] = useState(null); // null | { mode: "create" | "edit", data }
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [syncFor, setSyncFor] = useState(null); // prefix doc mientras se elige rango

  const reload = async () => {
    setLoading(true);
    try {
      const [px, fa] = await Promise.all([
        qrPrefixesService.list({ order: ["label", "asc"] }),
        faenasService.list({ order: ["name", "asc"], cache: true }),
      ]);
      setPrefixes(px);
      setFaenas(fa);
      const cycleIds = [...new Set(px.map((p) => p.cycleId).filter(Boolean))];
      const cycles = await Promise.all(cycleIds.map((id) => cyclesService.getById(id)));
      const map = new Map();
      cycles.forEach((c) => { if (c) map.set(c.id, c); });
      setCyclesById(map);
    } catch (err) {
      toast.error("No se pudo cargar la configuración de prefijos QR: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const faenaById = useMemo(() => new Map(faenas.map((f) => [f.id, f])), [faenas]);

  const handleDelete = async () => {
    if (!confirmDelete) return;
    await qrPrefixesService.remove(confirmDelete.id);
    setConfirmDelete(null);
    toast.success(`Prefijo ${confirmDelete.id} eliminado`);
    reload();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">📷 Cosecha QR — Prefijos</h1>
          <p className="text-sm text-[var(--color-muted)]">
            A qué faena/ciclo/labor apunta cada prefijo QR físico (app scan_IS), y sincronización de sus pesajes hacia las jornadas.
          </p>
        </div>
        <button
          onClick={() => setFormState({ mode: "create", data: { active: true } })}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
        >
          + Nuevo prefijo
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-[var(--color-muted)]">Cargando…</p>
      ) : prefixes.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted)]">
          No hay prefijos configurados todavía.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-[var(--color-border)]">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-[var(--color-surface-2)] text-left text-xs uppercase tracking-wide text-[var(--color-muted)]">
              <tr>
                <th className="px-3 py-2">Prefijo</th>
                <th className="px-3 py-2">Faena</th>
                <th className="px-3 py-2">Ciclo / labor vigente</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">Activo</th>
                <th className="px-3 py-2 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {prefixes.map((p) => {
                const health = healthOf(p, cyclesById);
                const cycle = p.cycleId ? cyclesById.get(p.cycleId) : null;
                const labor = cycle?.labors?.find((l) => l.id === p.laborId);
                return (
                  <tr key={p.id}>
                    <td className="px-3 py-2 font-mono font-semibold">{p.id}</td>
                    <td className="px-3 py-2">
                      <div>{faenaById.get(p.faenaId)?.name || "—"}</div>
                      <div className="text-xs text-[var(--color-muted)]">{p.label}</div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <div>{cycle?.label || cycle?.name || (p.cycleId ? "(ciclo no encontrado)" : "—")}</div>
                      <div className="text-[var(--color-muted)]">{labor?.name || (p.laborId ? "(labor no encontrada)" : "—")}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${HEALTH_STYLES[health.level]}`} title={health.label}>
                        {health.level === "green" ? "🟢" : health.level === "yellow" ? "🟡" : "🔴"} {health.label}
                      </span>
                    </td>
                    <td className="px-3 py-2">{p.active ? "Sí" : "No"}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1.5">
                        <button
                          onClick={() => setSyncFor(p)}
                          disabled={health.level === "red"}
                          className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          🔄 Sincronizar
                        </button>
                        <button
                          onClick={() => setFormState({ mode: "edit", data: p })}
                          className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                        >
                          Editar
                        </button>
                        <button
                          onClick={() => setConfirmDelete(p)}
                          className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft,rgba(220,38,38,0.12))]"
                        >
                          ✕
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {formState && (
        <PrefixFormModal
          mode={formState.mode}
          initial={formState.data}
          faenas={faenas}
          onClose={() => setFormState(null)}
          onSaved={() => { setFormState(null); reload(); }}
        />
      )}

      {syncFor && (
        <SyncModal
          prefix={syncFor}
          cycle={cyclesById.get(syncFor.cycleId)}
          onClose={() => setSyncFor(null)}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Eliminar prefijo"
        message={confirmDelete ? `¿Eliminar el prefijo "${confirmDelete.id}"? Esto no borra los pesajes ya registrados, solo el mapeo hacia la faena/ciclo.` : ""}
        confirmLabel="Eliminar"
        danger
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

function PrefixFormModal({ mode, initial, faenas, onClose, onSaved }) {
  const toast = useToast();
  const [prefix, setPrefix] = useState(initial.id || "");
  const [label, setLabel] = useState(initial.label || "");
  const [faenaId, setFaenaId] = useState(initial.faenaId || "");
  const [cycleId, setCycleId] = useState(initial.cycleId || "");
  const [laborId, setLaborId] = useState(initial.laborId || "");
  const [active, setActive] = useState(initial.active !== false);
  const [cycles, setCycles] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!faenaId) { setCycles([]); return; }
    cyclesService
      .list({ wheres: [["faenaId", "==", faenaId]], order: ["createdAt", "desc"] })
      .then((list) => {
        setCycles(list.sort((a, b) => (a.status === b.status ? 0 : a.status === "open" ? -1 : 1)));
      });
  }, [faenaId]);

  const selectedCycle = cycles.find((c) => c.id === cycleId);
  const laborOptions = (selectedCycle?.labors || [])
    .filter((l) => l.type === "cosecha")
    .map((l) => ({ value: l.id, label: l.name }));

  const submit = async () => {
    const prefixId = prefix.trim().toUpperCase();
    if (!prefixId || !label.trim() || !faenaId) {
      toast.error("Prefijo, etiqueta y faena son obligatorios");
      return;
    }
    setBusy(true);
    try {
      await qrPrefixesService.upsert(prefixId, {
        label: label.trim(),
        faenaId,
        cycleId: cycleId || null,
        laborId: laborId || null,
        active,
      });
      toast.success(mode === "create" ? "Prefijo creado" : "Prefijo actualizado");
      onSaved();
    } catch (err) {
      toast.error("No se pudo guardar: " + err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === "create" ? "Nuevo prefijo QR" : `Editar prefijo ${initial.id}`}
      size="sm"
      footer={
        <>
          <button onClick={onClose} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
          >
            {busy ? "Guardando…" : "Guardar"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-sm text-[var(--color-muted)]">
            Prefijo <span className="text-[var(--color-danger)]">*</span>
          </span>
          <input
            type="text"
            value={prefix}
            disabled={mode === "edit"}
            onChange={(e) => setPrefix(e.target.value.toUpperCase())}
            placeholder="HP"
            maxLength={5}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm uppercase outline-none focus:border-[var(--color-accent)] disabled:opacity-60"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-[var(--color-muted)]">
            Etiqueta <span className="text-[var(--color-danger)]">*</span>
          </span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Ej. HP — Berries Ejemplo"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <Select
          label="Faena"
          required
          value={faenaId}
          onChange={(v) => { setFaenaId(v); setCycleId(""); setLaborId(""); }}
          options={faenas.map((f) => ({ value: f.id, label: f.name }))}
        />
        <Select
          label="Ciclo vigente"
          value={cycleId}
          onChange={(v) => { setCycleId(v); setLaborId(""); }}
          disabled={!faenaId}
          placeholder={faenaId ? "Sin ciclo asignado" : "Elige una faena primero"}
          options={cycles.map((c) => ({ value: c.id, label: `${c.label || c.name || c.id}${c.status === "closed" ? " (cerrado)" : ""}` }))}
        />
        <Select
          label="Labor de cosecha vigente"
          value={laborId}
          onChange={setLaborId}
          disabled={!cycleId}
          placeholder={
            !cycleId ? "Elige un ciclo primero" : laborOptions.length === 0 ? "Este ciclo no tiene labores de cosecha" : "Sin labor asignada"
          }
          options={laborOptions}
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Activo (visible como opción en el scan app)
        </label>
      </div>
    </Modal>
  );
}

function SyncModal({ prefix, cycle, onClose }) {
  const toast = useToast();
  const [dateFrom, setDateFrom] = useState(daysAgoKey(14));
  const [dateTo, setDateTo] = useState(todayKey());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const labor = (cycle?.labors || []).find((l) => l.id === prefix.laborId);
      if (!cycle || !labor) throw new Error("Ciclo/labor vigente no disponible");

      const weights = await harvestWeightsService.list({
        wheres: [
          ["prefix", "==", prefix.id],
          ["dateKey", ">=", dateFrom],
          ["dateKey", "<=", dateTo],
        ],
      });

      // Agrupa por (trabajador, día, combo calidad/envase) y suma los kilos —
      // el mapeo por defecto es identidad (ver contexto: los catálogos se
      // diseñaron a propósito preservando la convención numérica del scan app).
      const groups = new Map();
      for (const w of weights) {
        if (!w.rut || !w.dateKey) continue;
        const x = prefix.qualityMap?.[String(w.weightProcess)] ?? (Number(w.weightProcess) || 0);
        const y = prefix.containerMap?.[String(w.weightType)] ?? (Number(w.weightType) || 0);
        const ck = comboKey(x, y);
        const gKey = `${w.rut}__${w.dateKey}__${ck}`;
        const g = groups.get(gKey) || { rut: w.rut, dateKey: w.dateKey, x, y, ck, qty: 0 };
        g.qty += Number(w.amount) || 0;
        groups.set(gKey, g);
      }

      let written = 0;
      for (const g of groups.values()) {
        const combos = getDayCombos(cycle.dayPrices, labor.id, g.dateKey, "unit");
        const combo = combos.find((c) => c.key === g.ck) || { price: 0, mode: "unit" };
        const amount = combo.mode === "flat" ? combo.price : g.qty * combo.price;
        const docId = workdayDocId(cycle.id, labor.id, g.rut, g.dateKey, g.ck);
        await workdaysService.upsert(docId, {
          cycleId: cycle.id,
          laborId: labor.id,
          workerRut: g.rut,
          date: g.dateKey,
          qualityX: g.x,
          containerY: g.y,
          qty: g.qty,
          amount,
          harvestSynced: true,
          harvestPrefix: prefix.id,
        });
        written++;
      }

      setResult({ weightsRead: weights.length, groups: groups.size, written });
      toast.success(`Sincronizado: ${written} jornada(s) actualizadas desde ${weights.length} pesaje(s)`);
    } catch (err) {
      toast.error("No se pudo sincronizar: " + err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Sincronizar pesajes — ${prefix.id}`} size="sm">
      <div className="space-y-3">
        <p className="text-sm text-[var(--color-muted)]">
          Recalcula e sobreescribe las jornadas de <strong>{cycle?.label || cycle?.name}</strong> en el rango elegido, sumando los pesajes de este prefijo. Se puede repetir sin problema — vuelve a calcular desde cero cada vez.
        </p>
        <div className="flex gap-2">
          <label className="block flex-1">
            <span className="mb-1 block text-sm text-[var(--color-muted)]">Desde</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
            />
          </label>
          <label className="block flex-1">
            <span className="mb-1 block text-sm text-[var(--color-muted)]">Hasta</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
            />
          </label>
        </div>
        {result && (
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-sm">
            <div>Pesajes leídos: {result.weightsRead}</div>
            <div>Combinaciones trabajador/día: {result.groups}</div>
            <div>Jornadas escritas: {result.written}</div>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
            Cerrar
          </button>
          <button
            onClick={run}
            disabled={busy}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
          >
            {busy ? "Sincronizando…" : "Sincronizar"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
