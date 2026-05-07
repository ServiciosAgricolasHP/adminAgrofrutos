import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { toPng, toBlob } from "html-to-image";
import Modal from "../components/Modal";
import TextField from "../components/TextField";
import Select from "../components/Select";
import ConfirmDialog from "../components/ConfirmDialog";
import { useCarriers } from "../contexts/CarriersContext";
import { CARRIER_TYPES, validateVehicleAlias } from "../services/carriersService";
import {
  tripsService,
  paymentsService,
  TRIP_KINDS,
  groupTripsByDay,
  groupTripsByFaena,
} from "../services/transportsService";
import { faenasService, subfaenasService, cyclesService } from "../services";

const fmtCurrency = (v) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 }).format(
    Number(v) || 0,
  );

const TABS = [
  { value: "carriers", label: "Transportistas" },
  { value: "trips", label: "Vueltas" },
  { value: "byFaena", label: "Pago por faena" },
  { value: "payments", label: "Resúmenes / Pagos" },
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
    </div>
  );
}

// ============================================================
// CARRIERS TAB
// ============================================================

function CarriersTab() {
  const { carriers, addCarrier, updateCarrier, softDeleteCarrier, restoreCarrier } = useCarriers();
  const [edit, setEdit] = useState(null); // null | "new" | carrier
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
              className={`rounded-lg border bg-[var(--color-surface)] p-3 shadow-sm ${
                c.active === false ? "border-[var(--color-border)] opacity-60" : "border-[var(--color-border)]"
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-semibold">{c.alias}</div>
                  <div className="text-sm text-[var(--color-muted)]">{c.name}</div>
                </div>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    c.type === "own"
                      ? "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
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
              <div className="mt-3 flex justify-end gap-1">
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
          ))}
        </div>
      )}

      <CarrierEditModal open={!!edit} carrier={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSave={handleSave} />
    </div>
  );
}

function CarrierEditModal({ open, onClose, carrier, onSave }) {
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
    if (err) return alert(err);
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
  const { activeCarriers, carriers } = useCarriers();
  const [trips, setTrips] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [faenas, setFaenas] = useState([]);
  const [subfaenas, setSubfaenas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ carrierId: "", status: "", cycleId: "", faenaId: "" });

  const reload = async () => {
    setLoading(true);
    try {
      const [tripList, cyc, fa, sub] = await Promise.all([
        tripsService.listAll(),
        cyclesService.list({ cache: true }),
        faenasService.list({ cache: true }),
        subfaenasService.list({ cache: true }),
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
  }, []);

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

      {loading ? (
        <div className="py-8 text-center text-sm text-[var(--color-muted)]">Cargando...</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] py-8 text-center text-sm text-[var(--color-muted)]">
          Sin vueltas
        </div>
      ) : (
        <div className="overflow-auto rounded-md border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface-2)] text-left text-[var(--color-muted)]">
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
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                          pagado
                        </span>
                      ) : (
                        <span className="rounded bg-[var(--color-warning-soft)] px-1.5 py-0.5 text-[11px] text-[var(--color-warning)]">
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
  const { activeCarriers, carriers } = useCarriers();
  const [payments, setPayments] = useState([]);
  const [faenas, setFaenas] = useState([]);
  const [subfaenas, setSubfaenas] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);

  const reload = async () => {
    setLoading(true);
    try {
      const [list, fa, sub, cyc] = await Promise.all([
        paymentsService.listAll(),
        faenasService.list({ cache: true }),
        subfaenasService.list({ cache: true }),
        cyclesService.list({ cache: true }),
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
  }, []);

  const carrierById = useMemo(() => new Map(carriers.map((c) => [c.id, c])), [carriers]);
  const faenaById = useMemo(() => new Map(faenas.map((f) => [f.id, f])), [faenas]);
  const subfaenaById = useMemo(() => new Map(subfaenas.map((s) => [s.id, s])), [subfaenas]);
  const cycleById = useMemo(() => new Map(cycles.map((c) => [c.id, c])), [cycles]);
  const pending = payments.filter((p) => p.status === "pending");
  const paid = payments.filter((p) => p.status === "paid");

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button
          onClick={() => setGenerating(true)}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
        >
          + Generar resumen
        </button>
      </div>

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
        onGenerated={async () => {
          setGenerating(false);
          await reload();
        }}
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
          } catch (err) {
            alert(err.message || "Error");
          }
        }}
      />
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

function GenerateSummaryModal({ open, onClose, carriers, onGenerated }) {
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
                      <td className="px-2 py-1">{g.date || g.key}</td>
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

function PaymentDetailModal({ open, onClose, payment, carrier, faenaById, subfaenaById, cycleById, onPay, onRevert, onDelete }) {
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(false);
  const printRef = useRef(null);
  const [busy, setBusy] = useState("");

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
      alert("Error al generar imagen: " + (err.message || err));
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
      alert("Imagen copiada al portapapeles");
    } catch (err) {
      alert("Error al copiar: " + (err.message || err));
    } finally {
      setBusy("");
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
            <>
              <button
                onClick={onDelete}
                className="rounded-md border border-[var(--color-danger)] px-3 py-1.5 text-sm text-[var(--color-danger)]"
              >
                Eliminar
              </button>
              <button
                onClick={onPay}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
              >
                Marcar pagado
              </button>
            </>
          )}
          {isPaid && (
            <button
              onClick={onRevert}
              className="rounded-md border border-[var(--color-warning)] px-3 py-1.5 text-sm text-[var(--color-warning)]"
            >
              Revertir pago
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
        <span className="font-semibold tabular-nums">{fmtCurrency(payment.total)}</span>
      </div>

      {loading ? (
        <div className="py-6 text-center text-sm text-[var(--color-muted)]">Cargando...</div>
      ) : (
        <PrintableSummary
          ref={printRef}
          payment={payment}
          carrier={carrier}
          trips={trips}
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
  { payment, carrier, trips, periodLabel, faenaById, subfaenaById, cycleById },
  ref,
) {
  const month = monthOfTrips(trips);
  const total = trips.reduce((s, t) => s + (Number(t.amount) || 0), 0);

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
                <td style={{ ...cell, textAlign: "center" }}>{t.qty}</td>
                <td style={cell}>{t.lugar || ""}</td>
                <td style={cell}>{t.destino || ""}</td>
                <td style={cell}>{labor}</td>
                <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(t.amount)}</td>
                <td style={cell}>
                  {t.personCount != null ? `${t.personCount} PERS` : ""}
                  {t.kind === "approach" ? (t.personCount != null ? " · " : "") + "acercamiento" : ""}
                  {t.notes ? (t.personCount != null || t.kind === "approach" ? " · " : "") + t.notes : ""}
                </td>
              </tr>
            );
          })}
          <tr style={{ background: "#c6efce" }}>
            <td style={cell} colSpan={5}></td>
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
      const [f, s, c, allT] = await Promise.all([
        faenasService.list({ order: ["name", "asc"] }),
        subfaenasService.list({ order: ["name", "asc"] }),
        cyclesService.list({ order: ["createdAt", "desc"] }),
        tripsService.listAll(),
      ]);
      setFaenas(f);
      setSubfaenas(s);
      setCycles(c);
      // Pending, unlinked trips from active cycles only.
      const activeCycleIds = new Set(c.filter((x) => x.status !== "closed").map((x) => x.id));
      setAllTrips(
        allT.filter(
          (t) => t.status === "pending" && !t.paymentId && activeCycleIds.has(t.cycleId),
        ),
      );
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
      alert("No hay transportistas con vueltas para pagar.");
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
      alert(`Se generaron ${created} resúmenes de pago.`);
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
                    <thead className="bg-[var(--color-surface-2)] text-left">
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
                          <td className="px-3 py-1.5 text-right text-xs">{t.qty}</td>
                          <td className="px-3 py-1.5 text-right text-xs">{fmtCurrency(t.rate)}</td>
                          <td className="px-3 py-1.5 text-right">{fmtCurrency(t.amount)}</td>
                          <td className="px-3 py-1.5">
                            <button
                              onClick={() => removeTrip(it.carrierId, t.id)}
                              title="Quitar de este pago"
                              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
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
