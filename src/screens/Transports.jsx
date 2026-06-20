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
  // Filtro por tipo (all/own/contracted) y orden de la grilla.
  const [typeFilter, setTypeFilter] = useState("all");
  const [sortBy, setSortBy] = useState("owed_desc");

  // Métricas por transportista: cantidad de resúmenes pendientes, total
  // adeudado (suma de resúmenes pendientes + vueltas sueltas pendientes) y
  // total de vueltas pendientes (sueltas, sin resumen asignado).
  const [pendingPayments, setPendingPayments] = useState([]);
  const [pendingTrips, setPendingTrips] = useState([]);
  const [metricsLoading, setMetricsLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setMetricsLoading(true);
      try {
        const [payments, trips] = await Promise.all([
          paymentsService.listAll(),
          tripsService.listPendingUnlinked(),
        ]);
        if (cancelled) return;
        setPendingPayments(payments.filter((p) => p.status === "pending"));
        setPendingTrips(trips);
      } finally {
        if (!cancelled) setMetricsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const metricsByCarrier = useMemo(() => {
    const map = new Map();
    const ensure = (cid) => {
      if (!map.has(cid)) {
        map.set(cid, { pendingPaymentCount: 0, pendingPaymentTotal: 0, pendingTripCount: 0, pendingTripTotal: 0 });
      }
      return map.get(cid);
    };
    for (const p of pendingPayments) {
      const e = ensure(p.carrierId);
      e.pendingPaymentCount += 1;
      e.pendingPaymentTotal += Number(p.total) || 0;
    }
    for (const t of pendingTrips) {
      const e = ensure(t.carrierId);
      e.pendingTripCount += 1;
      e.pendingTripTotal += Number(t.amount) || 0;
    }
    return map;
  }, [pendingPayments, pendingTrips]);

  const totalsAll = useMemo(() => {
    let owed = 0, resumenes = 0, vueltas = 0;
    for (const [, m] of metricsByCarrier) {
      owed += m.pendingPaymentTotal + m.pendingTripTotal;
      resumenes += m.pendingPaymentCount;
      vueltas += m.pendingTripCount;
    }
    return { owed, resumenes, vueltas };
  }, [metricsByCarrier]);

  const visible = useMemo(() => {
    let list = showInactive ? carriers : carriers.filter((c) => c.active !== false);
    if (typeFilter !== "all") list = list.filter((c) => (c.type || "contracted") === typeFilter);
    const owedOf = (c) => {
      const m = metricsByCarrier.get(c.id);
      return m ? (m.pendingPaymentTotal + m.pendingTripTotal) : 0;
    };
    const arr = [...list];
    arr.sort((a, b) => {
      switch (sortBy) {
        case "owed_desc":
          return owedOf(b) - owedOf(a);
        case "alpha":
          return String(a.alias || "").localeCompare(String(b.alias || ""), "es");
        case "type":
          return String(a.type || "contracted").localeCompare(String(b.type || "contracted")) ||
            String(a.alias || "").localeCompare(String(b.alias || ""), "es");
        default:
          return 0;
      }
    });
    return arr;
  }, [carriers, showInactive, typeFilter, sortBy, metricsByCarrier]);

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
      {/* Tira de totales generales: resumenes pendientes y adeudado global */}
      {!metricsLoading && totalsAll.owed > 0 && (
        <div className="mb-3 grid grid-cols-3 gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5 text-xs">
          <div>
            <div className="text-[var(--color-muted)]">Adeudado total</div>
            <div className="mt-0.5 font-semibold text-base tabular-nums text-[var(--color-accent)]">{fmtCurrency(totalsAll.owed)}</div>
          </div>
          <div>
            <div className="text-[var(--color-muted)]">Resúmenes pendientes</div>
            <div className="mt-0.5 font-semibold text-base tabular-nums">{totalsAll.resumenes}</div>
          </div>
          <div>
            <div className="text-[var(--color-muted)]">Vueltas sueltas</div>
            <div className="mt-0.5 font-semibold text-base tabular-nums">{totalsAll.vueltas}</div>
          </div>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-border)] text-xs">
            <button
              onClick={() => setTypeFilter("all")}
              className={`px-2.5 py-1 ${typeFilter === "all" ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "bg-[var(--color-surface)] hover:bg-[var(--color-accent-soft)]"}`}
            >
              Todos ({carriers.length})
            </button>
            <button
              onClick={() => setTypeFilter("own")}
              className={`px-2.5 py-1 border-l border-[var(--color-border)] ${typeFilter === "own" ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "bg-[var(--color-surface)] hover:bg-[var(--color-accent-soft)]"}`}
            >
              🏠 Propios ({carriers.filter((c) => c.type === "own").length})
            </button>
            <button
              onClick={() => setTypeFilter("contracted")}
              className={`px-2.5 py-1 border-l border-[var(--color-border)] ${typeFilter === "contracted" ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "bg-[var(--color-surface)] hover:bg-[var(--color-accent-soft)]"}`}
            >
              🚚 Contratados ({carriers.filter((c) => (c.type || "contracted") === "contracted").length})
            </button>
          </div>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
            title="Ordenar por"
          >
            <option value="owed_desc">Mayor adeudado</option>
            <option value="alpha">Alfabético</option>
            <option value="type">Por tipo</option>
          </select>
          <label className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Mostrar inactivos
          </label>
        </div>
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
          {visible.map((c) => {
            const m = metricsByCarrier.get(c.id) || { pendingPaymentCount: 0, pendingPaymentTotal: 0, pendingTripCount: 0, pendingTripTotal: 0 };
            const owed = m.pendingPaymentTotal + m.pendingTripTotal;
            const hasDebt = owed > 0;
            const isOwn = c.type === "own";
            const isInactive = c.active === false;
            // Banda superior con color según tipo (propio = verde acento,
            // contratado = ámbar). Se atenúa para inactivos.
            const bandColor = isOwn ? "var(--color-accent)" : "#d97706";
            const bandSoft = isOwn ? "var(--color-accent-soft)" : "#fef3c7";
            return (
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
                className={`group relative cursor-pointer overflow-hidden rounded-lg border bg-[var(--color-surface)] shadow-sm transition-all hover:shadow-md ${
                  isInactive ? "border-[var(--color-border)] opacity-60" : "border-[var(--color-border)] hover:border-[var(--color-accent)]"
                }`}
                title="Ver vueltas del transportista"
                style={{ borderTop: `3px solid ${isInactive ? "var(--color-border)" : bandColor}` }}
              >
                <div className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm">{isOwn ? "🏠" : "🚚"}</span>
                        <div className="truncate font-semibold">{c.alias}</div>
                      </div>
                      <div className="truncate text-xs text-[var(--color-muted)]">{c.name}</div>
                    </div>
                    <span
                      className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                      style={{ background: bandSoft, color: bandColor }}
                    >
                      {isOwn ? "propio" : "contratado"}
                    </span>
                  </div>

                  {/* Grilla de métricas: adeudado destacado, resumenes y vueltas */}
                  <div className="mt-2.5 grid grid-cols-3 gap-1.5">
                    <div className={`rounded-md p-1.5 ${hasDebt ? "bg-[var(--color-warning-soft)]" : "bg-[var(--color-surface-2)]"}`}>
                      <div className="text-[9px] uppercase tracking-wide text-[var(--color-muted)]">Adeudado</div>
                      <div className={`mt-0.5 text-xs font-bold tabular-nums ${hasDebt ? "text-[var(--color-warning)]" : "text-[var(--color-muted)]"}`}>
                        {hasDebt ? fmtCurrency(owed) : "—"}
                      </div>
                    </div>
                    <div className="rounded-md bg-[var(--color-surface-2)] p-1.5">
                      <div className="text-[9px] uppercase tracking-wide text-[var(--color-muted)]">Resúmenes</div>
                      <div className="mt-0.5 text-xs font-bold tabular-nums">
                        {m.pendingPaymentCount > 0 ? m.pendingPaymentCount : "—"}
                      </div>
                    </div>
                    <div className="rounded-md bg-[var(--color-surface-2)] p-1.5">
                      <div className="text-[9px] uppercase tracking-wide text-[var(--color-muted)]">Vueltas</div>
                      <div className="mt-0.5 text-xs font-bold tabular-nums">
                        {m.pendingTripCount > 0 ? m.pendingTripCount : "—"}
                      </div>
                    </div>
                  </div>

                  {!isOwn && c.defaultRate > 0 && (
                    <div className="mt-2 text-[10px] text-[var(--color-muted)]">
                      Tarifa default · <span className="tabular-nums">{fmtCurrency(c.defaultRate)}</span>
                    </div>
                  )}

                  <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
                    {(c.vehicles || []).map((v) => (
                      <span key={v.alias} className="inline-flex items-center gap-0.5 rounded bg-[var(--color-surface-2)] px-1.5 py-0.5">
                        🚐 {v.alias}
                        {v.plate && <span className="text-[var(--color-muted)]">({v.plate})</span>}
                      </span>
                    ))}
                    {(c.vehicles || []).length === 0 && (
                      <span className="text-[var(--color-muted)] italic">sin vehículos</span>
                    )}
                  </div>
                </div>

                <div
                  className="flex items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="text-[10px] text-[var(--color-muted)] opacity-0 transition-opacity group-hover:opacity-100">
                    Click para ver vueltas →
                  </span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setEdit(c)}
                      className="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
                    >
                      Editar
                    </button>
                    {!isInactive ? (
                      <button
                        onClick={() => softDeleteCarrier(c.id)}
                        className="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
                      >
                        Desactivar
                      </button>
                    ) : (
                      <button
                        onClick={() => restoreCarrier(c.id)}
                        className="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-success)] hover:bg-[var(--color-accent-soft)]"
                      >
                        Restaurar
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
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
  // Default: rango últimos 3 meses (today - 90 días) → today. Reduce el
  // ruido de vueltas antiguas y la carga inicial. El usuario puede ampliar
  // o limpiar el rango cuando quiera ver todo.
  const defaultRange = () => {
    const today = new Date();
    const from = new Date(today);
    from.setMonth(from.getMonth() - 3);
    const iso = (d) => d.toISOString().slice(0, 10);
    return { from: iso(from), to: iso(today) };
  };
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Toggle para incluir vueltas ya pagadas. Por default solo pending — las
  // pagadas son las más numerosas y casi nunca se necesitan al abrir la
  // vista. Cuando se activa, hacemos un re-fetch que las trae todas.
  const [includePaid, setIncludePaid] = useState(false);
  const [editing, setEditing] = useState(null); // trip object o null
  const [confirmDel, setConfirmDel] = useState(null);

  const reload = async (opts = {}) => {
    if (!carrier?.id) return;
    const wantPaid = opts.includePaid ?? includePaid;
    setLoading(true);
    try {
      const [tripList, cyc, fa, sub] = await Promise.all([
        tripsService.listByCarrier(carrier.id, { onlyPending: !wantPaid }),
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
    if (open) {
      // Al abrir el modal: rango default últimos 3 meses, sin pagadas.
      const r = defaultRange();
      setDateFrom(r.from);
      setDateTo(r.to);
      setStatusFilter("");
      setIncludePaid(false);
      reload({ includePaid: false });
    } else {
      setEditing(null);
      setConfirmDel(null);
      setStatusFilter("");
      setDateFrom("");
      setDateTo("");
      setIncludePaid(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, carrier?.id]);

  // Cuando el usuario alterna "incluir pagadas" re-fetcheamos: la decisión
  // está acoplada al query del server (onlyPending), no es solo un filtro
  // cliente. El primer load ya se dispara en el useEffect de arriba; este
  // hook responde solo a cambios posteriores.
  const isFirstToggle = useRef(true);
  useEffect(() => {
    if (!open) return;
    if (isFirstToggle.current) { isFirstToggle.current = false; return; }
    reload({ includePaid });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includePaid]);

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
            <label className={`flex items-center gap-1 rounded-md border px-2 py-1 ${
              includePaid
                ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                : "border-[var(--color-border)] bg-[var(--color-surface-2)]"
            }`}>
              <input
                type="checkbox"
                checked={includePaid}
                onChange={(e) => setIncludePaid(e.target.checked)}
              />
              <span>{includePaid ? "✓ Pagadas incluidas" : "Incluir pagadas"}</span>
            </label>
            {includePaid && (
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
            )}
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
            <button
              type="button"
              onClick={() => {
                const r = defaultRange();
                setDateFrom(r.from);
                setDateTo(r.to);
              }}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
              title="Volver al rango default (últimos 3 meses)"
            >
              ⟲ 3 meses
            </button>
            <button
              type="button"
              onClick={() => { setDateFrom(""); setDateTo(""); }}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
              title="Ver todas las vueltas sin filtro de fecha"
            >
              ∞ Sin rango
            </button>
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
                ✕ Limpiar
              </button>
            )}
          </div>
          <div className="text-sm">
            <span className="text-[var(--color-muted)]">
              {filtered.length} vuelta{filtered.length === 1 ? "" : "s"} (
              {pendingCount} pend{includePaid ? ` · ${paidCount} pag` : ""}) ·{" "}
            </span>
            <span className="font-semibold tabular-nums">{fmtCurrency(totalAmount)}</span>
          </div>
        </div>

        {loading ? (
          <div className="py-8 text-center text-sm text-[var(--color-muted)]">Cargando...</div>
        ) : filtered.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] py-8 text-center text-sm text-[var(--color-muted)]">
            {trips.length === 0
              ? (includePaid
                  ? "Este transportista no tiene vueltas en el rango seleccionado"
                  : "Sin vueltas pendientes en el rango. Activá \"Incluir pagadas\" o ampliá el rango para ver más.")
              : "Sin vueltas para los filtros aplicados"}
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

  // Agrupado por transportista. Cada grupo trae el alias, el total, y el
  // desglose pendiente/pagado para que el header sea informativo sin tener
  // que expandir. Si la vuelta no tiene carrierId asociable se cae a un
  // grupo "Sin transportista" para no perder esas filas.
  const byCarrier = useMemo(() => {
    const groups = new Map();
    for (const t of filtered) {
      const cid = t.carrierId || "__none__";
      if (!groups.has(cid)) {
        const c = carrierById.get(t.carrierId);
        groups.set(cid, {
          carrierId: cid,
          alias: c?.alias || (cid === "__none__" ? "Sin transportista" : "—"),
          name: c?.name || "",
          trips: [],
          total: 0,
          pendingCount: 0,
          paidCount: 0,
          pendingTotal: 0,
        });
      }
      const g = groups.get(cid);
      g.trips.push(t);
      const amt = Number(t.amount) || 0;
      g.total += amt;
      if (t.status === "paid") g.paidCount += 1;
      else { g.pendingCount += 1; g.pendingTotal += amt; }
    }
    return [...groups.values()].sort((a, b) => a.alias.localeCompare(b.alias, "es"));
  }, [filtered, carrierById]);

  // Set de transportistas expandidos. Default: VACÍO (todos colapsados).
  // El usuario solicitó que arranquen colapsados así no se mezclan visualmente.
  const [expandedCarriers, setExpandedCarriers] = useState(() => new Set());
  const toggleCarrier = (cid) => setExpandedCarriers((prev) => {
    const next = new Set(prev);
    if (next.has(cid)) next.delete(cid);
    else next.add(cid);
    return next;
  });
  const expandAll = () => setExpandedCarriers(new Set(byCarrier.map((g) => g.carrierId)));
  const collapseAll = () => setExpandedCarriers(new Set());

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
      ) : (
        <>
          {/* Controles expandir/colapsar todos. Útil cuando hay muchos
              transportistas y querés abrirlos a todos de un toque. */}
          <div className="mb-2 flex items-center justify-end gap-1 text-xs">
            <span className="mr-1 text-[var(--color-muted)]">
              {byCarrier.length} transportista{byCarrier.length === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              onClick={expandAll}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
              disabled={expandedCarriers.size === byCarrier.length}
            >
              ▾ Expandir todos
            </button>
            <button
              type="button"
              onClick={collapseAll}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
              disabled={expandedCarriers.size === 0}
            >
              ▸ Colapsar todos
            </button>
          </div>
          <div className="space-y-2">
            {byCarrier.map((g) => {
              const expanded = expandedCarriers.has(g.carrierId);
              return (
                <div key={g.carrierId} className="rounded-md border border-[var(--color-border)]">
                  <button
                    type="button"
                    onClick={() => toggleCarrier(g.carrierId)}
                    className="flex w-full items-center gap-2 bg-[var(--color-surface-2)] px-3 py-2 text-left text-sm hover:bg-[var(--color-accent-soft)]"
                  >
                    <span className="text-[var(--color-muted)]">{expanded ? "▾" : "▸"}</span>
                    <span className="font-semibold">{g.alias}</span>
                    {g.name && <span className="text-xs text-[var(--color-muted)]">· {g.name}</span>}
                    <span className="ml-2 text-[10px] text-[var(--color-muted)]">
                      {g.trips.length} vuelta{g.trips.length === 1 ? "" : "s"}
                      {g.pendingCount > 0 && (
                        <span className="ml-1 text-[var(--color-warning)]">· {g.pendingCount} pend.</span>
                      )}
                      {g.paidCount > 0 && (
                        <span className="ml-1 text-[var(--color-success)]">· {g.paidCount} pag.</span>
                      )}
                    </span>
                    <span className="ml-auto text-right">
                      <span className="block font-semibold tabular-nums">{fmtCurrency(g.total)}</span>
                      {g.pendingTotal > 0 && g.pendingTotal !== g.total && (
                        <span className="block text-[10px] text-[var(--color-warning)] tabular-nums">
                          pend: {fmtCurrency(g.pendingTotal)}
                        </span>
                      )}
                    </span>
                  </button>
                  {expanded && (
                    isMobile ? (
                      <div className="space-y-2 p-2">
                        {g.trips.map((t) => {
                          const cy = cycleById.get(t.cycleId);
                          const fa = faenaById.get(t.faenaId);
                          const sb = subfaenaById.get(t.subfaenaId);
                          return (
                            <div
                              key={t.id}
                              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 space-y-2"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="font-mono text-xs text-[var(--color-muted)]">{t.date}</div>
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
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-[var(--color-surface-2)]/60 text-left text-[var(--color-muted)]">
                            <tr>
                              <th className="px-2 py-1.5">Fecha</th>
                              <th className="px-2 py-1.5">Vehículo</th>
                              <th className="px-2 py-1.5">Ciclo</th>
                              <th className="px-2 py-1.5">Faena / Subfaena</th>
                              <th className="px-2 py-1.5">Destino</th>
                              <th className="px-2 py-1.5 text-right">#Pers</th>
                              <th className="px-2 py-1.5">Tipo</th>
                              <th className="px-2 py-1.5 text-right">Vlts</th>
                              <th className="px-2 py-1.5 text-right">Tarifa</th>
                              <th className="px-2 py-1.5 text-right">Monto</th>
                              <th className="px-2 py-1.5">Estado</th>
                            </tr>
                          </thead>
                          <tbody>
                            {g.trips.map((t) => {
                              const cy = cycleById.get(t.cycleId);
                              const fa = faenaById.get(t.faenaId);
                              const sb = subfaenaById.get(t.subfaenaId);
                              return (
                                <tr key={t.id} className="border-t border-[var(--color-border)]">
                                  <td className="px-2 py-1.5 tabular-nums">{t.date}</td>
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
                    )
                  )}
                </div>
              );
            })}
          </div>
        </>
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
  // Quincenas (transportPayrolls): para mostrar a qué quincena pertenece
  // cada resumen y eventualmente filtrar por "sin quincena".
  const [transportPayrolls, setTransportPayrolls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [printingMany, setPrintingMany] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);
  const [showHistoricPaid, setShowHistoricPaid] = useState(false);
  // Forzar re-fetch del balance cuando una operación cambia el estado
  // (marcar pagado, revertir, eliminar resumen, generar uno nuevo).
  const [balanceVersion, setBalanceVersion] = useState(0);

  // Filtros y ordenamiento de la lista de resúmenes. Persistidos en
  // localStorage para que no se pierdan al navegar entre tabs.
  const [search, setSearch] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [sortBy, setSortBy] = useState(() => {
    try { return localStorage.getItem("transports_payments_sort") || "period_desc"; }
    catch { return "period_desc"; }
  });
  useEffect(() => {
    try { localStorage.setItem("transports_payments_sort", sortBy); } catch { /* noop */ }
  }, [sortBy]);

  const reload = async () => {
    setLoading(true);
    try {
      const paymentsPromise = showHistoricPaid
        ? paymentsService.listAll()
        : paymentsService.listSince(isoDateNDaysAgo(DEFAULT_HISTORY_DAYS));
      const [list, fa, sub, cyc, tp] = await Promise.all([
        paymentsPromise,
        faenasService.list({ cache: true, persist: true, ttl: 10 * 60 * 1000 }),
        subfaenasService.list({ cache: true, persist: true, ttl: 10 * 60 * 1000 }),
        cyclesService.list({ cache: true, persist: true, ttl: 5 * 60 * 1000 }),
        transportPayrollsService.listAll(),
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
      setTransportPayrolls(tp);
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
  const transportPayrollById = useMemo(
    () => new Map(transportPayrolls.map((tp) => [tp.id, tp])),
    [transportPayrolls],
  );

  // Filtro extra por quincena: "all" (default), "none" (sin quincena), o
  // un id concreto de quincena.
  const [payrollFilter, setPayrollFilter] = useState("all");

  // Aplica búsqueda (alias/nombre del transportista) + rango de fechas
  // (overlap con el período del resumen) + sort. El filtro se aplica antes
  // del split por estado, así pending/paid quedan consistentes.
  const filteredSorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = payments.filter((p) => {
      if (q) {
        const c = carrierById.get(p.carrierId);
        const haystack = `${c?.alias || ""} ${c?.name || ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (filterFrom || filterTo) {
        const pFrom = p.periodFrom || p.periodTo || "";
        const pTo = p.periodTo || p.periodFrom || "";
        if (!pFrom && !pTo) return false; // sin período no entra en filtro por fechas
        if (filterFrom && pTo && pTo < filterFrom) return false;
        if (filterTo && pFrom && pFrom > filterTo) return false;
      }
      if (payrollFilter === "none" && p.payrollId) return false;
      if (payrollFilter !== "all" && payrollFilter !== "none" && p.payrollId !== payrollFilter) return false;
      return true;
    });
    const cmpStr = (a, b) => String(a || "").localeCompare(String(b || ""), "es");
    const periodKey = (p) => p.periodFrom || p.periodTo || "";
    const lastPeriodKey = (p) => p.periodTo || p.periodFrom || "";
    const createdKey = (p) => p.createdAt?.seconds || 0;
    const carrierKey = (p) => carrierById.get(p.carrierId)?.alias || p.carrierId || "";
    filtered.sort((a, b) => {
      switch (sortBy) {
        case "period_asc":
          return cmpStr(periodKey(a), periodKey(b)) || createdKey(b) - createdKey(a);
        case "period_desc":
          return cmpStr(lastPeriodKey(b), lastPeriodKey(a)) || createdKey(b) - createdKey(a);
        case "amount_desc":
          return (Number(b.total) || 0) - (Number(a.total) || 0);
        case "amount_asc":
          return (Number(a.total) || 0) - (Number(b.total) || 0);
        case "carrier":
          return cmpStr(carrierKey(a), carrierKey(b)) || createdKey(b) - createdKey(a);
        case "created_desc":
        default:
          return createdKey(b) - createdKey(a);
      }
    });
    return filtered;
  }, [payments, carrierById, search, filterFrom, filterTo, sortBy, payrollFilter]);

  const pending = filteredSorted.filter((p) => p.status === "pending");
  const paid = filteredSorted.filter((p) => p.status === "paid");
  const totalCount = filteredSorted.length;
  const totalAll = payments.length;
  const hasActiveFilter = !!(search || filterFrom || filterTo || payrollFilter !== "all");
  const clearFilters = () => { setSearch(""); setFilterFrom(""); setFilterTo(""); setPayrollFilter("all"); };

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

      <div className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Buscar transportista…"
            className="min-w-[160px] flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex items-center gap-1 text-xs">
            <span className="text-[var(--color-muted)]">Período</span>
            <input
              type="date"
              value={filterFrom}
              onChange={(e) => setFilterFrom(e.target.value)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
            />
            <span className="text-[var(--color-muted)]">→</span>
            <input
              type="date"
              value={filterTo}
              onChange={(e) => setFilterTo(e.target.value)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
            />
          </div>
          <select
            value={payrollFilter}
            onChange={(e) => setPayrollFilter(e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
            title="Filtrar por quincena"
          >
            <option value="all">Todas las quincenas</option>
            <option value="none">⚠️ Sin quincena</option>
            {transportPayrolls
              .slice()
              .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
              .map((tp) => (
                <option key={tp.id} value={tp.id}>
                  🧾 {tp.name}{tp.status === "paid" ? " ✓" : ""}
                </option>
              ))}
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
            title="Ordenar por"
          >
            <option value="period_desc">Período más reciente</option>
            <option value="period_asc">Período más antiguo</option>
            <option value="amount_desc">Monto mayor</option>
            <option value="amount_asc">Monto menor</option>
            <option value="carrier">Transportista (A→Z)</option>
            <option value="created_desc">Creación más reciente</option>
          </select>
          {hasActiveFilter && (
            <button
              onClick={clearFilters}
              className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-danger)]"
              title="Limpiar filtros"
            >
              ✕ Limpiar
            </button>
          )}
          <span className="ml-auto text-[11px] text-[var(--color-muted)] tabular-nums">
            {hasActiveFilter ? `${totalCount}/${totalAll}` : `${totalAll}`} resumen{totalAll === 1 ? "" : "es"}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-[var(--color-muted)]">Cargando...</div>
      ) : (
        <>
          <PaymentSection
            title="Pendientes"
            payments={pending}
            carrierById={carrierById}
            transportPayrollById={transportPayrollById}
            onView={setViewing}
            empty={hasActiveFilter ? "Ningún pendiente coincide con el filtro" : "Sin resúmenes pendientes"}
          />
          <div className="mt-6">
            <PaymentSection
              title="Pagados"
              payments={paid}
              carrierById={carrierById}
              transportPayrollById={transportPayrollById}
              onView={setViewing}
              empty={hasActiveFilter ? "Ningún pago coincide con el filtro" : "Sin pagos registrados"}
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
        carriers={carriers}
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
  // Quincenas pendientes (transportPayrolls). Cada quincena agrupa N resúmenes
  // y se cuenta aparte en el balance — el monto del resumen se atribuye a la
  // columna "Quincenas" en lugar de "Resúmenes sueltos" para no duplicar.
  const [pendingPayrolls, setPendingPayrolls] = useState([]);
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
        const [trips, allPayments, allPayrolls] = await Promise.all([
          tripsService.listPendingUnlinked(),
          paymentsService.listAll(),
          transportPayrollsService.listAll(),
        ]);
        if (cancelled) return;
        setPendingTrips(trips);
        setPendingPayments(allPayments.filter((p) => p.status === "pending"));
        setPendingPayrolls(allPayrolls.filter((p) => p.status === "pending"));
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

  // Quincenas pendientes filtradas por overlap del período. Misma lógica que
  // payments — si la quincena no tiene período, se incluye igual.
  const payrollsInRange = useMemo(
    () =>
      pendingPayrolls.filter((q) => {
        if (!dateFrom && !dateTo) return true;
        const qFrom = q.periodFrom || q.periodTo || "";
        const qTo = q.periodTo || q.periodFrom || "";
        if (!qFrom && !qTo) return true;
        if (dateFrom && qTo && qTo < dateFrom) return false;
        if (dateTo && qFrom && qFrom > dateTo) return false;
        return true;
      }),
    [pendingPayrolls, dateFrom, dateTo],
  );

  // Index de resúmenes pendientes por id, para resolver los paymentIds de cada
  // quincena rápidamente y atribuir el monto al carrier correcto.
  const pendingPaymentsById = useMemo(
    () => new Map(pendingPayments.map((p) => [p.id, p])),
    [pendingPayments],
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
          quincenaCount: 0,
          quincenaTotal: 0,
        });
      }
      return map.get(carrierId);
    };
    for (const t of tripsInRange) {
      const e = ensure(t.carrierId);
      e.tripCount += 1;
      e.tripTotal += Number(t.amount) || 0;
    }
    // Pendiente real del resumen = total - sum(abonos). Si nunca cargaron
    // abonos, equivale a `total`. Se usa para que el balance muestre lo que
    // efectivamente falta cobrar, no el bruto.
    const pendingOf = (p) => {
      const total = Number(p?.total) || 0;
      const abonado = (p?.abonos || []).reduce((s, a) => s + (Number(a.amount) || 0), 0);
      return Math.max(0, total - abonado);
    };
    // Resúmenes SUELTOS (sin quincena): se cuentan acá. Los que ya están en
    // una quincena se atribuyen abajo, en la columna Quincenas, para que el
    // mismo monto no aparezca dos veces en el total.
    for (const p of paymentsInRange) {
      if (p.payrollId) continue;
      const e = ensure(p.carrierId);
      e.paymentCount += 1;
      e.paymentTotal += pendingOf(p);
    }
    // Quincenas: por cada una, ver qué resúmenes contiene y sumar el monto al
    // carrier de cada resumen. Una quincena con resúmenes de varios carriers
    // contribuye fraccionalmente a cada uno (caso raro pero posible).
    for (const q of payrollsInRange) {
      const totalsByCarrier = new Map();
      for (const pid of q.paymentIds || []) {
        const p = pendingPaymentsById.get(pid);
        if (!p) continue;
        totalsByCarrier.set(
          p.carrierId,
          (totalsByCarrier.get(p.carrierId) || 0) + pendingOf(p),
        );
      }
      for (const [cid, amt] of totalsByCarrier) {
        const e = ensure(cid);
        e.quincenaCount += 1;
        e.quincenaTotal += amt;
      }
    }
    return [...map.values()]
      .map((e) => ({ ...e, grandTotal: e.tripTotal + e.paymentTotal + e.quincenaTotal }))
      .filter((e) => e.tripCount + e.paymentCount + e.quincenaCount > 0)
      .sort((a, b) => b.grandTotal - a.grandTotal);
  }, [carriers, tripsInRange, paymentsInRange, payrollsInRange, pendingPaymentsById]);

  const grandTotal = rows.reduce((s, r) => s + r.grandTotal, 0);
  const tripsTotal = rows.reduce((s, r) => s + r.tripTotal, 0);
  const paymentsTotal = rows.reduce((s, r) => s + r.paymentTotal, 0);
  const quincenasTotal = rows.reduce((s, r) => s + r.quincenaTotal, 0);

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
                    <th style={{ ...cellH, textAlign: "right" }}>Quincenas</th>
                    <th style={{ ...cellH, textAlign: "right" }}>$ quincenas</th>
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
                      <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {r.quincenaCount || ""}
                      </td>
                      <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {r.quincenaTotal > 0 ? fmtCurrency(r.quincenaTotal) : ""}
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
                    <td style={cell}></td>
                    <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                      {quincenasTotal > 0 ? fmtCurrency(quincenasTotal) : ""}
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

function PaymentSection({ title, payments, carrierById, transportPayrollById, onView, empty, dim = false }) {
  // Agrupado por transportista. Cada grupo es colapsable; default expandido
  // porque típicamente hay pocos resúmenes por transportista (1-3) y el
  // usuario quiere verlos para click-to-detail.
  const groups = useMemo(() => {
    const map = new Map();
    for (const p of payments) {
      const cid = p.carrierId || "__none__";
      if (!map.has(cid)) {
        const c = carrierById.get(p.carrierId);
        map.set(cid, {
          carrierId: cid,
          alias: c?.alias || (cid === "__none__" ? "Sin transportista" : "—"),
          name: c?.name || "",
          items: [],
          total: 0,
        });
      }
      const g = map.get(cid);
      g.items.push(p);
      g.total += Number(p.total) || 0;
    }
    return [...map.values()].sort((a, b) => a.alias.localeCompare(b.alias, "es"));
  }, [payments, carrierById]);

  const [collapsedCarriers, setCollapsedCarriers] = useState(() => new Set());
  const toggleCarrier = (cid) => setCollapsedCarriers((prev) => {
    const next = new Set(prev);
    if (next.has(cid)) next.delete(cid);
    else next.add(cid);
    return next;
  });

  const fmtDate = (d) => {
    if (!d || typeof d !== "string") return "";
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : d;
  };

  const renderPaymentCard = (p) => {
    const c = carrierById.get(p.carrierId);
    const from = fmtDate(p.periodFrom);
    const to = fmtDate(p.periodTo);
    const period = from && to && from !== to
      ? `${from} → ${to}`
      : (from || to || "");
    return (
      <button
        key={p.id}
        onClick={() => onView(p)}
        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left text-sm hover:border-[var(--color-accent)]"
      >
        {paymentCardContent(p, c, period, transportPayrollById)}
      </button>
    );
  };

  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-[var(--color-muted)]">{title}</h3>
      {payments.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--color-border)] py-4 text-center text-xs text-[var(--color-muted)]">
          {empty}
        </p>
      ) : (
        <div className={`space-y-2 ${dim ? "opacity-90" : ""}`}>
          {groups.map((g) => {
            const collapsed = collapsedCarriers.has(g.carrierId);
            return (
              <div key={g.carrierId} className="rounded-md border border-[var(--color-border)]">
                <button
                  type="button"
                  onClick={() => toggleCarrier(g.carrierId)}
                  className="flex w-full items-center gap-2 bg-[var(--color-surface-2)] px-3 py-2 text-left text-sm hover:bg-[var(--color-accent-soft)]"
                >
                  <span className="text-[var(--color-muted)]">{collapsed ? "▸" : "▾"}</span>
                  <span className="font-semibold">{g.alias}</span>
                  {g.name && <span className="text-xs text-[var(--color-muted)]">· {g.name}</span>}
                  <span className="ml-2 text-[10px] text-[var(--color-muted)]">
                    · {g.items.length} resumen{g.items.length === 1 ? "" : "es"}
                  </span>
                  <span className="ml-auto font-semibold tabular-nums">
                    {fmtCurrency(g.total)}
                  </span>
                </button>
                {!collapsed && (
                  <div className="grid gap-2 p-2">
                    {g.items.map(renderPaymentCard)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Contenido interno de la tarjeta de resumen — extraído del render agrupado
// para mantener la lógica de badges (período, quincena, conteo de vueltas)
// en un solo lugar.
function paymentCardContent(p, c, period, transportPayrollById) {
  return (
    <>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{c?.alias || p.carrierId} <span className="text-[var(--color-muted)]">— {c?.name}</span></div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          {period ? (
            <span className="inline-flex items-center gap-1 rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 font-medium tabular-nums text-[var(--color-accent)]">
              📅 {period}
            </span>
          ) : (
            <span className="text-[var(--color-muted)] italic">sin período</span>
          )}
          {(() => {
            const tp = p.payrollId && transportPayrollById?.get(p.payrollId);
            if (tp) {
              const isPaid = tp.status === "paid";
              return (
                <span
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium ${
                    isPaid
                      ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                  }`}
                  title={`Quincena: ${tp.name}${isPaid ? " (pagada)" : " (pendiente)"}`}
                >
                  🧾 {tp.name}{isPaid && " ✓"}
                </span>
              );
            }
            if (p.payrollId) {
              return (
                <span className="inline-flex items-center gap-1 rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[var(--color-muted)]" title="Quincena no cargada">
                  🧾 quincena #{String(p.payrollId).slice(-4)}
                </span>
              );
            }
            return (
              <span className="inline-flex items-center gap-1 rounded border border-dashed border-[var(--color-border)] px-1.5 py-0.5 text-[var(--color-muted)]" title="Este resumen no está asignado a ninguna quincena">
                🧾 sin quincena
              </span>
            );
          })()}
          <span className="text-[var(--color-muted)]">· {(p.tripIds || []).length} vuelta{(p.tripIds || []).length === 1 ? "" : "s"}</span>
          {p.groupBy && (
            <span className="text-[var(--color-muted)]">· agrupado por {p.groupBy === "day" ? "día" : "faena"}</span>
          )}
        </div>
      </div>
      <div className="text-right">
        <div className="font-semibold tabular-nums">{fmtCurrency(p.total)}</div>
        {(() => {
          // Si el resumen pendiente tiene abonos cargados, mostramos el
          // pendiente real (total - abonos) abajo del bruto para que se vea
          // de un vistazo cuánto falta sin abrir el detalle.
          const abonado = (p.abonos || []).reduce((s, a) => s + (Number(a.amount) || 0), 0);
          if (p.status !== "paid" && abonado > 0) {
            const pending = Math.max(0, (Number(p.total) || 0) - abonado);
            return (
              <div className="text-[10px] tabular-nums text-[var(--color-warning)]">
                pend: {fmtCurrency(pending)}
              </div>
            );
          }
          return null;
        })()}
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
    </>
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

function PaymentDetailModal({ open, onClose, payment, carrier, carriers = [], faenaById, subfaenaById, cycleById, onPay, onRevert, onDelete, onChanged }) {
  const toast = useToast();
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(false);
  const printRef = useRef(null);
  const [busy, setBusy] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [savingTripId, setSavingTripId] = useState(null);
  // Edición avanzada de una vuelta (mismo modal que TripsTab) + confirmación
  // para sacar una vuelta del resumen sin borrarla del sistema (vuelve a
  // estar "suelta" para futuras nóminas).
  const [editingTrip, setEditingTrip] = useState(null);
  const [confirmRemoveTrip, setConfirmRemoveTrip] = useState(null);
  // Abonos: el resumen puede tener pagos parciales antes de marcarse 100%
  // pagado. Mantenemos un estado local sincronizado con el doc para que el UI
  // refleje los cambios sin esperar el reload del padre.
  const [abonos, setAbonos] = useState(payment?.abonos || []);
  const [newAbono, setNewAbono] = useState({ amount: "", date: "", notes: "" });
  const [abonoBusy, setAbonoBusy] = useState(false);
  useEffect(() => {
    setAbonos(payment?.abonos || []);
  }, [payment?.id, payment?.abonos]);

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

  // Suma actual de abonos + monto pendiente. Calculados a partir del estado
  // local `abonos` (no `payment.abonos`) para que el UI se actualice apenas
  // se agrega/quita un abono, sin esperar el reload del padre.
  const totalAbonado = abonos.reduce((s, a) => s + (Number(a.amount) || 0), 0);
  const pendingAmount = Math.max(0, (Number(payment.total) || 0) - totalAbonado);

  const handleAddAbono = async () => {
    const amt = Number(newAbono.amount) || 0;
    if (amt <= 0) {
      toast.error("Ingresá un monto mayor a 0");
      return;
    }
    if (amt > pendingAmount) {
      const ok = window.confirm(
        `El abono (${fmtCurrency(amt)}) supera el monto pendiente (${fmtCurrency(pendingAmount)}). ¿Continuar igual?`,
      );
      if (!ok) return;
    }
    setAbonoBusy(true);
    try {
      const updated = await paymentsService.addAbono(payment.id, {
        amount: amt,
        date: newAbono.date || new Date().toISOString().slice(0, 10),
        notes: newAbono.notes,
      });
      setAbonos(updated.abonos || []);
      setNewAbono({ amount: "", date: "", notes: "" });
      if (onChanged) await onChanged();
    } catch (err) {
      toast.error("Error al cargar abono: " + (err.message || err));
    } finally {
      setAbonoBusy(false);
    }
  };

  const handleRemoveAbono = async (abonoId) => {
    if (!window.confirm("¿Eliminar este abono?")) return;
    setAbonoBusy(true);
    try {
      const updated = await paymentsService.removeAbono(payment.id, abonoId);
      setAbonos(updated.abonos || []);
      if (onChanged) await onChanged();
    } catch (err) {
      toast.error("Error al eliminar abono: " + (err.message || err));
    } finally {
      setAbonoBusy(false);
    }
  };

  // Refresca trips desde Firestore para reflejar cambios en el ítem
  // actual del modal después de editar/quitar.
  const refreshTrips = async () => {
    try {
      const all = await tripsService.listByCarrier(payment.carrierId);
      // Necesitamos releer el payment para tener tripIds actualizado (el
      // remove edita la lista). Caemos al payment del padre como fallback.
      let currentTripIds = payment.tripIds || [];
      try {
        const updated = await paymentsService.getById(payment.id);
        if (updated) currentTripIds = updated.tripIds || currentTripIds;
      } catch { /* noop */ }
      const filtered = all
        .filter((t) => currentTripIds.includes(t.id))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      setTrips(filtered);
    } catch (err) {
      toast.error("No se pudieron recargar las vueltas: " + (err.message || err));
    }
  };

  const handleSaveTrip = async (form) => {
    if (!editingTrip) return;
    try {
      // Preservar metadata de origen (ciclo/faena/subfaena) como hace
      // TripsTab — el resumen no decide eso.
      const payload = {
        ...form,
        cycleId: editingTrip.cycleId || null,
        faenaId: editingTrip.faenaId || null,
        subfaenaId: editingTrip.subfaenaId || null,
      };
      await tripsService.update(editingTrip.id, payload);
      setEditingTrip(null);
      await refreshTrips();
      // El total del resumen depende del amount: recalcular y persistir.
      const newTotal = (await tripsService.listByCarrier(payment.carrierId))
        .filter((t) => (payment.tripIds || []).includes(t.id))
        .reduce((s, t) => s + (Number(t.amount) || 0), 0);
      await paymentsService.updateTotal(payment.id, newTotal);
      if (onChanged) await onChanged();
      toast.success("Vuelta actualizada");
    } catch (err) {
      toast.error("Error al guardar: " + (err.message || err));
    }
  };

  const handleRemoveTripFromPayment = async () => {
    if (!confirmRemoveTrip) return;
    try {
      await paymentsService.editSummaryTrips(payment.id, {
        removeTripIds: [confirmRemoveTrip.id],
      });
      setConfirmRemoveTrip(null);
      await refreshTrips();
      if (onChanged) await onChanged();
      toast.success("Vuelta quitada del resumen");
    } catch (err) {
      toast.error("Error al quitar: " + (err.message || err));
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
              title="Editar valores inline + acceder a los botones de editar detalles completos / quitar vuelta por fila"
            >
              {editMode ? "✓ Listo" : "✏️ Editar resumen"}
            </button>
          )}
          {/* Marcar pagado / Revertir movieron a la pestaña "Quincenas".
              Desde acá solo se crea, edita o elimina el resumen suelto.
              Cuando el modal se abre desde la quincena, `onDelete` viene
              null — escondemos el botón porque eliminar el resumen
              requiere primero sacarlo de la quincena. */}
          {!isPaid && onDelete && (
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

      {/* Abonos parciales — solo cuando el resumen NO está marcado pagado.
          Cuando está pagado los abonos se ven igual abajo pero no se pueden
          modificar. */}
      {(abonos.length > 0 || !isPaid) && (
        <div className="mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-sm">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
              💰 Abonos ({abonos.length})
            </span>
            <span className="flex flex-wrap items-baseline gap-3 text-xs">
              <span className="text-[var(--color-muted)]">
                Abonado:{" "}
                <span className="font-semibold tabular-nums text-[var(--color-success)]">
                  {fmtCurrency(totalAbonado)}
                </span>
              </span>
              <span className="text-[var(--color-muted)]">
                Pendiente:{" "}
                <span className={`font-semibold tabular-nums ${pendingAmount === 0 ? "text-[var(--color-success)]" : "text-[var(--color-warning)]"}`}>
                  {fmtCurrency(pendingAmount)}
                </span>
              </span>
            </span>
          </div>

          {abonos.length > 0 && (
            <ul className="mb-2 space-y-1">
              {abonos.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs"
                >
                  <span className="font-mono text-[var(--color-muted)]">{a.date || "—"}</span>
                  <span className="font-semibold tabular-nums">{fmtCurrency(a.amount)}</span>
                  {a.notes && (
                    <span className="text-[var(--color-muted)] truncate">— {a.notes}</span>
                  )}
                  {!isPaid && (
                    <button
                      onClick={() => handleRemoveAbono(a.id)}
                      disabled={abonoBusy}
                      title="Eliminar este abono"
                      className="ml-auto rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] disabled:opacity-50"
                    >
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {!isPaid && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-0.5 text-[10px] text-[var(--color-muted)]">
                Monto
                <input
                  type="number"
                  min="0"
                  step="100"
                  placeholder="0"
                  value={newAbono.amount}
                  onChange={(e) => setNewAbono((p) => ({ ...p, amount: e.target.value }))}
                  className="w-28 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-[var(--color-accent)]"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[10px] text-[var(--color-muted)]">
                Fecha
                <input
                  type="date"
                  value={newAbono.date}
                  onChange={(e) => setNewAbono((p) => ({ ...p, date: e.target.value }))}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
                />
              </label>
              <label className="flex flex-1 flex-col gap-0.5 text-[10px] text-[var(--color-muted)]">
                Nota (opcional)
                <input
                  type="text"
                  placeholder="ej. transferencia, efectivo, cheque..."
                  value={newAbono.notes}
                  onChange={(e) => setNewAbono((p) => ({ ...p, notes: e.target.value }))}
                  className="min-w-[140px] rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
                />
              </label>
              <button
                onClick={handleAddAbono}
                disabled={abonoBusy || !newAbono.amount}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
              >
                {abonoBusy ? "Cargando..." : "+ Abono"}
              </button>
            </div>
          )}
        </div>
      )}

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
          onEditTrip={editMode && !isPaid ? (t) => setEditingTrip(t) : null}
          onRemoveTrip={editMode && !isPaid ? (t) => setConfirmRemoveTrip(t) : null}
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

      <TripEditModal
        open={!!editingTrip}
        onClose={() => setEditingTrip(null)}
        trip={editingTrip}
        carriers={carriers}
        days={[]}
        onSave={handleSaveTrip}
      />

      <ConfirmDialog
        open={!!confirmRemoveTrip}
        title="Quitar vuelta del resumen"
        message={
          confirmRemoveTrip
            ? `¿Sacar la vuelta del ${confirmRemoveTrip.date} (${fmtCurrency(confirmRemoveTrip.amount)}) de este resumen? La vuelta no se borra — vuelve a estar suelta para futuros resúmenes.`
            : ""
        }
        confirmLabel="Quitar"
        danger
        onCancel={() => setConfirmRemoveTrip(null)}
        onConfirm={handleRemoveTripFromPayment}
      />
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
  { payment, carrier, trips, periodLabel, faenaById, subfaenaById, cycleById, editable = false, onAmountChange, onEditTrip, onRemoveTrip },
  ref,
) {
  // Si el modal en edición pasó callbacks por trip, mostramos una columna
  // "Acciones" extra. Cuando se imprime, el usuario debería desactivar el
  // modo edición antes (sino los botones aparecen en el print, pero son
  // visualmente discretos y no afectan el contenido).
  const showActions = editable && (onEditTrip || onRemoveTrip);
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
            {showActions && <th style={{ ...cellH, textAlign: "center", width: 80 }}>Acciones</th>}
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
                {showActions && (
                  <td style={{ ...cell, textAlign: "center", padding: 4 }}>
                    <div style={{ display: "flex", justifyContent: "center", gap: 4 }}>
                      {onEditTrip && (
                        <button
                          type="button"
                          onClick={() => onEditTrip(t)}
                          title="Editar todos los detalles de esta vuelta"
                          style={{
                            background: "#dbeafe",
                            color: "#1d4ed8",
                            border: "1px solid #93c5fd",
                            borderRadius: 4,
                            padding: "2px 6px",
                            fontSize: 11,
                            cursor: "pointer",
                          }}
                        >
                          ✏️
                        </button>
                      )}
                      {onRemoveTrip && (
                        <button
                          type="button"
                          onClick={() => onRemoveTrip(t)}
                          title="Quitar esta vuelta del resumen (no la borra)"
                          style={{
                            background: "#fee2e2",
                            color: "#b91c1c",
                            border: "1px solid #fca5a5",
                            borderRadius: 4,
                            padding: "2px 6px",
                            fontSize: 11,
                            cursor: "pointer",
                          }}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
          <tr style={{ background: "#c6efce" }}>
            <td style={cell} colSpan={6}></td>
            <td style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtCurrency(total)}</td>
            <td style={cell}></td>
            {showActions && <td style={cell}></td>}
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

// Balance general SOLO de quincenas pendientes. Por cada quincena pending,
// suma los items NO pagados agrupados por transportista. Excluye:
//   - Quincenas marcadas como pagadas (status === "paid").
//   - Quincenas pending donde todos sus items individuales ya están pagados
//     (caso borde: el usuario marcó cada resumen por separado en lugar de
//     usar "Marcar quincena pagada" — la quincena queda pending pero no
//     debe nada).
function QuincenasBalanceSummary({ carriers, payrolls, payments }) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(true);
  const [busy, setBusy] = useState("");
  const printRef = useRef(null);

  const paymentsById = useMemo(
    () => new Map(payments.map((p) => [p.id, p])),
    [payments],
  );

  // Layout pivot: filas = transportistas, columnas = quincenas (excepto las
  // totalmente pagadas), celdas = pending + paid del carrier en esa quincena.
  // Las quincenas con status=paid o donde TODOS los items están pagados se
  // excluyen — solo aparecen las que aún tienen al menos un item pendiente.
  // Dentro de las incluidas, cada celda muestra el pendiente principal y, si
  // hay items ya pagados de ese mismo carrier en esa quincena, una segunda
  // línea con "pagado: $X" en gris.
  const { pendingQuincenas, rows } = useMemo(() => {
    const qList = [];
    const pendMap = new Map(); // carrierId → Map(quincenaId → amount)
    const paidMap = new Map(); // carrierId → Map(quincenaId → amount)
    for (const q of payrolls) {
      if (q.status === "paid") continue;
      const pendByCarrier = new Map();
      const paidByCarrier = new Map();
      for (const pid of q.paymentIds || []) {
        const p = paymentsById.get(pid);
        if (!p) continue;
        const cid = p.carrierId || "__none__";
        const total = Number(p.total) || 0;
        if (p.status === "paid") {
          paidByCarrier.set(cid, (paidByCarrier.get(cid) || 0) + total);
        } else {
          // Resumen pending: el "abonado" (sum de abonos) cuenta como pagado,
          // el resto como pendiente. Si no hay abonos, todo va a pendiente.
          const abonado = (p.abonos || []).reduce((s, a) => s + (Number(a.amount) || 0), 0);
          const pending = Math.max(0, total - abonado);
          if (pending > 0) {
            pendByCarrier.set(cid, (pendByCarrier.get(cid) || 0) + pending);
          }
          if (abonado > 0) {
            paidByCarrier.set(cid, (paidByCarrier.get(cid) || 0) + Math.min(abonado, total));
          }
        }
      }
      // Excluir quincenas pending sin ningún item pendiente (todos paid sueltos).
      if (pendByCarrier.size === 0) continue;
      qList.push(q);
      for (const [cid, amt] of pendByCarrier) {
        if (!pendMap.has(cid)) pendMap.set(cid, new Map());
        pendMap.get(cid).set(q.id, amt);
      }
      for (const [cid, amt] of paidByCarrier) {
        if (!paidMap.has(cid)) paidMap.set(cid, new Map());
        paidMap.get(cid).set(q.id, amt);
      }
    }
    qList.sort((a, b) => {
      const ta = a.createdAt?.toMillis?.() ?? a.createdAt?.seconds ?? 0;
      const tb = b.createdAt?.toMillis?.() ?? b.createdAt?.seconds ?? 0;
      return tb - ta;
    });
    // Carriers en las filas: cualquiera con monto (pending o paid) en alguna
    // quincena incluida.
    const carrierIds = new Set([...pendMap.keys(), ...paidMap.keys()]);
    const carrierRows = [];
    for (const cid of carrierIds) {
      const pm = pendMap.get(cid) || new Map();
      const pd = paidMap.get(cid) || new Map();
      const pendingTotal = [...pm.values()].reduce((s, v) => s + v, 0);
      const paidTotal = [...pd.values()].reduce((s, v) => s + v, 0);
      if (pendingTotal + paidTotal <= 0) continue;
      const c = carriers.find((x) => x.id === cid);
      carrierRows.push({
        carrierId: cid,
        alias: c?.alias || (cid === "__none__" ? "Sin transportista" : "—"),
        name: c?.name || "",
        pending: pm,
        paid: pd,
        pendingTotal,
        paidTotal,
      });
    }
    // Ordenar por pendiente desc (lo más urgente primero), desempate por paid.
    carrierRows.sort((a, b) => (b.pendingTotal - a.pendingTotal) || (b.paidTotal - a.paidTotal));
    return { pendingQuincenas: qList, rows: carrierRows };
  }, [carriers, payrolls, paymentsById]);

  const grandPending = rows.reduce((s, r) => s + r.pendingTotal, 0);
  const grandPaid = rows.reduce((s, r) => s + r.paidTotal, 0);
  // Totales por columna (footer): pendiente y pagado separados.
  const colTotals = useMemo(() => {
    const map = new Map();
    for (const q of pendingQuincenas) {
      let pend = 0;
      let paid = 0;
      for (const r of rows) {
        pend += r.pending.get(q.id) || 0;
        paid += r.paid.get(q.id) || 0;
      }
      map.set(q.id, { pending: pend, paid });
    }
    return map;
  }, [pendingQuincenas, rows]);
  const quincenaCount = pendingQuincenas.length;

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
      link.download = "balance-quincenas.png";
      link.href = dataUrl;
      link.click();
    } finally {
      setBusy("");
    }
  };

  const handlePrint = () => {
    if (!printRef.current) return;
    const html = printRef.current.outerHTML;
    const win = window.open("", "_blank", "width=900,height=700");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>Balance de quincenas</title>
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

  return (
    <div className="mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-[var(--color-accent-soft)]"
      >
        <span className="flex items-center gap-2">
          <span className="text-[var(--color-muted)]">{expanded ? "▾" : "▸"}</span>
          <span className="font-medium">Balance de quincenas pendientes</span>
        </span>
        <span className="flex items-baseline gap-2">
          <span className="text-xs text-[var(--color-muted)]">
            {quincenaCount} quincena{quincenaCount === 1 ? "" : "s"} · {rows.length} transportista{rows.length === 1 ? "" : "s"}
          </span>
          <span className="font-semibold tabular-nums text-[var(--color-accent)]">
            {fmtCurrency(grandPending)}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[var(--color-border)] p-3">
          <div className="mb-3 flex flex-wrap items-center justify-end gap-1">
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

          {rows.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--color-border)] py-4 text-center text-xs text-[var(--color-muted)]">
              Sin quincenas pendientes.
            </div>
          ) : (
            <div
              ref={printRef}
              style={{
                background: "#ffffff",
                color: "#000",
                padding: 16,
                fontFamily: "ui-sans-serif, system-ui, sans-serif",
                overflowX: "auto",
              }}
            >
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>
                  Balance de quincenas pendientes
                </div>
                <div style={{ fontSize: 11, color: "#555" }}>
                  {quincenaCount} quincena{quincenaCount === 1 ? "" : "s"} · {rows.length} transportista{rows.length === 1 ? "" : "s"}
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
                    {pendingQuincenas.map((q) => {
                      const period = (q.periodFrom || q.periodTo)
                        ? `${q.periodFrom || "?"} → ${q.periodTo || "?"}`
                        : "";
                      return (
                        <th key={q.id} style={{ ...cellH, textAlign: "right", minWidth: 110 }}>
                          <div>{q.name}</div>
                          {period && (
                            <div style={{ fontSize: 10, fontWeight: 400, color: "#333" }}>
                              {period}
                            </div>
                          )}
                        </th>
                      );
                    })}
                    <th style={{ ...cellH, textAlign: "right", background: "#7cb1d8" }}>
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.carrierId}>
                      <td style={cell}>
                        <span style={{ fontWeight: 600 }}>{r.alias}</span>
                        {r.name && (
                          <span style={{ color: "#666", marginLeft: 6, fontSize: 11 }}>
                            {r.name}
                          </span>
                        )}
                      </td>
                      {pendingQuincenas.map((q) => {
                        const pend = r.pending.get(q.id) || 0;
                        const paid = r.paid.get(q.id) || 0;
                        return (
                          <td
                            key={q.id}
                            style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                          >
                            {pend > 0 && <div>{fmtCurrency(pend)}</div>}
                            {paid > 0 && (
                              <div style={{ color: "#16a34a", fontSize: 10, fontStyle: "italic" }}>
                                pagado: {fmtCurrency(paid)}
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td
                        style={{
                          ...cell,
                          textAlign: "right",
                          fontWeight: 700,
                          fontVariantNumeric: "tabular-nums",
                          background: "#eaf4fb",
                        }}
                      >
                        {fmtCurrency(r.pendingTotal)}
                        {r.paidTotal > 0 && (
                          <div style={{ color: "#16a34a", fontSize: 10, fontStyle: "italic", fontWeight: 600 }}>
                            pagado: {fmtCurrency(r.paidTotal)}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ background: "#c6efce" }}>
                    <td style={{ ...cell, fontWeight: 700 }}>Total pendiente</td>
                    {pendingQuincenas.map((q) => (
                      <td
                        key={q.id}
                        style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
                      >
                        {fmtCurrency(colTotals.get(q.id)?.pending || 0)}
                      </td>
                    ))}
                    <td
                      style={{
                        ...cell,
                        textAlign: "right",
                        fontWeight: 700,
                        fontSize: 13,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmtCurrency(grandPending)}
                    </td>
                  </tr>
                  <tr style={{ background: "#dcedc8" }}>
                    <td style={{ ...cell, fontWeight: 700, color: "#15803d" }}>Total pagado</td>
                    {pendingQuincenas.map((q) => {
                      const paid = colTotals.get(q.id)?.paid || 0;
                      return (
                        <td
                          key={q.id}
                          style={{ ...cell, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "#15803d" }}
                        >
                          {paid > 0 ? fmtCurrency(paid) : ""}
                        </td>
                      );
                    })}
                    <td
                      style={{
                        ...cell,
                        textAlign: "right",
                        fontWeight: 700,
                        fontSize: 13,
                        fontVariantNumeric: "tabular-nums",
                        color: "#15803d",
                      }}
                    >
                      {fmtCurrency(grandPaid)}
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
  // las que se arman los resúmenes). Subfaenas y ciclos se cargan para que
  // el "Imprimir quincena + resúmenes" pueda mostrar la columna Labor en
  // cada resumen (faena/subfaena/ciclo).
  const [faenas, setFaenas] = useState([]);
  const [subfaenas, setSubfaenas] = useState([]);
  const [cycles, setCycles] = useState([]);
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
      const [pr, py, fa, sub, cyc, pt] = await Promise.all([
        transportPayrollsService.listAll(),
        paymentsService.listAll(),
        faenasService.list({ cache: true, ttl: 60_000 }),
        subfaenasService.list({ cache: true, persist: true, ttl: 10 * 60 * 1000 }),
        cyclesService.list({ cache: true, persist: true, ttl: 5 * 60 * 1000 }),
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
      setSubfaenas(sub);
      setCycles(cyc);
      // Solo las vueltas no asignadas a ningún resumen — son las elegibles
      // para entrar a una quincena nueva.
      setPendingTrips(pt.filter((t) => !t.paymentId));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const paymentsById = useMemo(() => new Map(payments.map((p) => [p.id, p])), [payments]);
  const faenaById = useMemo(() => new Map(faenas.map((f) => [f.id, f])), [faenas]);
  const subfaenaById = useMemo(() => new Map(subfaenas.map((s) => [s.id, s])), [subfaenas]);
  const cycleById = useMemo(() => new Map(cycles.map((c) => [c.id, c])), [cycles]);

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

      {!loading && payrolls.length > 0 && (
        <QuincenasBalanceSummary
          carriers={carriers}
          payrolls={payrolls}
          payments={payments}
        />
      )}

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
          carriers={carriers}
          carriersById={carriersById}
          faenaById={faenaById}
          subfaenaById={subfaenaById}
          cycleById={cycleById}
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
          onItemChanged={async () => { await load(); }}
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
  payroll, items, carriers = [], carriersById, faenaById, subfaenaById, cycleById, looseSummaries,
  onClose, onEditMeta, onDeletePayroll, onAddSummaries, onRemoveSummary,
  onMarkPayrollPaid, onRevertPayroll, onMarkItemPaid, onRevertItem, onItemChanged,
}) {
  const toast = useToast();
  const [addingOpen, setAddingOpen] = useState(false);
  const [adding, setAdding] = useState(new Set());
  const printRef = useRef(null);
  // Refs y datos para "Imprimir quincena + resúmenes". Renderizamos
  // offscreen un PrintablePayrollTable + N PrintableSummary, capturamos
  // outerHTML, y abrimos una ventana de impresión.
  const summaryRefs = useRef([]);
  const [printItems, setPrintItems] = useState(null);
  const [busy, setBusy] = useState("");
  // Resumen actualmente abierto en vista detalle. Permite navegar de la
  // tabla de la quincena a ver/editar las vueltas de un resumen sin salir
  // del modal de la quincena.
  const [viewingPayment, setViewingPayment] = useState(null);
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

  // Imprime la quincena (resumen) + 1 hoja por cada resumen interno con su
  // detalle de vueltas. Trips se cargan al click via tripsService.listAll
  // y se filtran por payment.tripIds.
  const handlePrintAll = async () => {
    if (items.length === 0) {
      toast.warning("La quincena no tiene resúmenes para imprimir.");
      return;
    }
    setBusy("printAll");
    try {
      const allTrips = await tripsService.listAll();
      const tripById = new Map(allTrips.map((t) => [t.id, t]));
      const built = items.map((it) => {
        const carrier = carriersById.get(it.carrierId) || null;
        const myTrips = (it.tripIds || [])
          .map((id) => tripById.get(id))
          .filter(Boolean)
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        const dates = myTrips.map((t) => t.date).filter(Boolean).sort();
        const periodLabel =
          it.periodFrom && it.periodTo
            ? `${it.periodFrom} → ${it.periodTo}`
            : dates.length
              ? `${dates[0]} → ${dates[dates.length - 1]}`
              : "—";
        return { payment: it, carrier, trips: myTrips, periodLabel };
      });
      summaryRefs.current = new Array(built.length).fill(null);
      setPrintItems(built);
      // Esperar un tick para que React renderice los nodos offscreen.
      await new Promise((r) => setTimeout(r, 100));
      const headerHtml = printRef.current?.outerHTML || "";
      const summariesHtml = summaryRefs.current
        .filter(Boolean)
        .map((n) => `<div class="page">${n.outerHTML}</div>`)
        .join("");
      const win = window.open("", "_blank", "width=1000,height=800");
      if (!win) {
        toast.warning("Permite las ventanas emergentes para imprimir.");
        return;
      }
      win.document.write(`<!DOCTYPE html><html><head><title>Quincena ${payroll.name} — completa</title>
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
      </head><body>
        <div class="page">${headerHtml}</div>
        ${summariesHtml}
        <script>window.onload = () => { window.focus(); window.print(); };</script>
      </body></html>`);
      win.document.close();
    } catch (err) {
      toast.error("Error al imprimir: " + (err?.message || err));
    } finally {
      setPrintItems(null);
      setBusy("");
    }
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
          y `outerHTML` para imprimir. No visible para el usuario.
          Cuando se dispara "Imprimir quincena + resúmenes" agregamos también
          un PrintableSummary por cada item (refs en summaryRefs). */}
      <div style={{ position: "absolute", left: -99999, top: 0, pointerEvents: "none" }} aria-hidden>
        <PrintablePayrollTable ref={printRef} payroll={payroll} items={items} carriersById={carriersById} />
        {printItems && printItems.map((it, i) => (
          <PrintableSummary
            key={it.payment.id}
            ref={(el) => { summaryRefs.current[i] = el; }}
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
                title="Imprimir solo la tabla resumen de la quincena"
              >
                🖨 Imprimir
              </button>
              <button
                onClick={handlePrintAll}
                disabled={busy === "printAll"}
                className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-2 py-1 text-xs font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-fg)] disabled:opacity-60"
                title="Imprimir el resumen de la quincena seguido del detalle de cada resumen (1 hoja por resumen)"
              >
                {busy === "printAll" ? "Cargando vueltas..." : "🖨 Imprimir quincena + resúmenes"}
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
                  <tr
                    key={it.id}
                    className="cursor-pointer border-t border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]"
                    onClick={() => setViewingPayment(it)}
                    title="Click para ver el detalle del resumen (vueltas)"
                  >
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
                      <td className="px-2 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => setViewingPayment(it)}
                            title="Ver detalle del resumen"
                            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[10px] hover:bg-[var(--color-accent-soft)]"
                          >
                            👁
                          </button>
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

      {/* Detalle del resumen seleccionado. Reusa el PaymentDetailModal
          completo (con editar/quitar vueltas) — desactivamos solo onPay /
          onRevert / onDelete porque esos flujos se manejan a nivel quincena. */}
      <PaymentDetailModal
        open={!!viewingPayment}
        onClose={() => setViewingPayment(null)}
        payment={viewingPayment}
        carrier={viewingPayment ? carriersById.get(viewingPayment.carrierId) : null}
        carriers={carriers}
        faenaById={faenaById}
        subfaenaById={subfaenaById}
        cycleById={cycleById}
        onPay={null}
        onRevert={null}
        onDelete={null}
        onChanged={async () => {
          if (onItemChanged) await onItemChanged();
          // Releemos el viewingPayment del set fresco para que el modal hijo
          // reaccione (su prop `payment` es el objeto, no el id, sino el
          // contenido stale persistiría).
          if (viewingPayment) {
            try {
              const updated = await paymentsService.getById(viewingPayment.id);
              if (updated) setViewingPayment(updated);
            } catch { /* noop */ }
          }
        }}
      />
    </Modal>
  );
}
