import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { toPng, toBlob } from "html-to-image";
import Modal from "../components/Modal";
import TextField from "../components/TextField";
import Select from "../components/Select";
import ConfirmDialog from "../components/ConfirmDialog";
import { TripEditModal } from "../components/TransportsModal";
import { useCarriers } from "../contexts/CarriersContext";
import { CARRIER_TYPES, validateVehicleAlias } from "../services/carriersService";
import {
  tripsService,
  paymentsService,
  transportPayrollsService,
  TRIP_KINDS,
  groupTripsByDay,
  groupTripsByFaena,
} from "../services/transportsService";
import { faenasService, subfaenasService, cyclesService } from "../services";
import { useIsMobile } from "../hooks/useIsMobile";
import { useToast } from "../contexts/ToastContext";

const DEFAULT_HISTORY_DAYS = 90;
const isoDateNDaysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

const fmtCurrency = (v) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 }).format(
    Number(v) || 0,
  );

const TABS = [
  { value: "carriers", label: "Transportistas" },
  { value: "trips", label: "Vueltas" },
  { value: "byFaena", label: "Pago por faena" },
  { value: "payments", label: "Resúmenes" },
  { value: "payrolls", label: "Quincenas" },
];

export default function Transports() {
  const [tab, setTab] = useState("carriers");

  return (
    <div>
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Transportes</h1>
      </div>

      <div className="mb-4 flex flex-wrap gap-1 border-b border-[var(--color-border)]">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`relative px-4 py-2 text-sm transition-colors ${
              tab === t.value ? "font-medium text-[var(--color-accent)]" : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {t.label}
            {tab === t.value && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-[var(--color-accent)]" />}
          </button>
        ))}
      </div>

      {tab === "carriers" && <CarriersTab />}
      {tab === "trips" && <TripsTab />}
      {tab === "byFaena" && <FaenaBatchTab />}
      {tab === "payments" && <PaymentsTab />}
      {tab === "payrolls" && <PayrollsTab />}
    </div>
  );
}

// ============================================================
// CARRIERS TAB
// ============================================================

function CarriersTab() {
  const { carriers, addCarrier, updateCarrier, softDeleteCarrier, restoreCarrier } = useCarriers();
  const [edit, setEdit] = useState(null); // null | "new" | carrier
  const [viewingTrips, setViewingTrips] = useState(null); // carrier cuyas vueltas se están viendo
  const [showInactive, setShowInactive] = useState(false);

  const visible = showInactive ? carriers : carriers.filter((c) => c.active !== false);

  const handleSave = async (data) => {
    if (edit && edit !== "new") {
      await updateCarrier(edit.id, data);
    } else {
      await addCarrier(data);
    }
    setEdit(null);
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Mostrar inactivos
        </label>
        <button
          onClick={() => setEdit("new")}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
        >
          + Transportista
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] py-8 text-center text-sm text-[var(--color-muted)]">
          Sin transportistas
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {visible.map((c) => (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              onClick={() => setViewingTrips(c)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setViewingTrips(c);
                }
              }}
              className={`group cursor-pointer rounded-lg border bg-[var(--color-surface)] p-3 shadow-sm transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] ${
                c.active === false ? "border-[var(--color-border)] opacity-60" : "border-[var(--color-border)]"
              }`}
              title="Ver vueltas del transportista"
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-semibold">{c.alias}</div>
                  <div className="text-sm text-[var(--color-muted)]">{c.name}</div>
                </div>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                    c.type === "own"
                      ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                      : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
                  }`}
                >
                  {c.type === "own" ? "propio" : "contratado"}
                </span>
              </div>
              {c.type !== "own" && c.defaultRate > 0 && (
                <div className="mt-1 text-xs text-[var(--color-muted)]">
                  Tarifa default: {fmtCurrency(c.defaultRate)}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
                {(c.vehicles || []).map((v) => (
                  <span key={v.alias} className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5">
                    {v.alias}
                    {v.plate && <span className="ml-1 text-[var(--color-muted)]">({v.plate})</span>}
                  </span>
                ))}
                {(c.vehicles || []).length === 0 && (
                  <span className="text-[var(--color-muted)]">Sin vehículos</span>
                )}
              </div>
              <div
                className="mt-3 flex items-center justify-between gap-1"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="text-[10px] text-[var(--color-muted)] opacity-0 transition-opacity group-hover:opacity-100">
                  Click para ver vueltas →
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setEdit(c)}
                    className="rounded px-2 py-1 text-xs text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
                  >
                    Editar
                  </button>
                  {c.active !== false ? (
                    <button
                      onClick={() => softDeleteCarrier(c.id)}
                      className="rounded px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
                    >
                      Desactivar
                    </button>
                  ) : (
                    <button
                      onClick={() => restoreCarrier(c.id)}
                      className="rounded px-2 py-1 text-xs text-[var(--color-success)] hover:bg-[var(--color-accent-soft)]"
                    >
                      Restaurar
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <CarrierEditModal open={!!edit} carrier={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSave={handleSave} />
      <CarrierTripsModal
        open={!!viewingTrips}
        carrier={viewingTrips}
        onClose={() => setViewingTrips(null)}
      />
    </div>
  );
}

// Listado de vueltas de un transportista. Carga todas sus vueltas (no
// filtrado por ciclo). Permite editar via TripEditModal y eliminar las que
// no estén pagadas. Filtros: estado y rango de fechas.
function CarrierTripsModal({ open, onClose, carrier }) {
  const toast = useToast();
  const { carriers } = useCarriers();
  const [trips, setTrips] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [faenas, setFaenas] = useState([]);
  const [subfaenas, setSubfaenas] = useState([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [editing, setEditing] = useState(null); // trip object o null
  const [confirmDel, setConfirmDel] = useState(null);

  const reload = async () => {
    if (!carrier?.id) return;
    setLoading(true);
    try {
      const [tripList, cyc, fa, sub] = await Promise.all([
        tripsService.listByCarrier(carrier.id),
        cyclesService.list({ cache: true, persist: true, ttl: 5 * 60 * 1000 }),
        faenasService.list({ cache: true, persist: true, ttl: 10 * 60 * 1000 }),
        subfaenasService.list({ cache: true, persist: true, ttl: 10 * 60 * 1000 }),
      ]);
      tripList.sort((a, b) => (a.date < b.date ? 1 : -1));
      setTrips(tripList);
      setCycles(cyc);
      setFaenas(fa);
      setSubfaenas(sub);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) reload();
    else {
      setEditing(null);
      setConfirmDel(null);
      setStatusFilter("");
      setDateFrom("");
      setDateTo("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, carrier?.id]);

  const cycleById = useMemo(() => new Map(cycles.map((c) => [c.id, c])), [cycles]);
  const faenaById = useMemo(() => new Map(faenas.map((f) => [f.id, f])), [faenas]);
  const subfaenaById = useMemo(() => new Map(subfaenas.map((s) => [s.id, s])), [subfaenas]);

  const filtered = useMemo(() => {
    return trips.filter((t) => {
      if (statusFilter && t.status !== statusFilter) return false;
      if (dateFrom && t.date && t.date < dateFrom) return false;
      if (dateTo && t.date && t.date > dateTo) return false;
      return true;
    });
  }, [trips, statusFilter, dateFrom, dateTo]);

  const totalAmount = filtered.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const pendingCount = filtered.filter((t) => t.status === "pending").length;
  const paidCount = filtered.filter((t) => t.status === "paid").length;

  const handleSave = async (form) => {
    if (!editing) return;
    // Preservar contexto del ciclo/faena/subfaena originales (no se editan
    // desde acá; si el usuario quiere mover la vuelta a otro ciclo lo hace
    // desde el módulo del ciclo).
    const payload = {
      ...form,
      cycleId: editing.cycleId || null,
      faenaId: editing.faenaId || null,
      subfaenaId: editing.subfaenaId || null,
    };
    await tripsService.update(editing.id, payload);
    setEditing(null);
    await reload();
  };

  const handleDelete = async () => {
    if (!confirmDel) return;
    try {
      await tripsService.remove(confirmDel.id);
      setConfirmDel(null);
      await reload();
    } catch (err) {
      toast.error(err.message || "Error al eliminar");
    }
  };

  if (!carrier) return null;

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={`🚐 Vueltas — ${carrier.alias} · ${carrier.name}`}
        size="3xl"
      >
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1">
              {[
                { v: "", l: "Todas" },
                { v: "pending", l: "⏳ Pendientes" },
                { v: "paid", l: "✓ Pagadas" },
              ].map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => setStatusFilter(o.v)}
                  className={`rounded-md border px-2 py-1 ${
                    statusFilter === o.v
                      ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                      : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"
                  }`}
                >
                  {o.l}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1">
              <span className="text-[var(--color-muted)]">Desde</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
              />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-[var(--color-muted)]">Hasta</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
              />
            </label>
            {(statusFilter || dateFrom || dateTo) && (
              <button
                type="button"
                onClick={() => {
                  setStatusFilter("");
                  setDateFrom("");
                  setDateTo("");
                }}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
              >
                Limpiar
              </button>
            )}
          </div>
          <div className="text-sm">
            <span className="text-[var(--color-muted)]">
              {filtered.length} vuelta{filtered.length === 1 ? "" : "s"} (
              {pendingCount} pend · {paidCount} pag) ·{" "}
            </span>
            <span className="font-semibold tabular-nums">{fmtCurrency(totalAmount)}</span>
          </div>
        </div>

        {loading ? (
          <div className="py-8 text-center text-sm text-[var(--color-muted)]">Cargando...</div>
        ) : filtered.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] py-8 text-center text-sm text-[var(--color-muted)]">
            {trips.length === 0 ? "Este transportista no tiene vueltas" : "Sin vueltas para los filtros aplicados"}
          </div>
        ) : (
          <div className="max-h-[55vh] overflow-auto rounded-md border border-[var(--color-border)]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[var(--color-surface-2)] text-left text-[var(--color-muted)]">
                <tr>
                  <th className="px-2 py-2">Fecha</th>
                  <th className="px-2 py-2">Vehículo</th>
                  <th className="px-2 py-2">Ciclo</th>
                  <th className="px-2 py-2">Faena / Subfaena</th>
                  <th className="px-2 py-2">Lugar → Destino</th>
                  <th className="px-2 py-2 text-right">#Pers</th>
                  <th className="px-2 py-2">Tipo</th>
                  <th className="px-2 py-2 text-right">Vlts</th>
                  <th className="px-2 py-2 text-right">Tarifa</th>
                  <th className="px-2 py-2 text-right">Monto</th>
                  <th className="px-2 py-2">Estado</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => {
                  const cy = cycleById.get(t.cycleId);
                  const fa = faenaById.get(t.faenaId);
                  const sb = subfaenaById.get(t.subfaenaId);
                  const isPaid = t.status === "paid";
                  return (
                    <tr key={t.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]">
                      <td className="px-2 py-1.5 tabular-nums">{t.date}</td>
                      <td className="px-2 py-1.5">{t.vehicleAlias || "—"}</td>
                      <td className="px-2 py-1.5">{cy?.label || t.cycleId || "—"}</td>
                      <td className="px-2 py-1.5">
                        {fa?.name || "—"}
                        {sb && <span className="text-[var(--color-muted)]"> / {sb.name}</span>}
                      </td>
                      <td className="px-2 py-1.5">
                        {t.lugar || "—"}
                        {t.destino && <span className="text-[var(--color-muted)]"> → {t.destino}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{t.personCount ?? "—"}</td>
                      <td className="px-2 py-1.5">{t.kind === "approach" ? "acerc." : "vuelta"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{t.qty}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtCurrency(t.rate)}</td>
                      <td className="px-2 py-1.5 text-right font-medium tabular-nums">{fmtCurrency(t.amount)}</td>
                      <td className="px-2 py-1.5">
                        {isPaid ? (
                          <span className="rounded-full bg-[var(--color-success-soft)] px-1.5 py-0.5 text-[11px] text-[var(--color-success)]">
                            pagado
                          </span>
                        ) : (
                          <span className="rounded-full bg-[var(--color-warning-soft)] px-1.5 py-0.5 text-[11px] text-[var(--color-warning)]">
                            pendiente
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex gap-1">
                          <button
                            onClick={() => setEditing(t)}
                            disabled={isPaid}
                            title={isPaid ? "No se puede editar una vuelta pagada" : "Editar"}
                            className="rounded px-2 py-0.5 text-xs text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            Editar
                          </button>
                          <button
                            onClick={() => setConfirmDel(t)}
                            disabled={isPaid}
                            title={isPaid ? "No se puede eliminar una vuelta pagada" : "Eliminar"}
                            className="rounded px-2 py-0.5 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] disabled:opacity-40 disabled:cursor-not-allowed"
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
      </Modal>

      <TripEditModal
        open={!!editing}
        onClose={() => setEditing(null)}
        trip={editing}
        carriers={carriers}
        days={[]}
        onSave={handleSave}
      />

      <ConfirmDialog
        open={!!confirmDel}
        title="Eliminar vuelta"
        message={
          confirmDel
            ? `¿Eliminar la vuelta del ${confirmDel.date} (${fmtCurrency(confirmDel.amount)})?`
            : ""
        }
        confirmLabel="Eliminar"
        danger
        onCancel={() => setConfirmDel(null)}
        onConfirm={handleDelete}
      />
    </>
  );
}

function CarrierEditModal({ open, onClose, carrier, onSave }) {
  const toast = useToast();
  const [alias, setAlias] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("contracted");
  const [defaultRate, setDefaultRate] = useState(0);
  const [vehicles, setVehicles] = useState([]);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setAlias(carrier?.alias || "");
    setName(carrier?.name || "");
    setType(carrier?.type || "contracted");
    setDefaultRate(carrier?.defaultRate || 0);
    setVehicles(carrier?.vehicles ? [...carrier.vehicles] : []);
    setNotes(carrier?.notes || "");
    setError("");
  }, [open, carrier]);

  const addVehicle = () => {
    const a = prompt("Alias del vehículo (ej: furgon, bus):");
    if (!a) return;
    const err = validateVehicleAlias({ vehicles }, a);
    if (err) { toast.warning(err); return; }
    setVehicles((vs) => [...vs, { alias: a.trim() }]);
  };

  const updateVehicle = (idx, patch) => {
    setVehicles((vs) => vs.map((v, i) => (i === idx ? { ...v, ...patch } : v)));
  };

  const removeVehicle = (idx) => {
    setVehicles((vs) => vs.filter((_, i) => i !== idx));
  };

  const handleSubmit = async () => {
    if (!alias.trim()) return setError("Alias requerido");
    if (!name.trim()) return setError("Nombre requerido");
    try {
      await onSave({ alias, name, type, defaultRate, vehicles, notes });
    } catch (err) {
      setError(err.message || "Error al guardar");
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={carrier ? "Editar transportista" : "Nuevo transportista"}
      size="lg"
      footer={
        <>
          <button onClick={onClose} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
          >
            Guardar
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Alias" value={alias} onChange={setAlias} required placeholder="ej: juan" />
        <TextField label="Nombre" value={name} onChange={setName} required placeholder="Nombre completo" />
        <Select
          label="Tipo"
          value={type}
          onChange={setType}
          options={CARRIER_TYPES.map((t) => ({ value: t.value, label: t.label }))}
        />
        {type !== "own" && (
          <TextField label="Tarifa default" type="number" value={defaultRate} onChange={setDefaultRate} />
        )}
        <div className="col-span-2">
          <TextField label="Notas" value={notes} onChange={setNotes} />
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium">Vehículos</h3>
          <button
            onClick={addVehicle}
            className="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
          >
            + Vehículo
          </button>
        </div>
        {vehicles.length === 0 ? (
          <p className="text-xs text-[var(--color-muted)]">Sin vehículos</p>
        ) : (
          <div className="space-y-2">
            {vehicles.map((v, idx) => (
              <div key={idx} className="grid grid-cols-12 gap-2 rounded-md border border-[var(--color-border)] p-2">
                <input
                  className="col-span-3 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-sm"
                  value={v.alias}
                  onChange={(e) => updateVehicle(idx, { alias: e.target.value })}
                  placeholder="alias"
                />
                <input
                  className="col-span-3 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-sm"
                  value={v.plate || ""}
                  onChange={(e) => updateVehicle(idx, { plate: e.target.value })}
                  placeholder="patente (opc.)"
                />
                <input
                  className="col-span-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-sm"
                  value={v.capacity || ""}
                  onChange={(e) => updateVehicle(idx, { capacity: e.target.value })}
                  placeholder="capacidad"
                />
                <input
                  className="col-span-3 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-sm"
                  value={v.notes || ""}
                  onChange={(e) => updateVehicle(idx, { notes: e.target.value })}
                  placeholder="notas"
                />
                <button
                  onClick={() => removeVehicle(idx)}
                  className="col-span-1 rounded text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && <div className="mt-3 text-sm text-[var(--color-danger)]">{error}</div>}
    </Modal>
  );
}

// ============================================================
// TRIPS TAB
// ============================================================

function TripsTab() {
  const isMobile = useIsMobile();
  const { activeCarriers, carriers } = useCarriers();
  const [trips, setTrips] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [faenas, setFaenas] = useState([]);
  const [subfaenas, setSubfaenas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ carrierId: "", status: "", cycleId: "", faenaId: "" });
  const [sinceDate, setSinceDate] = useState(() => isoDateNDaysAgo(DEFAULT_HISTORY_DAYS));
  const [showHistoric, setShowHistoric] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const tripPromise = showHistoric
        ? tripsService.listAll()
        : tripsService.listSince(sinceDate);
      const [tripList, cyc, fa, sub] = await Promise.all([
        tripPromise,
        cyclesService.list({ cache: true, persist: true, ttl: 5 * 60 * 1000 }),
        faenasService.list({ cache: true, persist: true, ttl: 10 * 60 * 1000 }),
        subfaenasService.list({ cache: true, persist: true, ttl: 10 * 60 * 1000 }),
      ]);
      tripList.sort((a, b) => (a.date < b.date ? 1 : -1));
      setTrips(tripList);
      setCycles(cyc);
      setFaenas(fa);
      setSubfaenas(sub);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sinceDate, showHistoric]);

  const carrierById = useMemo(() => new Map(carriers.map((c) => [c.id, c])), [carriers]);
  const cycleById = useMemo(() => new Map(cycles.map((c) => [c.id, c])), [cycles]);
  const faenaById = useMemo(() => new Map(faenas.map((f) => [f.id, f])), [faenas]);
  const subfaenaById = useMemo(() => new Map(subfaenas.map((s) => [s.id, s])), [subfaenas]);

  const filtered = useMemo(() => {
    return trips.filter((t) => {
      if (filter.carrierId && t.carrierId !== filter.carrierId) return false;
      if (filter.status && t.status !== filter.status) return false;
      if (filter.cycleId && t.cycleId !== filter.cycleId) return false;
      if (filter.faenaId && t.faenaId !== filter.faenaId) return false;
      return true;
    });
  }, [trips, filter]);

  const total = filtered.reduce((s, t) => s + (Number(t.amount) || 0), 0);

  return (
    <div>
      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-5">
        <Select
          label="Transportista"
          value={filter.carrierId}
          onChange={(v) => setFilter((f) => ({ ...f, carrierId: v }))}
          options={activeCarriers.map((c) => ({ value: c.id, label: `${c.alias} — ${c.name}` }))}
          placeholder="Todos"
        />
        <Select
          label="Estado"
          value={filter.status}
          onChange={(v) => setFilter((f) => ({ ...f, status: v }))}
          options={[
            { value: "pending", label: "Pendiente" },
            { value: "paid", label: "Pagado" },
          ]}
          placeholder="Todos"
        />
        <Select
          label="Ciclo"
          value={filter.cycleId}
          onChange={(v) => setFilter((f) => ({ ...f, cycleId: v }))}
          options={cycles.map((c) => ({ value: c.id, label: c.label || c.id }))}
          placeholder="Todos"
        />
        <Select
          label="Faena"
          value={filter.faenaId}
          onChange={(v) => setFilter((f) => ({ ...f, faenaId: v }))}
          options={faenas.map((f) => ({ value: f.id, label: f.name }))}
          placeholder="Todas"
        />
        <div className="flex items-end justify-end text-sm">
          <span className="text-[var(--color-muted)]">Total: </span>
          <span className="ml-1 font-semibold tabular-nums">{fmtCurrency(total)}</span>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[var(--color-muted)]">Mostrar:</span>
        <input
          type="date"
          disabled={showHistoric}
          value={sinceDate}
          onChange={(e) => setSinceDate(e.target.value || isoDateNDaysAgo(DEFAULT_HISTORY_DAYS))}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
        />
        <span className="text-[var(--color-muted)]">en adelante</span>
        <label className="ml-2 flex items-center gap-1">
          <input
            type="checkbox"
            checked={showHistoric}
            onChange={(e) => setShowHistoric(e.target.checked)}
          />
          <span>ver histórico completo</span>
        </label>
        {!showHistoric && (
          <span className="ml-auto text-[var(--color-muted)]">
            Por defecto últimos {DEFAULT_HISTORY_DAYS} días
          </span>
        )}
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-[var(--color-muted)]">Cargando...</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] py-8 text-center text-sm text-[var(--color-muted)]">
          Sin vueltas
        </div>
      ) : isMobile ? (
        <div className="space-y-2">
          {filtered.map((t) => {
            const c = carrierById.get(t.carrierId);
            const cy = cycleById.get(t.cycleId);
            const fa = faenaById.get(t.faenaId);
            const sb = subfaenaById.get(t.subfaenaId);
            return (
              <div
                key={t.id}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium leading-tight">{c ? c.alias : "—"}</div>
                    <div className="font-mono text-xs text-[var(--color-muted)]">{t.date}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold tabular-nums">{fmtCurrency(t.amount)}</div>
                    {t.status === "paid" ? (
                      <span className="rounded-full bg-[var(--color-success-soft)] px-1.5 py-0.5 text-[11px] text-[var(--color-success)]">
                        pagado
                      </span>
                    ) : (
                      <span className="rounded-full bg-[var(--color-warning-soft)] px-1.5 py-0.5 text-[11px] text-[var(--color-warning)]">
                        pendiente
                      </span>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
                  <div>
                    <span className="text-[var(--color-muted)]">Vehículo: </span>
                    {t.vehicleAlias || "—"}
                  </div>
                  <div>
                    <span className="text-[var(--color-muted)]">Ciclo: </span>
                    {cy?.label || t.cycleId}
                  </div>
                  <div className="col-span-2">
                    <span className="text-[var(--color-muted)]">Faena: </span>
                    {fa?.name || "—"}
                    {sb && <span className="text-[var(--color-muted)]"> / {sb.name}</span>}
                  </div>
                  <div>
                    <span className="text-[var(--color-muted)]">Destino: </span>
                    {t.destino || "—"}
                  </div>
                  <div>
                    <span className="text-[var(--color-muted)]">#Pers: </span>
                    {t.personCount ?? "—"}
                  </div>
                  <div>
                    <span className="text-[var(--color-muted)]">Tipo: </span>
                    {t.kind === "approach" ? "acercamiento" : "vuelta"}
                  </div>
                  <div>
                    <span className="text-[var(--color-muted)]">Vlts/Tarifa: </span>
                    <span className="tabular-nums">{t.qty} × {fmtCurrency(t.rate)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="overflow-auto rounded-md border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--color-surface-2)] text-left text-[var(--color-muted)]">
              <tr>
                <th className="px-2 py-2">Fecha</th>
                <th className="px-2 py-2">Transportista</th>
                <th className="px-2 py-2">Vehículo</th>
                <th className="px-2 py-2">Ciclo</th>
                <th className="px-2 py-2">Faena / Subfaena</th>
                <th className="px-2 py-2">Destino</th>
                <th className="px-2 py-2 text-right">#Pers</th>
                <th className="px-2 py-2">Tipo</th>
                <th className="px-2 py-2 text-right">Vlts</th>
                <th className="px-2 py-2 text-right">Tarifa</th>
                <th className="px-2 py-2 text-right">Monto</th>
                <th className="px-2 py-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const c = carrierById.get(t.carrierId);
                const cy = cycleById.get(t.cycleId);
                const fa = faenaById.get(t.faenaId);
                const sb = subfaenaById.get(t.subfaenaId);
                return (
                  <tr key={t.id} className="border-t border-[var(--color-border)]">
                    <td className="px-2 py-1.5 tabular-nums">{t.date}</td>
                    <td className="px-2 py-1.5">{c ? c.alias : "—"}</td>
                    <td className="px-2 py-1.5">{t.vehicleAlias || "—"}</td>
                    <td className="px-2 py-1.5">{cy?.label || t.cycleId}</td>
                    <td className="px-2 py-1.5">
                      {fa?.name || "—"}
                      {sb && <span className="text-[var(--color-muted)]"> / {sb.name}</span>}
                    </td>
                    <td className="px-2 py-1.5">{t.destino || "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{t.personCount ?? "—"}</td>
                    <td className="px-2 py-1.5">{t.kind === "approach" ? "acercamiento" : "vuelta"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{t.qty}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtCurrency(t.rate)}</td>
                    <td className="px-2 py-1.5 text-right font-medium tabular-nums">{fmtCurrency(t.amount)}</td>
                    <td className="px-2 py-1.5">
                      {t.status === "paid" ? (
                        <span className="rounded-full bg-[var(--color-success-soft)] px-1.5 py-0.5 text-[11px] text-[var(--color-success)]">
                          pagado
                        </span>
                      ) : (
                        <span className="rounded-full bg-[var(--color-warning-soft)] px-1.5 py-0.5 text-[11px] text-[var(--color-warning)]">
                          pendiente
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============================================================
// PAYMENTS TAB
// ============================================================

function PaymentsTab() {
  const toast = useToast();
  const { activeCarriers, carriers } = useCarriers();
  const [payments, setPayments] = useState([]);
  const [faenas, setFaenas] = useState([]);
  const [subfaenas, setSubfaenas] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [printingMany, setPrintingMany] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
  const [showHistoricPaid, setShowHistoricPaid] = useState(false);
  // Forzar re-fetch del balance cuando una operación cambia el estado
  // (marcar pagado, revertir, eliminar resumen, generar uno nuevo).
  const [balanceVersion, setBalanceVersion] = useState(0);

  const reload = async () => {
    setLoading(true);
    try {
      const paymentsPromise = showHistoricPaid
        ? paymentsService.listAll()
        : paymentsService.listSince(isoDateNDaysAgo(DEFAULT_HISTORY_DAYS));
      const [list, fa, sub, cyc] = await Promise.all([
        paymentsPromise,
        faenasService.list({ cache: true, persist: true, ttl: 10 * 60 * 1000 }),
        subfaenasService.list({ cache: true, persist: true, ttl: 10 * 60 * 1000 }),
        cyclesService.list({ cache: true, persist: true, ttl: 5 * 60 * 1000 }),
      ]);
      list.sort((a, b) => {
        const aT = a.createdAt?.seconds || 0;
        const bT = b.createdAt?.seconds || 0;
        return bT - aT;
      });
      setPayments(list);
      setFaenas(fa);
      setSubfaenas(sub);
      setCycles(cyc);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHistoricPaid]);

  const carrierById = useMemo(() => new Map(carriers.map((c) => [c.id, c])), [carriers]);
  const faenaById = useMemo(() => new Map(faenas.map((f) => [f.id, f])), [faenas]);
  const subfaenaById = useMemo(() => new Map(subfaenas.map((s) => [s.id, s])), [subfaenas]);
  const cycleById = useMemo(() => new Map(cycles.map((c) => [c.id, c])), [cycles]);
  const pending = payments.filter((p) => p.status === "pending");
  const paid = payments.filter((p) => p.status === "paid");

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-3">
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={showHistoricPaid}
            onChange={(e) => setShowHistoricPaid(e.target.checked)}
          />
          <span>ver histórico completo</span>
          {!showHistoricPaid && (
            <span className="ml-1 text-[var(--color-muted)]">
              (por defecto últimos {DEFAULT_HISTORY_DAYS} días)
            </span>
          )}
        </label>
        <button
          onClick={() => setPrintingMany(true)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
          title="Imprimir o exportar varios resúmenes a la vez"
        >
          🖨 Imprimir varios
        </button>
        <button
          onClick={() => setGenerating(true)}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
        >
          + Generar resumen
        </button>
      </div>

      <BalanceSummary carriers={carriers} reloadVersion={balanceVersion} />

      {loading ? (
        <div className="py-8 text-center text-sm text-[var(--color-muted)]">Cargando...</div>
      ) : (
        <>
          <PaymentSection
            title="Pendientes"
            payments={pending}
            carrierById={carrierById}
            onView={setViewing}
            empty="Sin resúmenes pendientes"
          />
          <div className="mt-6">
            <PaymentSection
              title="Pagados"
              payments={paid}
              carrierById={carrierById}
              onView={setViewing}
              empty="Sin pagos registrados"
              dim
            />
          </div>
        </>
      )}

      <GenerateSummaryModal
        open={generating}
        onClose={() => setGenerating(false)}
        carriers={activeCarriers}
        faenaById={faenaById}
        subfaenaById={subfaenaById}
        onGenerated={async () => {
          setGenerating(false);
          await reload();
          setBalanceVersion((v) => v + 1);
        }}
      />

      <PrintMultipleModal
        open={printingMany}
        onClose={() => setPrintingMany(false)}
        payments={payments}
        carriers={carriers}
        faenas={faenas}
        subfaenas={subfaenas}
        carrierById={carrierById}
        faenaById={faenaById}
        subfaenaById={subfaenaById}
        cycleById={cycleById}
      />

      <PaymentDetailModal
        open={!!viewing}
        onClose={() => setViewing(null)}
        payment={viewing}
        carrier={viewing ? carrierById.get(viewing.carrierId) : null}
        faenaById={faenaById}
        subfaenaById={subfaenaById}
        cycleById={cycleById}
        onPay={() => setConfirmAction({ type: "pay", payment: viewing })}
        onRevert={() => setConfirmAction({ type: "revert", payment: viewing })}
        onDelete={() => setConfirmAction({ type: "delete", payment: viewing })}
        onChanged={async () => {
          // Reload del listado padre + refresh del viewing actual (su .total
          // cambió tras editar precios). Bump balanceVersion para que el
          // balance también se refresque.
          await reload();
          setBalanceVersion((v) => v + 1);
          if (viewing) {
            const updated = await paymentsService.getById(viewing.id);
            if (updated) setViewing(updated);
          }
        }}
      />

      <ConfirmDialog
        open={!!confirmAction}
        title={
          confirmAction?.type === "pay" ? "Marcar como pagado" :
          confirmAction?.type === "revert" ? "Revertir pago" :
          "Eliminar resumen"
        }
        message={
          confirmAction?.type === "pay"
            ? "Todas las vueltas de este resumen se marcarán como pagadas."
            : confirmAction?.type === "revert"
              ? "El resumen volverá a pendiente y las vueltas también."
              : "El resumen será eliminado. Las vueltas vinculadas vuelven a quedar pendientes."
        }
        danger={confirmAction?.type === "delete"}
        onCancel={() => setConfirmAction(null)}
        onConfirm={async () => {
          const a = confirmAction;
          setConfirmAction(null);
          try {
            if (a.type === "pay") await paymentsService.markPaid(a.payment.id);
            else if (a.type === "revert") await paymentsService.revertPaid(a.payment.id);
            else if (a.type === "delete") await paymentsService.deleteSummary(a.payment.id);
            setViewing(null);
            await reload();
            setBalanceVersion((v) => v + 1);
          } catch (err) {
            toast.error(err.message || "Error");
          }
        }}
      />
    </div>
  );
}

// ============================================================
// PRINT MULTIPLE — batch print/export of multiple summaries
// ============================================================
// Filtros: estado (pending/paid/both), rango de fechas (overlap con
// periodFrom/periodTo), transportistas (multi-select) y faena/subfaena
// (requiere cargar trips). Acciones: imprimir todo en una ventana con
// page-break entre resúmenes, o exportar todos como PNG en un ZIP.
function PrintMultipleModal({
  open,
  onClose,
  payments,
  carriers,
  faenas,
  subfaenas,
  carrierById,
  faenaById,
  subfaenaById,
  cycleById,
}) {
  const toast = useToast();
  const [statusFilter, setStatusFilter] = useState("pending");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [carriersSel, setCarriersSel] = useState(() => new Set());
  const [faenasSel, setFaenasSel] = useState(() => new Set());
  const [subfaenasSel, setSubfaenasSel] = useState(() => new Set());

  // Trip data — se carga cuando se aplica filtro avanzado o cuando se
  // ejecuta una acción. Cacheado en el lifetime del modal.
  const [allTrips, setAllTrips] = useState(null);
  const [tripsLoading, setTripsLoading] = useState(false);

  // Acción en curso: "" | "print" | "zip". Mientras hay acción, renderizamos
  // todos los PrintableSummary en un contenedor offscreen para capturar
  // outerHTML / PNG.
  const [busy, setBusy] = useState("");
  const [renderItems, setRenderItems] = useState(null);
  const itemRefs = useRef([]);

  useEffect(() => {
    if (!open) {
      setStatusFilter("pending");
      setDateFrom("");
      setDateTo("");
      setCarriersSel(new Set());
      setFaenasSel(new Set());
      setSubfaenasSel(new Set());
      setRenderItems(null);
      setBusy("");
    }
  }, [open]);

  const ensureTrips = async () => {
    if (allTrips) return allTrips;
    setTripsLoading(true);
    try {
      const list = await tripsService.listAll();
      setAllTrips(list);
      return list;
    } finally {
      setTripsLoading(false);
    }
  };

  // Cargar trips automáticamente cuando se activa el filtro avanzado.
  const advancedActive = faenasSel.size > 0 || subfaenasSel.size > 0;
  useEffect(() => {
    if (open && advancedActive && !allTrips && !tripsLoading) ensureTrips();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, advancedActive]);

  // Filtros básicos (no requieren trips).
  const basicFiltered = useMemo(() => {
    return payments.filter((p) => {
      if (statusFilter !== "both" && p.status !== statusFilter) return false;
      if (carriersSel.size > 0 && !carriersSel.has(p.carrierId)) return false;
      if (dateFrom || dateTo) {
        const pFrom = p.periodFrom || p.periodTo || "";
        const pTo = p.periodTo || p.periodFrom || "";
        if (pFrom || pTo) {
          if (dateFrom && pTo && pTo < dateFrom) return false;
          if (dateTo && pFrom && pFrom > dateTo) return false;
        }
      }
      return true;
    });
  }, [payments, statusFilter, dateFrom, dateTo, carriersSel]);

  // Filtros avanzados (faena/subfaena) — un resumen pasa si tiene al menos
  // una vuelta cuya faena/subfaena está en los sets. El resumen impreso
  // muestra TODAS las vueltas (el filtro decide qué resúmenes entran, no
  // qué vueltas dentro del resumen).
  const finalPayments = useMemo(() => {
    if (!advancedActive) return basicFiltered;
    if (!allTrips) return null;
    const tripById = new Map(allTrips.map((t) => [t.id, t]));
    return basicFiltered.filter((p) => {
      const trips = (p.tripIds || []).map((id) => tripById.get(id)).filter(Boolean);
      return trips.some((t) => {
        if (faenasSel.size > 0 && !faenasSel.has(t.faenaId)) return false;
        if (subfaenasSel.size > 0 && !subfaenasSel.has(t.subfaenaId)) return false;
        return true;
      });
    });
  }, [basicFiltered, advancedActive, allTrips, faenasSel, subfaenasSel]);

  const finalCount = finalPayments?.length ?? "—";
  const finalTotal = (finalPayments || []).reduce((s, p) => s + (Number(p.total) || 0), 0);

  // Construye los items a renderizar (payment + carrier + trips + periodo).
  const buildRenderItems = async () => {
    const trips = await ensureTrips();
    const tripById = new Map(trips.map((t) => [t.id, t]));
    const list = finalPayments || basicFiltered;
    return list.map((p) => {
      const carrier = carrierById.get(p.carrierId) || null;
      const myTrips = (p.tripIds || [])
        .map((id) => tripById.get(id))
        .filter(Boolean)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const dates = myTrips.map((t) => t.date).filter(Boolean).sort();
      const periodLabel =
        p.periodFrom && p.periodTo
          ? `${p.periodFrom} → ${p.periodTo}`
          : dates.length
            ? `${dates[0]} → ${dates[dates.length - 1]}`
            : "—";
      return { payment: p, carrier, trips: myTrips, periodLabel };
    });
  };

  const waitFor = (ms) => new Promise((r) => setTimeout(r, ms));

  const handlePrint = async () => {
    setBusy("print");
    try {
      const items = await buildRenderItems();
      if (items.length === 0) {
        toast.warning("No hay resúmenes que coincidan con los filtros.");
        return;
      }
      itemRefs.current = new Array(items.length).fill(null);
      setRenderItems(items);
      await waitFor(80); // esperar el render
      const nodes = itemRefs.current.filter(Boolean);
      const html = nodes
        .map((n, i) => `<div class="page">${n.outerHTML}</div>`)
        .join("");
      const win = window.open("", "_blank", "width=1000,height=800");
      if (!win) {
        toast.warning("Permite las ventanas emergentes para imprimir.");
        return;
      }
      win.document.write(`<!DOCTYPE html><html><head><title>Resúmenes Transportes</title>
        <style>
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; box-sizing: border-box; }
          body { font-family: ui-sans-serif, system-ui, sans-serif; color: #000; margin: 0; padding: 0; }
          .page { padding: 20px; page-break-after: always; }
          .page:last-child { page-break-after: auto; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #999; padding: 6px 8px; font-size: 12px; }
          thead th { background: #92d050 !important; text-align: left; }
          .month-tag { background: #e6c0e0 !important; padding: 2px 8px; font-weight: 600; display: inline-block; }
          tr.tot-row td, .tot-row td { background: #c6efce !important; font-weight: 700; }
          @media print { @page { size: landscape; margin: 12mm; } }
        </style>
      </head><body>${html}<script>window.onload = () => { window.focus(); window.print(); };</script></body></html>`);
      win.document.close();
    } finally {
      setRenderItems(null);
      setBusy("");
    }
  };

  const handleZip = async () => {
    setBusy("zip");
    try {
      const items = await buildRenderItems();
      if (items.length === 0) {
        toast.warning("No hay resúmenes que coincidan con los filtros.");
        return;
      }
      itemRefs.current = new Array(items.length).fill(null);
      setRenderItems(items);
      await waitFor(80);
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const usedNames = new Set();
      for (let i = 0; i < items.length; i++) {
        const node = itemRefs.current[i];
        if (!node) continue;
        // eslint-disable-next-line no-await-in-loop
        const blob = await toBlob(node, { backgroundColor: "#ffffff", pixelRatio: 2 });
        if (!blob) continue;
        const it = items[i];
        const base = (it.carrier?.alias || it.payment.carrierId || "resumen")
          .toString()
          .replace(/[^a-z0-9_-]+/gi, "_");
        let name = `${base}_${it.payment.id.slice(-6)}.png`;
        while (usedNames.has(name)) name = `${base}_${i}.png`;
        usedNames.add(name);
        zip.file(name, blob);
      }
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `resumenes_transportes_${stamp}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast.error("Error al generar el ZIP: " + (err.message || err));
    } finally {
      setRenderItems(null);
      setBusy("");
    }
  };

  const toggleIn = (set, setter) => (id) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleCarrier = toggleIn(carriersSel, setCarriersSel);
  const toggleFaena = toggleIn(faenasSel, setFaenasSel);
  const toggleSubfaena = toggleIn(subfaenasSel, setSubfaenasSel);

  const sortedCarriers = useMemo(
    () => [...carriers].sort((a, b) => (a.alias || a.name).localeCompare(b.alias || b.name, "es")),
    [carriers],
  );
  const sortedFaenas = useMemo(
    () => [...faenas].sort((a, b) => a.name.localeCompare(b.name, "es")),
    [faenas],
  );
  const sortedSubfaenas = useMemo(() => {
    let arr = [...subfaenas];
    if (faenasSel.size > 0) arr = arr.filter((s) => faenasSel.has(s.faenaId));
    return arr.sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [subfaenas, faenasSel]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Imprimir resúmenes en lote"
      size="xl"
      footer={
        <>
          <button
            onClick={onClose}
            disabled={!!busy}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Cerrar
          </button>
          <button
            onClick={handleZip}
            disabled={!!busy || (finalPayments && finalPayments.length === 0)}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
          >
            {busy === "zip" ? "Generando ZIP..." : "📦 ZIP PNGs"}
          </button>
          <button
            onClick={handlePrint}
            disabled={!!busy || (finalPayments && finalPayments.length === 0)}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {busy === "print" ? "Preparando..." : "🖨 Imprimir"}
          </button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-[var(--color-border)] p-3">
          <div className="mb-2 text-xs font-medium text-[var(--color-muted)]">Estado</div>
          <div className="flex flex-wrap gap-1 text-xs">
            {[
              { v: "pending", l: "⏳ Pendientes" },
              { v: "paid", l: "✓ Pagados" },
              { v: "both", l: "Ambos" },
            ].map((o) => (
              <button
                key={o.v}
                type="button"
                onClick={() => setStatusFilter(o.v)}
                className={`rounded-md border px-2 py-1 ${
                  statusFilter === o.v
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                    : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"
                }`}
              >
                {o.l}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-[var(--color-border)] p-3">
          <div className="mb-2 text-xs font-medium text-[var(--color-muted)]">Rango de fechas</div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1">
              <span className="text-[var(--color-muted)]">Desde</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
              />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-[var(--color-muted)]">Hasta</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
              />
            </label>
            {(dateFrom || dateTo) && (
              <button
                type="button"
                onClick={() => {
                  setDateFrom("");
                  setDateTo("");
                }}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
              >
                Limpiar
              </button>
            )}
          </div>
        </div>

        <div className="rounded-md border border-[var(--color-border)] p-3 sm:col-span-2">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-medium text-[var(--color-muted)]">
              Transportistas ({carriersSel.size === 0 ? "todos" : carriersSel.size})
            </span>
            {carriersSel.size > 0 && (
              <button
                type="button"
                onClick={() => setCarriersSel(new Set())}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 hover:bg-[var(--color-accent-soft)]"
              >
                Limpiar
              </button>
            )}
          </div>
          <div className="grid max-h-32 grid-cols-1 gap-1 overflow-auto sm:grid-cols-2 lg:grid-cols-3">
            {sortedCarriers.map((c) => (
              <label key={c.id} className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs">
                <input
                  type="checkbox"
                  checked={carriersSel.has(c.id)}
                  onChange={() => toggleCarrier(c.id)}
                />
                <span className="truncate">
                  <span className="font-medium">{c.alias}</span>
                  <span className="ml-1 text-[var(--color-muted)]">— {c.name}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-[var(--color-border)] p-3">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-medium text-[var(--color-muted)]">
              Faenas ({faenasSel.size === 0 ? "todas" : faenasSel.size})
            </span>
            {faenasSel.size > 0 && (
              <button
                type="button"
                onClick={() => setFaenasSel(new Set())}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 hover:bg-[var(--color-accent-soft)]"
              >
                Limpiar
              </button>
            )}
          </div>
          <div className="grid max-h-28 grid-cols-1 gap-1 overflow-auto">
            {sortedFaenas.map((f) => (
              <label key={f.id} className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs">
                <input
                  type="checkbox"
                  checked={faenasSel.has(f.id)}
                  onChange={() => toggleFaena(f.id)}
                />
                <span className="truncate">{f.name}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-[var(--color-border)] p-3">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-medium text-[var(--color-muted)]">
              Subfaenas ({subfaenasSel.size === 0 ? "todas" : subfaenasSel.size})
            </span>
            {subfaenasSel.size > 0 && (
              <button
                type="button"
                onClick={() => setSubfaenasSel(new Set())}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 hover:bg-[var(--color-accent-soft)]"
              >
                Limpiar
              </button>
            )}
          </div>
          <div className="grid max-h-28 grid-cols-1 gap-1 overflow-auto">
            {sortedSubfaenas.map((s) => (
              <label key={s.id} className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs">
                <input
                  type="checkbox"
                  checked={subfaenasSel.has(s.id)}
                  onChange={() => toggleSubfaena(s.id)}
                />
                <span className="truncate">{s.name}</span>
              </label>
            ))}
            {sortedSubfaenas.length === 0 && (
              <span className="px-2 py-1 text-[var(--color-muted)]">
                {faenasSel.size > 0 ? "Sin subfaenas para la faena seleccionada" : "—"}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm">
        <span>
          {advancedActive && !allTrips
            ? tripsLoading
              ? "Cargando vueltas para filtros avanzados..."
              : "Esperando datos para filtros avanzados..."
            : `${finalCount} resumen(es) coinciden`}
        </span>
        <span className="font-semibold tabular-nums">{fmtCurrency(finalTotal)}</span>
      </div>

      {/* Offscreen render container: solo monta durante la acción para que
          html-to-image / outerHTML lo pueda leer. */}
      {renderItems && (
        <div
          aria-hidden="true"
          style={{
            position: "fixed",
            left: "-10000px",
            top: 0,
            width: "1100px",
            background: "#ffffff",
          }}
        >
          {renderItems.map((it, i) => (
            <PrintableSummary
              key={it.payment.id}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              payment={it.payment}
              carrier={it.carrier}
              trips={it.trips}
              periodLabel={it.periodLabel}
              faenaById={faenaById}
              subfaenaById={subfaenaById}
              cycleById={cycleById}
            />
          ))}
        </div>
      )}
    </Modal>
  );
}

// Balance general: cuánto se le debe a cada transportista (vueltas sueltas
// pendientes + resumenes pendientes ya generados). Se filtra por rango de
// fechas: el rango se aplica a la `date` de la vuelta y al overlap del
// período del resumen (periodFrom/periodTo).
function BalanceSummary({ carriers, reloadVersion }) {
  const toast = useToast();
  const [pendingTrips, setPendingTrips] = useState([]);
  const [pendingPayments, setPendingPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [expanded, setExpanded] = useState(true);
  const [busy, setBusy] = useState("");
  const printRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [trips, allPayments] = await Promise.all([
          tripsService.listPendingUnlinked(),
          paymentsService.listAll(),
        ]);
        if (cancelled) return;
        setPendingTrips(trips);
        setPendingPayments(allPayments.filter((p) => p.status === "pending"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadVersion]);

  const tripsInRange = useMemo(
    () =>
      pendingTrips.filter(
        (t) => (!dateFrom || t.date >= dateFrom) && (!dateTo || t.date <= dateTo),
      ),
    [pendingTrips, dateFrom, dateTo],
  );

  const paymentsInRange = useMemo(
    () =>
      pendingPayments.filter((p) => {
        if (!dateFrom && !dateTo) return true;
        const pFrom = p.periodFrom || p.periodTo || "";
        const pTo = p.periodTo || p.periodFrom || "";
        if (!pFrom && !pTo) return true; // sin período → siempre incluir
        if (dateFrom && pTo && pTo < dateFrom) return false;
        if (dateTo && pFrom && pFrom > dateTo) return false;
        return true;
      }),
    [pendingPayments, dateFrom, dateTo],
  );

  const rows = useMemo(() => {
    const map = new Map();
    const ensure = (carrierId) => {
      if (!map.has(carrierId)) {
        const carrier = carriers.find((c) => c.id === carrierId);
        map.set(carrierId, {
          carrierId,
          name: carrier?.name || "(transportista eliminado)",
          alias: carrier?.alias || "—",
          tripCount: 0,
          tripTotal: 0,
          paymentCount: 0,
          paymentTotal: 0,
        });
      }
      return map.get(carrierId);
    };
    for (const t of tripsInRange) {
      const e = ensure(t.carrierId);
      e.tripCount += 1;
      e.tripTotal += Number(t.amount) || 0;
    }
    for (const p of paymentsInRange) {
      const e = ensure(p.carrierId);
      e.paymentCount += 1;
      e.paymentTotal += Number(p.total) || 0;
    }
    return [...map.values()]
      .map((e) => ({ ...e, grandTotal: e.tripTotal + e.paymentTotal }))
      .filter((e) => e.tripCount + e.paymentCount > 0)
      .sort((a, b) => b.grandTotal - a.grandTotal);
  }, [carriers, tripsInRange, paymentsInRange]);

  const grandTotal = rows.reduce((s, r) => s + r.grandTotal, 0);
  const tripsTotal = rows.reduce((s, r) => s + r.tripTotal, 0);
  const paymentsTotal = rows.reduce((s, r) => s + r.paymentTotal, 0);

  const handleCopyImage = async () => {
    if (!printRef.current) return;
    setBusy("copy");
    try {
      const blob = await toBlob(printRef.current, {
        backgroundColor: "#ffffff",
        pixelRatio: 2,
      });
      if (!blob) throw new Error("No se pudo generar la imagen");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast.success("Imagen copiada");
    } catch (err) {
      toast.error("Error: " + (err.message || err));
    } finally {
      setBusy("");
    }
  };

  const handleDownload = async () => {
    if (!printRef.current) return;
    setBusy("download");
    try {
      const dataUrl = await toPng(printRef.current, {
        backgroundColor: "#ffffff",
        pixelRatio: 2,
      });
      const link = document.createElement("a");
      link.download = "balance-transportes.png";
      link.href = dataUrl;
      link.click();
    } finally {
      setBusy("");
    }
  };

  // Imprime el nodo del balance directo. Inyectamos los estilos mínimos
  // para que la tabla se vea igual en el navegador (con colores y bordes).
  // `print-color-adjust: exact` fuerza al engine a no descartar los fondos.
  const handlePrint = () => {
    if (!printRef.current) return;
    const html = printRef.current.outerHTML;
    const win = window.open("", "_blank", "width=900,height=700");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>Balance de transportes</title>
      <style>
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; box-sizing: border-box; }
        body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 20px; color: #000; margin: 0; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #888; padding: 6px 8px; font-size: 12px; }
        @media print { @page { size: landscape; margin: 12mm; } }
      </style>
    </head><body>${html}<script>window.onload = () => { window.focus(); window.print(); };</script></body></html>`);
    win.document.close();
  };

  const rangeLabel = (() => {
    if (!dateFrom && !dateTo) return "Todo lo pendiente";
    if (dateFrom && dateTo) return `${dateFrom} → ${dateTo}`;
    if (dateFrom) return `desde ${dateFrom}`;
    return `hasta ${dateTo}`;
  })();

  return (
    <div className="mb-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-[var(--color-accent-soft)]"
      >
        <span className="flex items-center gap-2">
          <span className="text-[var(--color-muted)]">{expanded ? "▾" : "▸"}</span>
          <span className="font-medium">Balance general de transportes</span>
          <span className="text-xs text-[var(--color-muted)]">· {rangeLabel}</span>
        </span>
        <span className="flex items-baseline gap-2">
          <span className="text-xs text-[var(--color-muted)]">
            {rows.length} transportista{rows.length === 1 ? "" : "s"}
          </span>
          <span className="font-semibold tabular-nums text-[var(--color-accent)]">
            {fmtCurrency(grandTotal)}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[var(--color-border)] p-3">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-xs">
              <span className="text-[var(--color-muted)]">Desde</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-sm"
              />
            </label>
            <label className="flex items-center gap-1 text-xs">
              <span className="text-[var(--color-muted)]">Hasta</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-sm"
              />
            </label>
            {(dateFrom || dateTo) && (
              <button
                onClick={() => {
                  setDateFrom("");
                  setDateTo("");
                }}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
              >
                Limpiar
              </button>
            )}
            <div className="ml-auto flex gap-1">
              <button
                onClick={handleCopyImage}
                disabled={busy === "copy" || rows.length === 0}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
              >
                {busy === "copy" ? "..." : "📋 Copiar imagen"}
              </button>
              <button
                onClick={handleDownload}
                disabled={busy === "download" || rows.length === 0}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
              >
                {busy === "download" ? "..." : "📥 PNG"}
              </button>
              <button
                onClick={handlePrint}
                disabled={rows.length === 0}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
              >
                🖨 Imprimir
              </button>
            </div>
          </div>

          {loading ? (
            <div className="py-4 text-center text-xs text-[var(--color-muted)]">
              Cargando balance...
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--color-border)] py-4 text-center text-xs text-[var(--color-muted)]">
              Sin saldos pendientes en este rango.
            </div>
          ) : (
            <div
              ref={printRef}
              style={{
                background: "#ffffff",
                color: "#000",
                padding: 16,
                fontFamily: "ui-sans-serif, system-ui, sans-serif",
              }}
            >
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>
                  Balance de transportes pendientes
                </div>
                <div style={{ fontSize: 11, color: "#555" }}>
                  Rango: {rangeLabel}
                  {" · "}Generado{" "}
                  {new Date().toLocaleDateString("es-CL", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  })}
                </div>
              </div>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr style={{ background: "#9dc3e6" }}>
                    <th style={cellH}>Transportista</th>
                    <th style={{ ...cellH, textAlign: "right" }}>Vueltas sueltas</th>
                    <th style={{ ...cellH, textAlign: "right" }}>$ vueltas</th>
                    <th style={{ ...cellH, textAlign: "right" }}>Resúmenes</th>
                    <th style={{ ...cellH, textAlign: "right" }}>$ resúmenes</th>
                    <th style={{ ...cellH, textAlign: "right" }}>Total a pagar</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.carrierId}>
                      <td style={cell}>
                        <span style={{ fontWeight: 600 }}>{r.alias}</span>
                        <span style={{ color: "#666", marginLeft: 6, fontSize: 11 }}>
                          {r.name}
                        </span>
                      </td>
                      <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {r.tripCount || ""}
                      </td>
                      <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {r.tripTotal > 0 ? fmtCurrency(r.tripTotal) : ""}
                      </td>
                      <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {r.paymentCount || ""}
                      </td>
                      <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {r.paymentTotal > 0 ? fmtCurrency(r.paymentTotal) : ""}
                      </td>
                      <td
                        style={{
                          ...cell,
                          textAlign: "right",
                          fontWeight: 700,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {fmtCurrency(r.grandTotal)}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ background: "#c6efce" }}>
                    <td style={{ ...cell, fontWeight: 700 }}>TOTAL</td>
                    <td style={cell}></td>
                    <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                      {tripsTotal > 0 ? fmtCurrency(tripsTotal) : ""}
                    </td>
                    <td style={cell}></td>
                    <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                      {paymentsTotal > 0 ? fmtCurrency(paymentsTotal) : ""}
                    </td>
                    <td
                      style={{
                        ...cell,
                        textAlign: "right",
                        fontWeight: 700,
                        fontSize: 13,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmtCurrency(grandTotal)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PaymentSection({ title, payments, carrierById, onView, empty, dim = false }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-[var(--color-muted)]">{title}</h3>
      {payments.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--color-border)] py-4 text-center text-xs text-[var(--color-muted)]">
          {empty}
        </p>
      ) : (
        <div className={`grid gap-2 ${dim ? "opacity-90" : ""}`}>
          {payments.map((p) => {
            const c = carrierById.get(p.carrierId);
            return (
              <button
                key={p.id}
                onClick={() => onView(p)}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left text-sm hover:border-[var(--color-accent)]"
              >
                <div>
                  <div className="font-medium">{c?.alias || p.carrierId} <span className="text-[var(--color-muted)]">— {c?.name}</span></div>
                  <div className="text-xs text-[var(--color-muted)]">
                    {(p.tripIds || []).length} vueltas
                    {p.periodFrom && p.periodTo && ` · ${p.periodFrom} → ${p.periodTo}`}
                    {p.groupBy && ` · agrupado por ${p.groupBy === "day" ? "día" : "faena"}`}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold tabular-nums">{fmtCurrency(p.total)}</div>
                  <div
                    className={`text-[10px] ${
                      p.status === "paid"
                        ? "text-[var(--color-success)]"
                        : "text-[var(--color-warning)]"
                    }`}
                  >
                    {p.status === "paid" ? "pagado" : "pendiente"}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GenerateSummaryModal({ open, onClose, carriers, faenaById, subfaenaById, onGenerated }) {
  const groupLabel = (g) => {
    if (g.date) return g.date;
    const fName = faenaById?.get(g.faenaId)?.name;
    const sName = subfaenaById?.get(g.subfaenaId)?.name;
    if (fName && sName) return `${fName} / ${sName}`;
    if (fName) return fName;
    if (sName) return sName;
    return "Sin faena";
  };
  const [carrierId, setCarrierId] = useState("");
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");
  const [groupBy, setGroupBy] = useState("day");
  const [preview, setPreview] = useState(null); // { trips, total }
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) {
      setCarrierId("");
      setPeriodFrom("");
      setPeriodTo("");
      setGroupBy("day");
      setPreview(null);
      setNotes("");
    }
  }, [open]);

  const loadPreview = async () => {
    if (!carrierId) return;
    setLoading(true);
    try {
      const r = await paymentsService.previewSummary({ carrierId, periodFrom, periodTo });
      setPreview(r);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!preview || preview.trips.length === 0) return;
    setSaving(true);
    try {
      await paymentsService.createSummary({
        carrierId,
        periodFrom: periodFrom || null,
        periodTo: periodTo || null,
        groupBy,
        tripIds: preview.trips.map((t) => t.id),
        total: preview.total,
        notes,
      });
      onGenerated();
    } finally {
      setSaving(false);
    }
  };

  const grouped = useMemo(() => {
    if (!preview) return [];
    return groupBy === "day" ? groupTripsByDay(preview.trips) : groupTripsByFaena(preview.trips);
  }, [preview, groupBy]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Generar resumen de transporte"
      size="xl"
      footer={
        <>
          <button onClick={onClose} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
            Cancelar
          </button>
          <button
            onClick={handleGenerate}
            disabled={!preview || preview.trips.length === 0 || saving}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {saving ? "Guardando..." : "Generar resumen"}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-4 gap-3">
        <div className="col-span-2">
          <Select
            label="Transportista"
            value={carrierId}
            onChange={setCarrierId}
            options={carriers.map((c) => ({ value: c.id, label: `${c.alias} — ${c.name}` }))}
            required
          />
        </div>
        <Select
          label="Agrupar por"
          value={groupBy}
          onChange={setGroupBy}
          options={[
            { value: "day", label: "Día" },
            { value: "faena", label: "Faena" },
          ]}
        />
        <div className="flex items-end">
          <button
            onClick={loadPreview}
            disabled={!carrierId || loading}
            className="w-full rounded-md border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
          >
            {loading ? "Cargando..." : "Vista previa"}
          </button>
        </div>
        <TextField label="Desde" type="date" value={periodFrom} onChange={setPeriodFrom} />
        <TextField label="Hasta" type="date" value={periodTo} onChange={setPeriodTo} />
        <div className="col-span-2">
          <TextField label="Notas" value={notes} onChange={setNotes} />
        </div>
      </div>

      {preview && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-[var(--color-muted)]">{preview.trips.length} vueltas pendientes</span>
            <span className="font-semibold tabular-nums">{fmtCurrency(preview.total)}</span>
          </div>
          {preview.trips.length === 0 ? (
            <p className="rounded-md border border-dashed border-[var(--color-border)] py-4 text-center text-xs text-[var(--color-muted)]">
              No hay vueltas pendientes en el período seleccionado.
            </p>
          ) : (
            <div className="max-h-64 overflow-auto rounded-md border border-[var(--color-border)]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[var(--color-surface-2)] text-left text-[var(--color-muted)]">
                  <tr>
                    <th className="px-2 py-1.5">{groupBy === "day" ? "Día" : "Grupo"}</th>
                    <th className="px-2 py-1.5 text-right"># Vueltas</th>
                    <th className="px-2 py-1.5 text-right">Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.map((g, i) => (
                    <tr key={i} className="border-t border-[var(--color-border)]">
                      <td className="px-2 py-1">{groupLabel(g)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{g.trips.length}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtCurrency(g.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function PaymentDetailModal({ open, onClose, payment, carrier, faenaById, subfaenaById, cycleById, onPay, onRevert, onDelete, onChanged }) {
  const toast = useToast();
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(false);
  const printRef = useRef(null);
  const [busy, setBusy] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [savingTripId, setSavingTripId] = useState(null);

  useEffect(() => {
    if (!open || !payment) return;
    (async () => {
      setLoading(true);
      try {
        const all = await tripsService.listByCarrier(payment.carrierId);
        const filtered = all
          .filter((t) => (payment.tripIds || []).includes(t.id))
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        setTrips(filtered);
      } finally {
        setLoading(false);
      }
    })();
  }, [open, payment]);

  if (!payment) return null;
  const isPaid = payment.status === "paid";

  const periodLabel = (() => {
    if (payment.periodFrom && payment.periodTo) return `${payment.periodFrom} → ${payment.periodTo}`;
    const dates = trips.map((t) => t.date).filter(Boolean).sort();
    if (dates.length === 0) return "—";
    return `${dates[0]} → ${dates[dates.length - 1]}`;
  })();

  const handleDownload = async () => {
    if (!printRef.current) return;
    setBusy("download");
    try {
      const dataUrl = await toPng(printRef.current, { backgroundColor: "#ffffff", pixelRatio: 2 });
      const link = document.createElement("a");
      link.download = `transporte_${carrier?.alias || "resumen"}_${payment.id}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      toast.error("Error al generar imagen: " + (err.message || err));
    } finally {
      setBusy("");
    }
  };

  const handleCopy = async () => {
    if (!printRef.current) return;
    setBusy("copy");
    try {
      const blob = await toBlob(printRef.current, { backgroundColor: "#ffffff", pixelRatio: 2 });
      if (!blob) throw new Error("No se pudo generar la imagen");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast.success("Imagen copiada al portapapeles");
    } catch (err) {
      toast.error("Error al copiar: " + (err.message || err));
    } finally {
      setBusy("");
    }
  };

  // Edita inline el `amount` de una vuelta. Optimista: actualiza el state
  // local primero, después escribe a Firestore (trip.amount + payment.total).
  // Si Firestore falla, recargamos los trips desde la fuente.
  const handleAmountChange = async (tripId, newAmount) => {
    if (payment.status === "paid") return;
    setSavingTripId(tripId);
    const nextTrips = trips.map((t) => (t.id === tripId ? { ...t, amount: Number(newAmount) || 0 } : t));
    setTrips(nextTrips);
    const newTotal = nextTrips.reduce((s, t) => s + (Number(t.amount) || 0), 0);
    try {
      await tripsService.update(tripId, { amount: Number(newAmount) || 0 });
      await paymentsService.updateTotal(payment.id, newTotal);
      if (onChanged) await onChanged();
    } catch (err) {
      toast.error("Error al guardar: " + (err.message || err));
      try {
        const all = await tripsService.listByCarrier(payment.carrierId);
        const filtered = all
          .filter((t) => (payment.tripIds || []).includes(t.id))
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        setTrips(filtered);
      } catch { /* noop */ }
    } finally {
      setSavingTripId(null);
    }
  };

  const handlePrint = () => {
    if (!printRef.current) return;
    const html = printRef.current.outerHTML;
    const win = window.open("", "_blank", "width=900,height=700");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>Resumen Transporte</title>
      <style>
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
        html, body { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 20px; color: #000; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #999; padding: 6px 8px; font-size: 12px; }
        thead th { background: #92d050 !important; text-align: left; }
        .month-tag { background: #e6c0e0 !important; padding: 2px 8px; font-weight: 600; display: inline-block; }
        .tot-row td, tr.tot-row td { background: #c6efce !important; font-weight: 700; }
        .num { text-align: right; font-variant-numeric: tabular-nums; }
        @media print {
          @page { size: landscape; margin: 12mm; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
        }
      </style>
    </head><body>${html}</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 250);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Resumen — ${carrier?.alias || payment.carrierId}`}
      size="xl"
      footer={
        <>
          <button onClick={onClose} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
            Cerrar
          </button>
          <button
            onClick={handleCopy}
            disabled={busy === "copy"}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
          >
            {busy === "copy" ? "Copiando..." : "📋 Copiar imagen"}
          </button>
          <button
            onClick={handleDownload}
            disabled={busy === "download"}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
          >
            {busy === "download" ? "Descargando..." : "📥 Descargar PNG"}
          </button>
          <button
            onClick={handlePrint}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
          >
            🖨 Imprimir
          </button>
          {!isPaid && (
            <button
              onClick={() => setEditMode((v) => !v)}
              className={`rounded-md border px-3 py-1.5 text-sm ${editMode ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : "border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]"}`}
              title="Editar valores de cada vuelta del resumen"
            >
              {editMode ? "✓ Listo" : "✏️ Editar precios"}
            </button>
          )}
          {/* Marcar pagado / Revertir movieron a la pestaña "Quincenas".
              Desde acá solo se crea, edita o elimina el resumen suelto. */}
          {!isPaid && (
            <button
              onClick={onDelete}
              className="rounded-md border border-[var(--color-danger)] px-3 py-1.5 text-sm text-[var(--color-danger)]"
            >
              Eliminar
            </button>
          )}
        </>
      }
    >
      <div className="mb-3 flex items-center justify-between text-sm">
        <span className={isPaid ? "font-medium text-[var(--color-success)]" : "font-medium text-[var(--color-warning)]"}>
          {isPaid ? "Pagado" : "Pendiente"}
        </span>
        <span className="text-[var(--color-muted)]">{periodLabel}</span>
        <span className="font-semibold tabular-nums">
          {fmtCurrency(trips.reduce((s, t) => s + (Number(t.amount) || 0), 0))}
          {savingTripId && <span className="ml-2 text-xs text-[var(--color-muted)]">guardando…</span>}
        </span>
      </div>

      {loading ? (
        <div className="py-6 text-center text-sm text-[var(--color-muted)]">Cargando...</div>
      ) : (
        <PrintableSummary
          ref={printRef}
          payment={payment}
          carrier={carrier}
          trips={trips}
          editable={editMode && !isPaid}
          onAmountChange={handleAmountChange}
          periodLabel={periodLabel}
          faenaById={faenaById}
          subfaenaById={subfaenaById}
          cycleById={cycleById}
        />
      )}

      {payment.notes && (
        <div className="mt-3 rounded-md bg-[var(--color-surface-2)] p-2 text-xs">
          <span className="text-[var(--color-muted)]">Notas: </span>
          {payment.notes}
        </div>
      )}
    </Modal>
  );
}

const MONTH_NAMES = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];
const DAY_NAMES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

function dateLabel(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return dateStr;
  return `${String(d.getDate()).padStart(2, "0")}-${MONTH_NAMES[d.getMonth()].slice(0, 3).toLowerCase()}`;
}

function monthOfTrips(trips) {
  if (!trips.length) return "";
  const months = new Set(trips.map((t) => Number(t.date?.slice(5, 7))).filter((m) => !isNaN(m)));
  if (months.size === 1) return MONTH_NAMES[[...months][0] - 1];
  return "";
}

const PrintableSummary = forwardRef(function PrintableSummary(
  { payment, carrier, trips, periodLabel, faenaById, subfaenaById, cycleById, editable = false, onAmountChange },
  ref,
) {
  const month = monthOfTrips(trips);
  const total = trips.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const inputStyle = {
    width: 90,
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    border: "1px solid #ccc",
    borderRadius: 3,
    padding: "1px 4px",
    background: "#fffbeb",
    fontSize: 12,
  };

  return (
    <div ref={ref} style={{ background: "#ffffff", color: "#000", padding: 16, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div style={{ marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>DETALLE TRANSPORTE</div>
        {month && (
          <div className="month-tag" style={{ background: "#e6c0e0", padding: "4px 12px", fontWeight: 700, fontSize: 14 }}>
            {month}
          </div>
        )}
        <div style={{ fontSize: 12, color: "#444" }}>{periodLabel}</div>
      </div>
      <div style={{ marginBottom: 6, fontSize: 13, fontWeight: 700, textTransform: "uppercase" }}>
        {(carrier?.name || carrier?.alias || "").toUpperCase()}
      </div>

      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ background: "#92d050" }}>
            <th style={cellH}>FECHA</th>
            <th style={cellH}>Vehículo</th>
            <th style={cellH}>N° vueltas</th>
            <th style={cellH}>LUGAR</th>
            <th style={cellH}>DESTINO</th>
            <th style={cellH}>Labor</th>
            <th style={{ ...cellH, textAlign: "right" }}>Valor</th>
            <th style={cellH}>Observación</th>
          </tr>
        </thead>
        <tbody>
          {trips.map((t) => {
            const fa = faenaById?.get(t.faenaId);
            const sb = subfaenaById?.get(t.subfaenaId);
            const cy = cycleById?.get(t.cycleId);
            const labor = [fa?.name, sb?.name].filter(Boolean).join(" / ") || cy?.label || "—";
            return (
              <tr key={t.id}>
                <td style={cell}>{dateLabel(t.date)}</td>
                <td style={cell}>{t.vehicleAlias || "—"}</td>
                <td style={{ ...cell, textAlign: "center" }}>{t.qty}</td>
                <td style={cell}>{t.lugar || ""}</td>
                <td style={cell}>{t.destino || ""}</td>
                <td style={cell}>{labor}</td>
                <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums", padding: editable ? 3 : "5px 8px" }}>
                  {editable ? (
                    <input
                      type="number"
                      defaultValue={Number(t.amount) || 0}
                      onBlur={(e) => {
                        const v = e.target.value === "" ? 0 : Number(e.target.value);
                        if (v !== Number(t.amount)) onAmountChange && onAmountChange(t.id, v);
                      }}
                      style={inputStyle}
                    />
                  ) : (
                    fmtCurrency(t.amount)
                  )}
                </td>
                <td style={cell}>
                  {t.personCount != null ? `${t.personCount} PERS` : ""}
                  {t.kind === "approach" ? (t.personCount != null ? " · " : "") + "acercamiento" : ""}
                  {t.notes ? (t.personCount != null || t.kind === "approach" ? " · " : "") + t.notes : ""}
                </td>
              </tr>
            );
          })}
          <tr style={{ background: "#c6efce" }}>
            <td style={cell} colSpan={6}></td>
            <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(total)}</td>
            <td style={cell}></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
});

const cellH = {
  border: "1px solid #555",
  padding: "6px 8px",
  fontSize: 12,
  fontWeight: 700,
  textAlign: "left",
};
const cell = {
  border: "1px solid #999",
  padding: "5px 8px",
  fontSize: 12,
};

// ============================================================
// FAENA BATCH TAB — pick cycles, generate one payment per carrier
// ============================================================

function FaenaBatchTab() {
  const toast = useToast();
  const { carriers } = useCarriers();
  const [step, setStep] = useState(1); // 1 picker, 2 preview
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [faenas, setFaenas] = useState([]);
  const [subfaenas, setSubfaenas] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [allTrips, setAllTrips] = useState([]); // pending trips for active cycles
  const [selectedCycleIds, setSelectedCycleIds] = useState(() => new Set());
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [carrierItems, setCarrierItems] = useState([]); // [{carrier, trips, total, include, expanded}]

  const load = async () => {
    setLoading(true);
    try {
      const [f, s, c, pendingT] = await Promise.all([
        faenasService.list({ order: ["name", "asc"], cache: true, persist: true, ttl: 10 * 60 * 1000 }),
        subfaenasService.list({ order: ["name", "asc"], cache: true, persist: true, ttl: 10 * 60 * 1000 }),
        cyclesService.list({ order: ["createdAt", "desc"], cache: true, persist: true, ttl: 5 * 60 * 1000 }),
        tripsService.listPendingUnlinked(),
      ]);
      setFaenas(f);
      setSubfaenas(s);
      setCycles(c);
      // Filter to active cycles only (the server-side query already gave us pending+unlinked).
      const activeCycleIds = new Set(c.filter((x) => x.status !== "closed").map((x) => x.id));
      setAllTrips(pendingT.filter((t) => activeCycleIds.has(t.cycleId)));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const subfaenaName = (id) => subfaenas.find((s) => s.id === id)?.name || "";

  const activeByFaena = useMemo(() => {
    const groups = new Map();
    for (const f of faenas) groups.set(f.id, { faena: f, cycles: [] });
    for (const c of cycles) {
      if (c.status === "closed") continue;
      const g = groups.get(c.faenaId);
      if (g) g.cycles.push(c);
    }
    return [...groups.values()].filter((g) => g.cycles.length > 0);
  }, [faenas, cycles]);

  const inDateRange = (date) =>
    (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo);

  const tripsInRange = useMemo(
    () => allTrips.filter((t) => inDateRange(t.date)),
    [allTrips, dateFrom, dateTo],
  );

  const cycleStats = useMemo(() => {
    const stats = {};
    for (const t of tripsInRange) {
      const cid = t.cycleId;
      if (!stats[cid]) stats[cid] = { total: 0, count: 0 };
      stats[cid].total += Number(t.amount) || 0;
      stats[cid].count += 1;
    }
    return stats;
  }, [tripsInRange]);

  const toggleCycle = (id) => {
    setSelectedCycleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const buildPreview = () => {
    if (selectedCycleIds.size === 0) return;
    const trips = tripsInRange.filter((t) => selectedCycleIds.has(t.cycleId));
    const byCarrier = new Map();
    for (const t of trips) {
      if (!byCarrier.has(t.carrierId)) {
        byCarrier.set(t.carrierId, { carrierId: t.carrierId, trips: [], total: 0 });
      }
      const e = byCarrier.get(t.carrierId);
      e.trips.push(t);
      e.total += Number(t.amount) || 0;
    }
    const list = [...byCarrier.values()].map((e) => {
      const carrier = carriers.find((c) => c.id === e.carrierId);
      return {
        ...e,
        carrier,
        name: carrier?.name || "(transportista eliminado)",
        alias: carrier?.alias || "—",
        include: true,
        expanded: false,
      };
    }).sort((a, b) => (a.alias || "").localeCompare(b.alias || ""));
    setCarrierItems(list);
    setStep(2);
  };

  const updateItem = (carrierId, patch) =>
    setCarrierItems((prev) => prev.map((p) => (p.carrierId === carrierId ? { ...p, ...patch } : p)));

  const removeTrip = (carrierId, tripId) =>
    setCarrierItems((prev) =>
      prev.map((p) => {
        if (p.carrierId !== carrierId) return p;
        const trips = p.trips.filter((t) => t.id !== tripId);
        const total = trips.reduce((s, t) => s + (Number(t.amount) || 0), 0);
        return { ...p, trips, total };
      }),
    );

  const totalSelected = useMemo(
    () => carrierItems.filter((p) => p.include).reduce((s, p) => s + p.total, 0),
    [carrierItems],
  );
  const includedCount = useMemo(() => carrierItems.filter((p) => p.include).length, [carrierItems]);

  const generate = async () => {
    const items = carrierItems.filter((p) => p.include && p.trips.length > 0);
    if (items.length === 0) {
      toast.warning("No hay transportistas con vueltas para pagar.");
      return;
    }
    setBusy(true);
    try {
      const cycleIds = [...selectedCycleIds];
      let created = 0;
      for (const it of items) {
        const datesSorted = it.trips.map((t) => t.date).sort();
        await paymentsService.createSummary({
          carrierId: it.carrierId,
          periodFrom: datesSorted[0] || null,
          periodTo: datesSorted[datesSorted.length - 1] || null,
          groupBy: "day",
          tripIds: it.trips.map((t) => t.id),
          total: it.total,
          notes: `Pago por faena · ${cycleIds.length} ciclo(s)`,
        });
        created += 1;
      }
      toast.success(`Se generaron ${created} resúmenes de pago.`);
      setSelectedCycleIds(new Set());
      setCarrierItems([]);
      setStep(1);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="flex h-40 items-center justify-center text-[var(--color-muted)]">Cargando...</div>;
  }

  if (step === 1) {
    if (activeByFaena.length === 0) {
      return (
        <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] text-[var(--color-muted)]">
          No hay ciclos activos.
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">Desde</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">Hasta</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
            />
          </div>
          {(dateFrom || dateTo) && (
            <button
              onClick={() => { setDateFrom(""); setDateTo(""); }}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs hover:bg-[var(--color-accent-soft)]"
            >
              Limpiar fechas
            </button>
          )}
          <div className="ml-auto text-xs text-[var(--color-muted)]">
            {tripsInRange.length} vuelta(s) en rango
          </div>
        </div>

        <div className="space-y-3">
          {activeByFaena.map(({ faena, cycles }) => (
            <div key={faena.id} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
              <div className="border-b border-[var(--color-border)] px-4 py-2 text-sm font-semibold">
                {faena.name}
              </div>
              <div className="divide-y divide-[var(--color-border)]">
                {cycles.map((c) => {
                  const sub = subfaenaName(c.subfaenaId);
                  const isSelected = selectedCycleIds.has(c.id);
                  const stat = cycleStats[c.id] || { total: 0, count: 0 };
                  const noPending = stat.count === 0;
                  return (
                    <label
                      key={c.id}
                      className={`flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-[var(--color-accent-soft)] ${
                        noPending ? "opacity-60" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleCycle(c.id)}
                        disabled={noPending && !isSelected}
                        className="h-4 w-4"
                      />
                      <div className="flex-1 text-sm">
                        <div className="font-medium">{c.label || c.id}</div>
                        {sub && <div className="text-xs text-[var(--color-muted)]">{sub}</div>}
                      </div>
                      <div className="text-right text-xs">
                        <div className={noPending ? "text-[var(--color-muted)]" : "font-semibold text-[var(--color-accent)]"}>
                          Pendiente: {fmtCurrency(stat.total)}
                        </div>
                        {stat.count > 0 && (
                          <div className="text-[var(--color-muted)]">{stat.count} vuelta(s)</div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="sticky bottom-0 flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
          <div className="text-sm text-[var(--color-muted)]">
            {selectedCycleIds.size} ciclo(s) seleccionado(s)
          </div>
          <button
            onClick={buildPreview}
            disabled={selectedCycleIds.size === 0}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
          >
            Continuar →
          </button>
        </div>
      </div>
    );
  }

  // step 2 — preview
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <button
          onClick={() => setStep(1)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
        >
          ← Volver
        </button>
        <div className="ml-auto text-sm">
          <span className="text-[var(--color-muted)]">{includedCount} transportista(s) · </span>
          <span className="font-semibold">{fmtCurrency(totalSelected)}</span>
        </div>
        <button
          onClick={generate}
          disabled={busy || includedCount === 0}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
        >
          {busy ? "Generando..." : `Generar ${includedCount} resumen(es)`}
        </button>
      </div>

      {carrierItems.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] text-[var(--color-muted)]">
          No hay vueltas pendientes en los ciclos elegidos.
        </div>
      ) : (
        <div className="space-y-2">
          {carrierItems.map((it) => (
            <div key={it.carrierId} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
              <div className="flex items-center gap-3 px-4 py-2">
                <input
                  type="checkbox"
                  checked={it.include}
                  onChange={(e) => updateItem(it.carrierId, { include: e.target.checked })}
                  className="h-4 w-4"
                />
                <button
                  onClick={() => updateItem(it.carrierId, { expanded: !it.expanded })}
                  className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  title="Ver vueltas"
                >
                  {it.expanded ? "▾" : "▸"}
                </button>
                <div className="flex-1 text-sm">
                  <div className="font-medium">{it.alias} <span className="text-xs text-[var(--color-muted)]">· {it.name}</span></div>
                  <div className="text-xs text-[var(--color-muted)]">{it.trips.length} vuelta(s)</div>
                </div>
                <div className="font-semibold">{fmtCurrency(it.total)}</div>
              </div>
              {it.expanded && (
                <div className="border-t border-[var(--color-border)]">
                  <table className="w-full text-sm">
                    <thead className="bg-[var(--color-surface-2)] text-left text-[var(--color-muted)]">
                      <tr>
                        <th className="px-3 py-1.5 text-xs">Fecha</th>
                        <th className="px-3 py-1.5 text-xs">Vehículo</th>
                        <th className="px-3 py-1.5 text-xs">Lugar → Destino</th>
                        <th className="px-3 py-1.5 text-xs">Tipo</th>
                        <th className="px-3 py-1.5 text-right text-xs">Cant.</th>
                        <th className="px-3 py-1.5 text-right text-xs">Tarifa</th>
                        <th className="px-3 py-1.5 text-right text-xs">Monto</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {it.trips.map((t) => (
                        <tr key={t.id} className="border-t border-[var(--color-border)]">
                          <td className="px-3 py-1.5 font-mono text-xs">{t.date}</td>
                          <td className="px-3 py-1.5 text-xs">{t.vehicleAlias || "—"}</td>
                          <td className="px-3 py-1.5 text-xs text-[var(--color-muted)]">
                            {t.lugar || "—"} → {t.destino || "—"}
                          </td>
                          <td className="px-3 py-1.5 text-xs">{t.kind === "approach" ? "Acerc." : "Vuelta"}</td>
                          <td className="px-3 py-1.5 text-right text-xs tabular-nums">{t.qty}</td>
                          <td className="px-3 py-1.5 text-right text-xs tabular-nums">{fmtCurrency(t.rate)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{fmtCurrency(t.amount)}</td>
                          <td className="px-3 py-1.5">
                            <button
                              onClick={() => removeTrip(it.carrierId, t.id)}
                              title="Quitar de este pago"
                              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// PAYROLLS (QUINCENAS) TAB
// ============================================================
//
// Una "quincena" es un payroll que agrupa N resúmenes (`transportPayments`)
// de varios transportistas. No es estricto a 15 días — es un agrupamiento
// con nombre + rango opcional. Es la vista PRINCIPAL para pagar: cada item
// (resumen) se puede marcar pagado individual o todos juntos vía el botón
// "Marcar quincena pagada". Toda acción de pago requiere doble confirm
// (tipear "Pagada" en un input) para evitar taps accidentales.

function PayrollsTab() {
  const toast = useToast();
  const { carriers } = useCarriers();
  const carriersById = useMemo(() => new Map(carriers.map((c) => [c.id, c])), [carriers]);

  const [payrolls, setPayrolls] = useState([]);
  const [payments, setPayments] = useState([]);
  // Para el flujo "Nueva quincena auto" necesitamos faenas activas (para los
  // chips de filtrado) y vueltas pending sin paymentId (las "sueltas" desde
  // las que se arman los resúmenes).
  const [faenas, setFaenas] = useState([]);
  const [pendingTrips, setPendingTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmPay, setConfirmPay] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [pr, py, fa, pt] = await Promise.all([
        transportPayrollsService.listAll(),
        paymentsService.listAll(),
        faenasService.list({ cache: true, ttl: 60_000 }),
        tripsService.listPendingUnlinked(),
      ]);
      const sortDesc = (a, b) => {
        const ta = a.createdAt?.toMillis?.() ?? a.createdAt?.seconds ?? 0;
        const tb = b.createdAt?.toMillis?.() ?? b.createdAt?.seconds ?? 0;
        return tb - ta;
      };
      setPayrolls(pr.sort(sortDesc));
      setPayments(py);
      setFaenas(fa.filter((f) => !f.deleted));
      // Solo las vueltas no asignadas a ningún resumen — son las elegibles
      // para entrar a una quincena nueva.
      setPendingTrips(pt.filter((t) => !t.paymentId));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const paymentsById = useMemo(() => new Map(payments.map((p) => [p.id, p])), [payments]);

  const looseSummaries = useMemo(
    () => payments.filter((p) => p.status !== "paid" && !p.payrollId),
    [payments],
  );

  const askMarkPayrollPaid = (payroll) => {
    setConfirmPay({
      verb: "Pagada",
      label: `Marcar la quincena "${payroll.name}" como PAGADA. Esto marca todos sus resúmenes (${(payroll.paymentIds || []).length}) y sus vueltas como pagados.`,
      onConfirm: async () => {
        await transportPayrollsService.markPaid(payroll.id);
        setConfirmPay(null);
        await load();
      },
    });
  };
  const askRevertPayroll = (payroll) => {
    setConfirmPay({
      verb: "Revertir",
      label: `Revertir el pago de la quincena "${payroll.name}". Esto vuelve a pendiente todos los resúmenes y vueltas.`,
      onConfirm: async () => {
        await transportPayrollsService.revertPaid(payroll.id);
        setConfirmPay(null);
        await load();
      },
    });
  };
  const askMarkItemPaid = (payment) => {
    setConfirmPay({
      verb: "Pagada",
      label: `Marcar el resumen "${carriersById.get(payment.carrierId)?.alias || payment.carrierId}" (${fmtCurrency(payment.total)}) como pagado.`,
      onConfirm: async () => {
        await paymentsService.markPaid(payment.id);
        setConfirmPay(null);
        await load();
      },
    });
  };
  const askRevertItem = (payment) => {
    setConfirmPay({
      verb: "Revertir",
      label: `Revertir el pago del resumen "${carriersById.get(payment.carrierId)?.alias || payment.carrierId}".`,
      onConfirm: async () => {
        await paymentsService.revertPaid(payment.id);
        setConfirmPay(null);
        await load();
      },
    });
  };

  const detail = detailId ? payrolls.find((p) => p.id === detailId) : null;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-[var(--color-muted)]">
          Quincenas — agrupan resúmenes de varios transportistas para pagar en bloque.
        </div>
        <button
          onClick={() => setCreating(true)}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
        >
          + Nueva quincena
        </button>
      </div>

      {loading ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] py-10 text-center text-sm text-[var(--color-muted)]">
          Cargando...
        </div>
      ) : payrolls.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] py-10 text-center text-sm text-[var(--color-muted)]">
          Aún no hay quincenas. Creá la primera con + Nueva quincena.
        </div>
      ) : (
        <div className="space-y-2">
          {payrolls.map((p) => {
            const isPaid = p.status === "paid";
            const items = (p.paymentIds || []).map((pid) => paymentsById.get(pid)).filter(Boolean);
            const paidCount = items.filter((it) => it.status === "paid").length;
            const period = (p.periodFrom || p.periodTo) ? `${p.periodFrom || "?"} → ${p.periodTo || "?"}` : "—";
            return (
              <div
                key={p.id}
                onClick={() => setDetailId(p.id)}
                className="flex cursor-pointer items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 hover:border-[var(--color-accent)]"
              >
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  isPaid
                    ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                    : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
                }`}>
                  {isPaid ? "Pagada" : "Pendiente"}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-[var(--color-muted)]">{period}</div>
                </div>
                <div className="text-right text-xs">
                  <div className="text-[var(--color-muted)]">
                    {items.length} resumen{items.length === 1 ? "" : "es"} · {paidCount} pagado{paidCount === 1 ? "" : "s"}
                  </div>
                  <div className="font-semibold tabular-nums">{fmtCurrency(p.total)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {creating && (
        <PayrollCreateModal
          carriers={carriers}
          carriersById={carriersById}
          faenas={faenas}
          pendingTrips={pendingTrips}
          looseSummaries={looseSummaries}
          onClose={() => setCreating(false)}
          onCreate={async ({ name, periodFrom, periodTo, notes, perCarrier, importSummaryIds }) => {
            try {
              // 1) Creamos un resumen nuevo por cada carrier con sus vueltas sueltas filtradas.
              // 2) Sumamos los resúmenes existentes seleccionados para importar.
              // 3) Creamos la quincena referenciando todos los paymentIds (los importados quedan
              //    linkeados via payrollId dentro de transportPayrollsService.create).
              const created = [];
              for (const it of perCarrier) {
                const datesSorted = it.trips.map((t) => t.date).filter(Boolean).sort();
                const summary = await paymentsService.createSummary({
                  carrierId: it.carrierId,
                  periodFrom: datesSorted[0] || periodFrom || null,
                  periodTo: datesSorted[datesSorted.length - 1] || periodTo || null,
                  groupBy: "day",
                  tripIds: it.trips.map((t) => t.id),
                  total: it.total,
                  notes: "",
                });
                created.push(summary.id);
              }
              await transportPayrollsService.create({
                name,
                periodFrom,
                periodTo,
                paymentIds: [...created, ...(importSummaryIds || [])],
                notes,
              });
              setCreating(false);
              await load();
            } catch (err) { toast.error(err?.message || "Error"); }
          }}
        />
      )}

      {detail && (
        <PayrollDetailModal
          payroll={detail}
          items={(detail.paymentIds || []).map((pid) => paymentsById.get(pid)).filter(Boolean)}
          carriersById={carriersById}
          looseSummaries={looseSummaries}
          onClose={() => setDetailId(null)}
          onEditMeta={() => setEditingId(detail.id)}
          onDeletePayroll={() => setConfirmDelete(detail)}
          onAddSummaries={async (ids) => { try { await transportPayrollsService.addPayments(detail.id, ids); await load(); } catch (err) { toast.error(err?.message || "Error"); } }}
          onRemoveSummary={async (pid) => { try { await transportPayrollsService.removePayments(detail.id, [pid]); await load(); } catch (err) { toast.error(err?.message || "Error"); } }}
          onMarkPayrollPaid={() => askMarkPayrollPaid(detail)}
          onRevertPayroll={() => askRevertPayroll(detail)}
          onMarkItemPaid={askMarkItemPaid}
          onRevertItem={askRevertItem}
        />
      )}

      {editingId && (
        <PayrollMetaEditModal
          payroll={payrolls.find((p) => p.id === editingId)}
          onClose={() => setEditingId(null)}
          onSave={async (patch) => {
            try { await transportPayrollsService.update(editingId, patch); setEditingId(null); await load(); }
            catch (err) { toast.error(err?.message || "Error"); }
          }}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Eliminar quincena"
        message={confirmDelete ? `¿Eliminar la quincena "${confirmDelete.name}"? Los resúmenes vuelven a estar sueltos (no se borran).` : ""}
        confirmLabel="Eliminar"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          try { await transportPayrollsService.delete(confirmDelete.id); setDetailId(null); setConfirmDelete(null); await load(); }
          catch (err) { toast.error(err?.message || "Error"); }
        }}
      />

      {confirmPay && (
        <TypeToConfirmModal
          word={confirmPay.verb}
          title={confirmPay.verb === "Revertir" ? "Revertir pago" : "Marcar como pagada"}
          message={confirmPay.label}
          confirmLabel={confirmPay.verb === "Revertir" ? "Revertir" : "Confirmar pago"}
          danger={confirmPay.verb === "Revertir"}
          onCancel={() => setConfirmPay(null)}
          onConfirm={confirmPay.onConfirm}
        />
      )}
    </div>
  );
}

// Modal de doble seguridad — el usuario debe escribir exactamente la palabra
// `word` (case-insensitive) para habilitar el botón de confirmar.
function TypeToConfirmModal({ word, title, message, confirmLabel, danger = false, onCancel, onConfirm }) {
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTyped(""); setBusy(false); }, [word]);
  const ok = typed.trim().toLowerCase() === String(word || "").toLowerCase();
  return (
    <Modal
      open
      onClose={() => !busy && onCancel()}
      title={title}
      size="md"
      footer={
        <>
          <button onClick={() => !busy && onCancel()} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm" disabled={busy}>
            Cancelar
          </button>
          <button
            onClick={async () => {
              if (!ok || busy) return;
              setBusy(true);
              try { await onConfirm(); } catch (err) { toast.error(err?.message || "Error"); setBusy(false); }
            }}
            disabled={!ok || busy}
            className={`rounded-md px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50 ${
              danger ? "bg-[var(--color-danger)] hover:opacity-90" : "bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]"
            }`}
          >
            {busy ? "Procesando..." : confirmLabel}
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm">{message}</p>
      <label className="block text-xs text-[var(--color-muted)]">
        Para confirmar, escribí <b>{word}</b> abajo:
      </label>
      <input
        autoFocus
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={word}
        disabled={busy}
        className={`mt-1 w-full rounded-md border bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] ${
          ok ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"
        }`}
      />
    </Modal>
  );
}

// Modal de creación de quincenas — flujo automático: elegís fechas, carriers
// y faenas (chips toggleables), y la quincena se arma con un resumen por
// carrier construido desde sus vueltas sueltas dentro de ese alcance.
function PayrollCreateModal({ carriers, carriersById, faenas, pendingTrips, looseSummaries, onClose, onCreate }) {
  const [name, setName] = useState("");
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");
  const [notes, setNotes] = useState("");
  // Carriers excluidos del armado automático (default vacío = todos incluidos).
  const [excludedCarrierIds, setExcludedCarrierIds] = useState(new Set());
  // excludedFaenaIds vacío = todas las faenas incluidas (default).
  const [excludedFaenaIds, setExcludedFaenaIds] = useState(new Set());
  // Resúmenes existentes seleccionados para importar (default vacío).
  const [importIds, setImportIds] = useState(new Set());
  const [busy, setBusy] = useState(false);

  const inRange = (d) =>
    (!periodFrom || d >= periodFrom) && (!periodTo || d <= periodTo);

  // Vueltas sueltas (sin paymentId) filtradas por rango + faenas. Estas son
  // las que van a alimentar los resúmenes nuevos que armaremos auto.
  const eligibleTrips = useMemo(() => {
    return pendingTrips.filter((t) => {
      if (!inRange(t.date)) return false;
      if (excludedFaenaIds.has(t.faenaId)) return false;
      return true;
    });
  }, [pendingTrips, periodFrom, periodTo, excludedFaenaIds]);

  // Auto-listado: agrupar vueltas elegibles por carrier.
  const tripsByCarrier = useMemo(() => {
    const m = new Map();
    for (const t of eligibleTrips) {
      if (!m.has(t.carrierId)) m.set(t.carrierId, []);
      m.get(t.carrierId).push(t);
    }
    return m;
  }, [eligibleTrips]);

  // Carriers auto-listados ordenados por alias. Todos incluidos por default
  // — el usuario puede destildar individualmente.
  const autoCarriers = useMemo(() => {
    return [...tripsByCarrier.entries()]
      .map(([carrierId, trips]) => {
        const total = trips.reduce((s, t) => s + (Number(t.amount) || 0), 0);
        return { carrierId, trips, total };
      })
      .sort((a, b) => {
        const ca = carriersById.get(a.carrierId);
        const cb = carriersById.get(b.carrierId);
        return (ca?.alias || "").localeCompare(cb?.alias || "");
      });
  }, [tripsByCarrier, carriersById]);

  // Lo que efectivamente se va a usar para crear resúmenes nuevos.
  const perCarrierToCreate = useMemo(
    () => autoCarriers.filter((c) => !excludedCarrierIds.has(c.carrierId)),
    [autoCarriers, excludedCarrierIds],
  );

  // Resúmenes existentes (sueltos, no pagados) — opcionalmente importables.
  // Filtro suave por overlap con el rango si está definido, para reducir ruido.
  const importableSummaries = useMemo(() => {
    return looseSummaries
      .filter((s) => {
        if (!periodFrom && !periodTo) return true;
        const sFrom = s.periodFrom || s.periodTo || null;
        const sTo = s.periodTo || s.periodFrom || null;
        if (!sFrom || !sTo) return true;
        // Hay overlap si NO (sTo < from || sFrom > to)
        if (periodFrom && sTo < periodFrom) return false;
        if (periodTo && sFrom > periodTo) return false;
        return true;
      })
      .sort((a, b) => {
        const ca = carriersById.get(a.carrierId);
        const cb = carriersById.get(b.carrierId);
        return (ca?.alias || "").localeCompare(cb?.alias || "");
      });
  }, [looseSummaries, periodFrom, periodTo, carriersById]);

  const importedTotal = useMemo(() => {
    return importableSummaries
      .filter((s) => importIds.has(s.id))
      .reduce((acc, s) => acc + (Number(s.total) || 0), 0);
  }, [importableSummaries, importIds]);

  const createdTotal = useMemo(
    () => perCarrierToCreate.reduce((s, p) => s + p.total, 0),
    [perCarrierToCreate],
  );

  const grandTotal = createdTotal + importedTotal;
  const totalSummaries = perCarrierToCreate.length + importIds.size;

  const toggleCarrier = (id) => {
    setExcludedCarrierIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const toggleFaena = (id) => {
    setExcludedFaenaIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const toggleImport = (id) => {
    setImportIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const includeAllCarriers = () => setExcludedCarrierIds(new Set());
  const excludeAllCarriers = () =>
    setExcludedCarrierIds(new Set(autoCarriers.map((c) => c.carrierId)));

  const onSubmit = async () => {
    if (!name.trim() || totalSummaries === 0) return;
    setBusy(true);
    try {
      await onCreate({
        name,
        periodFrom: periodFrom || null,
        periodTo: periodTo || null,
        notes,
        perCarrier: perCarrierToCreate,
        importSummaryIds: [...importIds],
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title="Nueva quincena"
      size="xl"
      footer={
        <>
          <button onClick={() => !busy && onClose()} disabled={busy} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
            Cancelar
          </button>
          <button
            onClick={onSubmit}
            disabled={!name.trim() || totalSummaries === 0 || busy}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {busy ? "Creando..." : `Crear quincena (${totalSummaries} resumen${totalSummaries === 1 ? "" : "es"} · ${fmtCurrency(grandTotal)})`}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-2 md:grid-cols-2">
          <label className="block">
            <span className="block text-xs text-[var(--color-muted)]">Nombre *</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='ej. "Quincena 1 de Mayo 2026"'
              className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <div className="grid grid-cols-2 gap-1">
            <label className="block">
              <span className="block text-xs text-[var(--color-muted)]">Desde</span>
              <input
                type="date"
                value={periodFrom}
                onChange={(e) => setPeriodFrom(e.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-[var(--color-muted)]">Hasta</span>
              <input
                type="date"
                value={periodTo}
                onChange={(e) => setPeriodTo(e.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
          </div>
        </div>
        <label className="block">
          <span className="block text-xs text-[var(--color-muted)]">Notas (opcional)</span>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>

        {/* Filtro de faenas — chips toggleables. Default todas activas. */}
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-medium uppercase tracking-wide text-[var(--color-muted)]">
              Faenas (filtra las vueltas sueltas elegibles)
            </span>
            {excludedFaenaIds.size > 0 && (
              <button
                onClick={() => setExcludedFaenaIds(new Set())}
                className="rounded px-1 py-0.5 text-[10px] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
              >
                Incluir todas
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {faenas.length === 0 && (
              <span className="text-[10px] text-[var(--color-muted)]">Sin faenas activas.</span>
            )}
            {faenas.map((f) => {
              const excluded = excludedFaenaIds.has(f.id);
              return (
                <button
                  key={f.id}
                  onClick={() => toggleFaena(f.id)}
                  className={`rounded-full border px-2 py-0.5 text-xs ${
                    excluded
                      ? "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] line-through"
                      : "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                  }`}
                >
                  {f.name}
                </button>
              );
            })}
          </div>
        </div>

        {/* Transportistas con vueltas sueltas en el rango — auto-listados. */}
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-medium uppercase tracking-wide text-[var(--color-muted)]">
              Resúmenes nuevos a crear · {perCarrierToCreate.length}/{autoCarriers.length} transportistas · {eligibleTrips.length} vueltas
            </span>
            {autoCarriers.length > 0 && (
              <div className="flex gap-1">
                {excludedCarrierIds.size > 0 && (
                  <button onClick={includeAllCarriers} className="rounded px-1 py-0.5 text-[10px] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]">
                    Incluir todos
                  </button>
                )}
                {excludedCarrierIds.size < autoCarriers.length && (
                  <button onClick={excludeAllCarriers} className="rounded px-1 py-0.5 text-[10px] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]">
                    Excluir todos
                  </button>
                )}
              </div>
            )}
          </div>
          {autoCarriers.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] py-4 text-center text-xs text-[var(--color-muted)]">
              No hay transportistas con vueltas sueltas en el rango seleccionado.
            </div>
          ) : (
            <div className="max-h-56 space-y-1 overflow-auto">
              {autoCarriers.map((row) => {
                const carrier = carriersById.get(row.carrierId);
                const included = !excludedCarrierIds.has(row.carrierId);
                return (
                  <label
                    key={row.carrierId}
                    className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${
                      included
                        ? "border-[var(--color-accent)] bg-[var(--color-surface)]"
                        : "border-[var(--color-border)] bg-[var(--color-surface)] opacity-60"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={included}
                      onChange={() => toggleCarrier(row.carrierId)}
                      className="h-4 w-4"
                    />
                    <span className="flex-1 truncate">
                      <span className="font-medium">{carrier?.alias || row.carrierId}</span>
                      <span className="ml-2 text-[10px] text-[var(--color-muted)]">
                        {row.trips.length} vuelta{row.trips.length === 1 ? "" : "s"}
                      </span>
                    </span>
                    <span className="tabular-nums">{fmtCurrency(row.total)}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Resúmenes existentes (sueltos, no pagados) que se pueden importar. */}
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-medium uppercase tracking-wide text-[var(--color-muted)]">
              Importar resúmenes existentes · {importIds.size}/{importableSummaries.length}
            </span>
            {importableSummaries.length > 0 && importIds.size > 0 && (
              <button
                onClick={() => setImportIds(new Set())}
                className="rounded px-1 py-0.5 text-[10px] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
              >
                Limpiar
              </button>
            )}
          </div>
          {importableSummaries.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] py-3 text-center text-[11px] text-[var(--color-muted)]">
              No hay resúmenes sueltos para importar.
            </div>
          ) : (
            <div className="max-h-44 space-y-1 overflow-auto">
              {importableSummaries.map((s) => {
                const carrier = carriersById.get(s.carrierId);
                const selected = importIds.has(s.id);
                const period = (s.periodFrom || s.periodTo) ? `${s.periodFrom || "?"} → ${s.periodTo || "?"}` : "—";
                return (
                  <label
                    key={s.id}
                    className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${
                      selected
                        ? "border-[var(--color-accent)] bg-[var(--color-surface)]"
                        : "border-[var(--color-border)] bg-[var(--color-surface)]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleImport(s.id)}
                      className="h-4 w-4"
                    />
                    <span className="flex-1 truncate">
                      <span className="font-medium">{carrier?.alias || s.carrierId}</span>
                      <span className="ml-2 text-[10px] text-[var(--color-muted)]">
                        {(s.tripIds || []).length} vuelta{(s.tripIds || []).length === 1 ? "" : "s"} · {period}
                      </span>
                    </span>
                    <span className="tabular-nums">{fmtCurrency(s.total || 0)}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {totalSummaries > 0 && (
          <div className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3 py-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium text-[var(--color-accent)]">
                Total quincena · {totalSummaries} resumen{totalSummaries === 1 ? "" : "es"}
              </span>
              <span className="font-semibold tabular-nums text-[var(--color-accent)]">{fmtCurrency(grandTotal)}</span>
            </div>
            <div className="mt-0.5 text-[10px] text-[var(--color-muted)]">
              {perCarrierToCreate.length > 0 && `${perCarrierToCreate.length} nuevo${perCarrierToCreate.length === 1 ? "" : "s"} (${fmtCurrency(createdTotal)})`}
              {perCarrierToCreate.length > 0 && importIds.size > 0 && " · "}
              {importIds.size > 0 && `${importIds.size} importado${importIds.size === 1 ? "" : "s"} (${fmtCurrency(importedTotal)})`}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function PayrollMetaEditModal({ payroll, onClose, onSave }) {
  const [name, setName] = useState(payroll?.name || "");
  const [periodFrom, setPeriodFrom] = useState(payroll?.periodFrom || "");
  const [periodTo, setPeriodTo] = useState(payroll?.periodTo || "");
  const [notes, setNotes] = useState(payroll?.notes || "");
  const [busy, setBusy] = useState(false);
  const onSubmit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onSave({ name, periodFrom: periodFrom || null, periodTo: periodTo || null, notes });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title="Editar quincena"
      size="md"
      footer={
        <>
          <button onClick={() => !busy && onClose()} disabled={busy} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
            Cancelar
          </button>
          <button onClick={onSubmit} disabled={!name.trim() || busy} className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy ? "Guardando..." : "Guardar"}
          </button>
        </>
      }
    >
      <div className="space-y-2">
        <label className="block">
          <span className="block text-xs text-[var(--color-muted)]">Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="block text-xs text-[var(--color-muted)]">Desde</span>
            <input type="date" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-2 text-sm outline-none focus:border-[var(--color-accent)]" />
          </label>
          <label className="block">
            <span className="block text-xs text-[var(--color-muted)]">Hasta</span>
            <input type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-2 text-sm outline-none focus:border-[var(--color-accent)]" />
          </label>
        </div>
        <label className="block">
          <span className="block text-xs text-[var(--color-muted)]">Notas</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]" />
        </label>
      </div>
    </Modal>
  );
}

const PrintablePayrollTable = forwardRef(function PrintablePayrollTable(
  { payroll, items, carriersById },
  ref,
) {
  const tripsCount = items.reduce((s, it) => s + (it.tripIds || []).length, 0);
  const total = items.reduce((s, it) => s + (Number(it.total) || 0), 0);
  const totalPaid = items.reduce((s, it) => s + (it.status === "paid" ? (Number(it.total) || 0) : 0), 0);
  const totalPending = total - totalPaid;
  const paidCount = items.filter((it) => it.status === "paid").length;
  const pendingCount = items.length - paidCount;
  const isPaid = payroll.status === "paid";
  const period = (payroll.periodFrom || payroll.periodTo)
    ? `${payroll.periodFrom || "?"} → ${payroll.periodTo || "?"}`
    : "—";
  return (
    <div ref={ref} style={{ background: "#ffffff", color: "#000", padding: 16, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div style={{ marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 15, textTransform: "uppercase" }}>
          DETALLE QUINCENA — {payroll.name}
        </div>
        <div style={{ fontSize: 12, color: "#444" }}>{period}</div>
      </div>
      <div style={{ marginBottom: 8, display: "flex", gap: 12, fontSize: 12, color: "#000" }}>
        <span><strong>Total:</strong> {fmtCurrency(total)}</span>
        {!isPaid && totalPending > 0 && pendingCount < items.length && (
          <>
            <span style={{ color: "#a16207" }}>
              <strong>Pendiente ({pendingCount}):</strong> {fmtCurrency(totalPending)}
            </span>
            <span style={{ color: "#15803d" }}>
              <strong>Pagado ({paidCount}):</strong> {fmtCurrency(totalPaid)}
            </span>
          </>
        )}
        {isPaid && <span style={{ color: "#15803d", fontWeight: 700 }}>QUINCENA PAGADA</span>}
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ background: "#92d050" }}>
            <th style={{ ...cellH, width: 36, textAlign: "center" }}>#</th>
            <th style={cellH}>TRANSPORTISTA</th>
            <th style={{ ...cellH, textAlign: "center" }}>VUELTAS</th>
            <th style={cellH}>PERÍODO</th>
            <th style={cellH}>ESTADO</th>
            <th style={{ ...cellH, textAlign: "right" }}>TOTAL</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => {
            const carrier = carriersById.get(it.carrierId);
            const itemPeriod = (it.periodFrom || it.periodTo) ? `${it.periodFrom || "?"} → ${it.periodTo || "?"}` : "—";
            const itemPaid = it.status === "paid";
            return (
              <tr key={it.id} style={itemPaid ? { background: "#f3f4f6", color: "#6b7280" } : undefined}>
                <td style={{ ...cell, textAlign: "center" }}>{i + 1}</td>
                <td style={cell}>{carrier?.alias || it.carrierId}</td>
                <td style={{ ...cell, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{(it.tripIds || []).length}</td>
                <td style={cell}>{itemPeriod}</td>
                <td style={{ ...cell, fontWeight: itemPaid ? 700 : 400, color: itemPaid ? "#15803d" : "#a16207" }}>
                  {itemPaid ? "Pagado" : "Pendiente"}
                </td>
                <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(it.total)}</td>
              </tr>
            );
          })}
          <tr style={{ background: "#c6efce" }}>
            <td style={{ ...cell, fontWeight: 700 }} colSpan={2}>TOTAL</td>
            <td style={{ ...cell, textAlign: "center", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{tripsCount}</td>
            <td style={cell} colSpan={2}></td>
            <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(total)}</td>
          </tr>
          {paidCount > 0 && pendingCount > 0 && !isPaid && (
            <tr style={{ background: "#f3f4f6" }}>
              <td style={{ ...cell, fontSize: 11, color: "#6b7280" }} colSpan={2}>Pagado ({paidCount})</td>
              <td style={cell} colSpan={3}></td>
              <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 11, color: "#6b7280" }}>
                {fmtCurrency(totalPaid)}
              </td>
            </tr>
          )}
          {pendingCount > 0 && !isPaid && (
            <tr style={{ background: "#fef3c7" }}>
              <td style={{ ...cell, fontWeight: 700, color: "#a16207" }} colSpan={2}>
                PENDIENTE ({pendingCount})
              </td>
              <td style={cell} colSpan={3}></td>
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "#a16207" }}>
                {fmtCurrency(totalPending)}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
});

function PayrollDetailModal({
  payroll, items, carriersById, looseSummaries,
  onClose, onEditMeta, onDeletePayroll, onAddSummaries, onRemoveSummary,
  onMarkPayrollPaid, onRevertPayroll, onMarkItemPaid, onRevertItem,
}) {
  const toast = useToast();
  const [addingOpen, setAddingOpen] = useState(false);
  const [adding, setAdding] = useState(new Set());
  const printRef = useRef(null);
  const [busy, setBusy] = useState("");
  const isPaid = payroll.status === "paid";
  // Totales por estado: la quincena puede tener resúmenes ya pagados
  // individualmente (con el botón "💰 Pagar" por ítem) aunque la quincena
  // todavía no se marque como pagada en bloque. Mostramos el pendiente
  // separado para que se vea cuánto queda por desembolsar.
  const totalAll = items.reduce((s, it) => s + (Number(it.total) || 0), 0);
  const totalPaid = items.reduce((s, it) => s + (it.status === "paid" ? (Number(it.total) || 0) : 0), 0);
  const totalPending = totalAll - totalPaid;
  const paidCount = items.filter((it) => it.status === "paid").length;
  const pendingCount = items.length - paidCount;

  const onAddConfirm = async () => {
    await onAddSummaries([...adding]);
    setAdding(new Set());
    setAddingOpen(false);
  };

  const handleDownload = async () => {
    if (!printRef.current) return;
    setBusy("download");
    try {
      const dataUrl = await toPng(printRef.current, { backgroundColor: "#ffffff", pixelRatio: 2 });
      const link = document.createElement("a");
      link.download = `quincena_${payroll.name.replace(/[^\w-]+/g, "_")}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      toast.error("Error al generar imagen: " + (err.message || err));
    } finally {
      setBusy("");
    }
  };

  const handleCopy = async () => {
    if (!printRef.current) return;
    setBusy("copy");
    try {
      const blob = await toBlob(printRef.current, { backgroundColor: "#ffffff", pixelRatio: 2 });
      if (!blob) throw new Error("No se pudo generar la imagen");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast.success("Imagen copiada al portapapeles");
    } catch (err) {
      toast.error("Error al copiar: " + (err.message || err));
    } finally {
      setBusy("");
    }
  };

  const handlePrint = () => {
    if (!printRef.current) return;
    const html = printRef.current.outerHTML;
    const win = window.open("", "_blank", "width=900,height=700");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>Quincena ${payroll.name}</title>
      <style>
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
        body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 20px; color: #000; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #999; padding: 6px 8px; font-size: 12px; }
        thead th { background: #92d050 !important; text-align: left; }
        @media print { @page { size: landscape; margin: 12mm; } }
      </style>
    </head><body>${html}</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 250);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`📅 ${payroll.name}`}
      size="xl"
      footer={
        <>
          <button onClick={onClose} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
            Cerrar
          </button>
          {!isPaid && (
            <>
              <button onClick={onEditMeta} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
                ✏️ Editar
              </button>
              <button onClick={onDeletePayroll} className="rounded-md border border-[var(--color-danger)] px-3 py-1.5 text-sm text-[var(--color-danger)]">
                Eliminar
              </button>
              <button onClick={onMarkPayrollPaid} className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]">
                💰 Marcar quincena pagada
              </button>
            </>
          )}
          {isPaid && (
            <button onClick={onRevertPayroll} className="rounded-md border border-[var(--color-warning)] px-3 py-1.5 text-sm text-[var(--color-warning)]">
              ↶ Revertir pago
            </button>
          )}
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-3 text-sm">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
          isPaid
            ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
            : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
        }`}>
          {isPaid ? "Pagada" : "Pendiente"}
        </span>
        {(payroll.periodFrom || payroll.periodTo) && (
          <span className="text-[var(--color-muted)]">
            {payroll.periodFrom || "?"} → {payroll.periodTo || "?"}
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span>
            <span className="text-[var(--color-muted)]">Total: </span>
            <span className="font-semibold tabular-nums">{fmtCurrency(totalAll)}</span>
          </span>
          {totalPending > 0 && !isPaid && (
            <span>
              <span className="text-[var(--color-muted)]">Pendiente: </span>
              <span className="font-semibold tabular-nums text-[var(--color-warning)]">{fmtCurrency(totalPending)}</span>
              {paidCount > 0 && (
                <span className="ml-1 text-[10px] text-[var(--color-muted)]">
                  ({paidCount} de {items.length} pagado{paidCount === 1 ? "" : "s"})
                </span>
              )}
            </span>
          )}
        </span>
      </div>
      {payroll.notes && (
        <div className="mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm">
          {payroll.notes}
        </div>
      )}

      {/* Renderizado off-screen del printable — capturado por html-to-image
          y `outerHTML` para imprimir. No visible para el usuario. */}
      <div style={{ position: "absolute", left: -99999, top: 0, pointerEvents: "none" }} aria-hidden>
        <PrintablePayrollTable ref={printRef} payroll={payroll} items={items} carriersById={carriersById} />
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Resúmenes ({items.length})</h4>
        <div className="flex flex-wrap gap-1">
          {items.length > 0 && (
            <>
              <button
                onClick={handleCopy}
                disabled={busy === "copy"}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
                title="Copiar tabla como imagen"
              >
                {busy === "copy" ? "Copiando..." : "📋 Copiar"}
              </button>
              <button
                onClick={handleDownload}
                disabled={busy === "download"}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
                title="Descargar tabla como PNG"
              >
                {busy === "download" ? "..." : "📥 PNG"}
              </button>
              <button
                onClick={handlePrint}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                title="Imprimir tabla"
              >
                🖨 Imprimir
              </button>
            </>
          )}
          {!isPaid && looseSummaries.length > 0 && (
            <button
              onClick={() => setAddingOpen((v) => !v)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
            >
              {addingOpen ? "▾" : "▸"} + Agregar resumen
            </button>
          )}
        </div>
      </div>

      {addingOpen && (
        <div className="mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
          <div className="mb-2 max-h-48 space-y-1 overflow-auto">
            {looseSummaries.map((s) => {
              const isSel = adding.has(s.id);
              const carrier = carriersById.get(s.carrierId);
              return (
                <button
                  key={s.id}
                  onClick={() => {
                    setAdding((prev) => {
                      const n = new Set(prev);
                      if (n.has(s.id)) n.delete(s.id); else n.add(s.id);
                      return n;
                    });
                  }}
                  className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs ${
                    isSel ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-border)] bg-[var(--color-surface)]"
                  }`}
                >
                  <input type="checkbox" checked={isSel} readOnly className="pointer-events-none" />
                  <span className="flex-1 truncate font-medium">{carrier?.alias || s.carrierId}</span>
                  <span className="tabular-nums">{fmtCurrency(s.total)}</span>
                </button>
              );
            })}
          </div>
          <button
            onClick={onAddConfirm}
            disabled={adding.size === 0}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
          >
            Agregar {adding.size} a la quincena
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] py-4 text-center text-xs text-[var(--color-muted)]">
          La quincena está vacía. Agregá resúmenes con el botón de arriba.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface-2)] text-xs uppercase tracking-wide text-[var(--color-muted)]">
              <tr>
                <th className="px-2 py-2 text-left">#</th>
                <th className="px-2 py-2 text-left">Transportista</th>
                <th className="px-2 py-2 text-center">Vueltas</th>
                <th className="hidden px-2 py-2 text-left md:table-cell">Período</th>
                <th className="px-2 py-2 text-left">Estado</th>
                <th className="px-2 py-2 text-right">Total</th>
                {!isPaid && <th className="px-2 py-2 text-right">Acciones</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => {
                const carrier = carriersById.get(it.carrierId);
                const itemPaid = it.status === "paid";
                const itemPeriod = (it.periodFrom || it.periodTo) ? `${it.periodFrom || "?"} → ${it.periodTo || "?"}` : "—";
                return (
                  <tr key={it.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
                    <td className="px-2 py-2 text-[var(--color-muted)] tabular-nums">{i + 1}</td>
                    <td className="px-2 py-2 font-medium">{carrier?.alias || it.carrierId}</td>
                    <td className="px-2 py-2 text-center tabular-nums">{(it.tripIds || []).length}</td>
                    <td className="hidden px-2 py-2 text-xs text-[var(--color-muted)] md:table-cell">{itemPeriod}</td>
                    <td className="px-2 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        itemPaid ? "bg-[var(--color-success-soft)] text-[var(--color-success)]" : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
                      }`}>
                        {itemPaid ? "Pagado" : "Pendiente"}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right font-semibold tabular-nums">{fmtCurrency(it.total)}</td>
                    {!isPaid && (
                      <td className="px-2 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          {!itemPaid && (
                            <>
                              <button
                                onClick={() => onMarkItemPaid(it)}
                                className="rounded-md bg-[var(--color-accent)] px-2 py-1 text-[10px] font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
                              >
                                💰 Pagar
                              </button>
                              <button
                                onClick={() => onRemoveSummary(it.id)}
                                title="Sacar de la quincena (vuelve a estar suelto)"
                                className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-danger)] hover:bg-[var(--color-accent-soft)]"
                              >
                                ✕
                              </button>
                            </>
                          )}
                          {itemPaid && (
                            <button
                              onClick={() => onRevertItem(it)}
                              className="rounded-md border border-[var(--color-warning)] px-2 py-1 text-[10px] text-[var(--color-warning)]"
                            >
                              ↶
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
              <tr className="border-t-2 border-[var(--color-border)] bg-[var(--color-surface-2)]">
                <td className="px-2 py-2 font-semibold" colSpan={2}>TOTAL</td>
                <td className="px-2 py-2 text-center font-semibold tabular-nums">
                  {items.reduce((s, it) => s + (it.tripIds || []).length, 0)}
                </td>
                <td className="hidden md:table-cell" />
                <td />
                <td className="px-2 py-2 text-right font-semibold tabular-nums">
                  {fmtCurrency(totalAll)}
                </td>
                {!isPaid && <td />}
              </tr>
              {paidCount > 0 && pendingCount > 0 && (
                <tr className="bg-[var(--color-surface)]">
                  <td className="px-2 py-1.5 text-xs text-[var(--color-muted)]" colSpan={2}>
                    Pagado ({paidCount})
                  </td>
                  <td />
                  <td className="hidden md:table-cell" />
                  <td />
                  <td className="px-2 py-1.5 text-right text-xs tabular-nums text-[var(--color-muted)]">
                    {fmtCurrency(totalPaid)}
                  </td>
                  {!isPaid && <td />}
                </tr>
              )}
              {pendingCount > 0 && !isPaid && (
                <tr className="bg-[var(--color-warning-soft)]">
                  <td className="px-2 py-2 text-sm font-semibold text-[var(--color-warning)]" colSpan={2}>
                    PENDIENTE ({pendingCount})
                  </td>
                  <td />
                  <td className="hidden md:table-cell" />
                  <td />
                  <td className="px-2 py-2 text-right text-sm font-semibold tabular-nums text-[var(--color-warning)]">
                    {fmtCurrency(totalPending)}
                  </td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
