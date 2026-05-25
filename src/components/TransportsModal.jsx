import { useEffect, useMemo, useRef, useState } from "react";
import Modal from "./Modal";
import TextField from "./TextField";
import Select from "./Select";
import ConfirmDialog from "./ConfirmDialog";
import { useCarriers } from "../contexts/CarriersContext";
import { tripsService, TRIP_KINDS } from "../services/transportsService";
import { CARRIER_TYPES } from "../services/carriersService";

const fmtCurrency = (v) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 }).format(
    Number(v) || 0,
  );

// Persistencia de transportistas recientes por ciclo. Cuando se guarda una
// vuelta, el carrier usado salta al frente de la lista para que el próximo
// ingreso lo tenga arriba en el combobox.
const RECENTS_MAX = 6;
const recentsKey = (cycleId) => `transports.recentCarriers.${cycleId || "_global"}`;
function loadRecents(cycleId) {
  try {
    const raw = localStorage.getItem(recentsKey(cycleId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((v) => typeof v === "string") : [];
  } catch { return []; }
}
function pushRecent(cycleId, carrierId) {
  if (!carrierId) return;
  try {
    const cur = loadRecents(cycleId).filter((id) => id !== carrierId);
    cur.unshift(carrierId);
    localStorage.setItem(recentsKey(cycleId), JSON.stringify(cur.slice(0, RECENTS_MAX)));
  } catch { /* noop */ }
}

export default function TransportsModal({ open, onClose, cycle, faena, subfaena, days = [], readOnly = false }) {
  const { activeCarriers } = useCarriers();
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null); // null | { mode: "new", date } | { mode: "edit", trip }
  const [confirmDel, setConfirmDel] = useState(null);
  const [selectedDate, setSelectedDate] = useState(days[0] || null);

  const reload = async () => {
    if (!cycle?.id) return;
    setLoading(true);
    try {
      const list = await tripsService.listByCycle(cycle.id);
      list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      setTrips(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      reload();
      setSelectedDate((d) => d || days[0] || null);
    } else {
      setEditing(null);
      setConfirmDel(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cycle?.id]);

  useEffect(() => {
    if (open && !selectedDate && days[0]) setSelectedDate(days[0]);
  }, [open, days, selectedDate]);

  const carrierById = useMemo(() => new Map(activeCarriers.map((c) => [c.id, c])), [activeCarriers]);

  const tripsByDate = useMemo(() => {
    const m = new Map();
    for (const d of days) m.set(d, []);
    for (const t of trips) {
      if (!m.has(t.date)) m.set(t.date, []);
      m.get(t.date).push(t);
    }
    return m;
  }, [trips, days]);

  const totalsByDate = useMemo(() => {
    const m = {};
    for (const [d, list] of tripsByDate.entries()) {
      m[d] = list.reduce((s, t) => s + (Number(t.amount) || 0), 0);
    }
    return m;
  }, [tripsByDate]);

  const total = useMemo(() => trips.reduce((s, t) => s + (Number(t.amount) || 0), 0), [trips]);
  const dayTrips = selectedDate ? tripsByDate.get(selectedDate) || [] : [];

  const handleSave = async (form) => {
    const payload = {
      ...form,
      cycleId: cycle.id,
      faenaId: faena?.id || null,
      subfaenaId: subfaena?.id || null,
    };
    if (editing?.mode === "edit") {
      await tripsService.update(editing.trip.id, payload);
    } else {
      await tripsService.create(payload);
    }
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
      alert(err.message || "Error al eliminar");
    }
  };

  return (
    <>
      <Modal open={open} onClose={onClose} title={`🚐 Transportes — ${cycle?.label || ""}`} size="xl">
        <div className="mb-3 flex items-center justify-between gap-2 text-sm">
          <span className="text-[var(--color-muted)]">
            {trips.length} vuelta{trips.length === 1 ? "" : "s"} · Total {fmtCurrency(total)}
          </span>
        </div>

        <div className="grid grid-cols-12 gap-3" style={{ minHeight: 360 }}>
          {/* Day list */}
          <div className="col-span-4 max-h-[60vh] overflow-auto rounded-md border border-[var(--color-border)]">
            {days.map((d) => {
              const isActive = d === selectedDate;
              const dt = totalsByDate[d] || 0;
              const count = (tripsByDate.get(d) || []).length;
              return (
                <button
                  key={d}
                  onClick={() => setSelectedDate(d)}
                  className={`flex w-full items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-left text-sm transition-colors ${
                    isActive ? "bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]" : "hover:bg-[var(--color-surface-2)]"
                  }`}
                >
                  <div>
                    <div className="tabular-nums">{d}</div>
                    <div className="text-[10px] text-[var(--color-muted)]">
                      {count} vuelta{count === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="tabular-nums text-xs">{dt > 0 ? fmtCurrency(dt) : ""}</div>
                </button>
              );
            })}
          </div>

          {/* Day detail */}
          <div className="col-span-8">
            {selectedDate ? (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-medium">{selectedDate}</h3>
                  {!readOnly && (
                    <button
                      onClick={() => setEditing({ mode: "new", date: selectedDate })}
                      className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
                    >
                      + Agregar vuelta
                    </button>
                  )}
                </div>

                {loading ? (
                  <div className="py-6 text-center text-xs text-[var(--color-muted)]">Cargando...</div>
                ) : dayTrips.length === 0 ? (
                  <div className="rounded-md border border-dashed border-[var(--color-border)] py-6 text-center text-xs text-[var(--color-muted)]">
                    Sin vueltas este día
                  </div>
                ) : (
                  <div className="overflow-auto rounded-md border border-[var(--color-border)]">
                    <table className="w-full text-xs">
                      <thead className="bg-[var(--color-surface-2)] text-left text-[var(--color-muted)]">
                        <tr>
                          <th className="px-2 py-1.5">Transp.</th>
                          <th className="px-2 py-1.5">Vehículo</th>
                          <th className="px-2 py-1.5">Destino</th>
                          <th className="px-2 py-1.5 text-right">#Pers</th>
                          <th className="px-2 py-1.5 text-right">Vlts</th>
                          <th className="px-2 py-1.5 text-right">Tarifa</th>
                          <th className="px-2 py-1.5 text-right">Monto</th>
                          <th className="px-2 py-1.5">Estado</th>
                          <th className="px-2 py-1.5"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {dayTrips.map((t) => {
                          const c = carrierById.get(t.carrierId);
                          const isPaid = t.status === "paid";
                          return (
                            <tr key={t.id} className="border-t border-[var(--color-border)]">
                              <td className="px-2 py-1.5">
                                {c ? c.alias : "—"}
                                {t.kind === "approach" && (
                                  <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                                    acerc.
                                  </span>
                                )}
                              </td>
                              <td className="px-2 py-1.5">{t.vehicleAlias || "—"}</td>
                              <td className="px-2 py-1.5">{t.destino || "—"}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{t.personCount ?? "—"}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{t.qty}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{fmtCurrency(t.rate)}</td>
                              <td className="px-2 py-1.5 text-right font-medium tabular-nums">{fmtCurrency(t.amount)}</td>
                              <td className="px-2 py-1.5">
                                {isPaid ? (
                                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                                    pagado
                                  </span>
                                ) : (
                                  <span className="rounded bg-[var(--color-warning-soft)] px-1.5 py-0.5 text-[10px] text-[var(--color-warning)]">
                                    pendiente
                                  </span>
                                )}
                              </td>
                              <td className="px-2 py-1.5">
                                {!readOnly && !isPaid && (
                                  <div className="flex gap-1">
                                    <button
                                      onClick={() => setEditing({ mode: "edit", trip: t })}
                                      className="rounded px-1 py-0.5 text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
                                    >
                                      ✎
                                    </button>
                                    <button
                                      onClick={() => setConfirmDel(t)}
                                      className="rounded px-1 py-0.5 text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
                                    >
                                      🗑
                                    </button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : (
              <div className="py-8 text-center text-sm text-[var(--color-muted)]">Selecciona un día</div>
            )}
          </div>
        </div>
      </Modal>

      <TripEditModal
        open={!!editing}
        onClose={() => setEditing(null)}
        trip={editing?.mode === "edit" ? editing.trip : null}
        carriers={activeCarriers}
        days={days}
        defaultDate={editing?.mode === "new" ? editing.date : selectedDate}
        cycleId={cycle?.id}
        onSave={handleSave}
      />

      <ConfirmDialog
        open={!!confirmDel}
        onCancel={() => setConfirmDel(null)}
        onConfirm={handleDelete}
        title="Eliminar vuelta"
        message="¿Eliminar esta vuelta? Solo se pueden eliminar vueltas pendientes."
      />
    </>
  );
}

// Combobox con typeahead para elegir transportista. Pensado para listas de
// 50+ carriers donde un <select> nativo es incómodo. Filtra contra alias,
// nombre y aliases de vehículos. Cuando la query está vacía muestra una
// sección "Recientes" arriba (últimos N usados en este ciclo) seguida del
// resto alfabético. Navegación con ↑/↓ + Enter, Esc cierra. Click en
// "+ Nuevo" delega al callback `onCreateNew` para abrir el QuickCreate.
function CarrierCombobox({ value, onChange, carriers, recentIds, onCreateNew, autoFocus = false }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const wrapperRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const selected = useMemo(
    () => carriers.find((c) => c.id === value) || null,
    [carriers, value],
  );

  // Cierra al hacer click afuera.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e) => {
      if (!wrapperRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const normalize = (s) => String(s || "").toLowerCase();
  const matches = (c, q) => {
    if (!q) return true;
    const hay = [c.alias, c.name, ...(c.vehicles || []).map((v) => v.alias)]
      .map(normalize)
      .join(" ");
    return hay.includes(q);
  };

  const items = useMemo(() => {
    const q = normalize(query.trim());
    const byId = new Map(carriers.map((c) => [c.id, c]));
    if (!q) {
      // Sin query: recientes arriba, luego todos los demás alfabético.
      const recent = (recentIds || [])
        .map((id) => byId.get(id))
        .filter(Boolean);
      const recentSet = new Set(recent.map((c) => c.id));
      const rest = carriers
        .filter((c) => !recentSet.has(c.id))
        .sort((a, b) => normalize(a.alias).localeCompare(normalize(b.alias)));
      const out = [];
      if (recent.length > 0) {
        out.push({ kind: "header", label: "RECIENTES" });
        recent.forEach((c) => out.push({ kind: "item", carrier: c, recent: true }));
        if (rest.length > 0) out.push({ kind: "header", label: "TODOS" });
      }
      rest.forEach((c) => out.push({ kind: "item", carrier: c, recent: false }));
      return out;
    }
    // Con query: filtro plano sin secciones.
    return carriers
      .filter((c) => matches(c, q))
      .sort((a, b) => normalize(a.alias).localeCompare(normalize(b.alias)))
      .map((c) => ({ kind: "item", carrier: c, recent: false }));
  }, [carriers, recentIds, query]);

  const selectableIndexes = useMemo(
    () => items.map((it, i) => (it.kind === "item" ? i : -1)).filter((i) => i >= 0),
    [items],
  );

  useEffect(() => { setFocusIndex(0); }, [query, open]);

  const scrollFocusedIntoView = (idx) => {
    const node = listRef.current?.querySelector(`[data-idx="${idx}"]`);
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "nearest" });
    }
  };

  const moveFocus = (dir) => {
    if (selectableIndexes.length === 0) return;
    const curPos = selectableIndexes.indexOf(focusIndex);
    let next;
    if (curPos === -1) next = selectableIndexes[0];
    else {
      const nextPos = (curPos + dir + selectableIndexes.length) % selectableIndexes.length;
      next = selectableIndexes[nextPos];
    }
    setFocusIndex(next);
    scrollFocusedIntoView(next);
  };

  const pick = (carrier) => {
    if (!carrier) return;
    onChange(carrier.id);
    setQuery("");
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (!open) setOpen(true); else moveFocus(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveFocus(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[focusIndex];
      if (it?.kind === "item") pick(it.carrier);
    }
    else if (e.key === "Escape") { setOpen(false); }
  };

  const clearSelection = () => {
    onChange("");
    setQuery("");
    setOpen(true);
    inputRef.current?.focus();
  };

  // Label que se muestra cuando hay carrier elegido y el combobox está cerrado.
  const selectedLabel = selected
    ? `${selected.alias}${selected.name ? ` — ${selected.name}` : ""}${selected.type === "own" ? " (propio)" : ""}`
    : "";

  return (
    <label className="block" ref={wrapperRef}>
      <span className="mb-1 block text-sm text-[var(--color-muted)]">
        Transportista<span className="ml-0.5 text-[var(--color-danger)]">*</span>
      </span>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={open ? query : selectedLabel}
          placeholder={selected ? "" : "Buscar por alias, nombre o vehículo…"}
          onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 pr-16 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
          {selected && (
            <button
              type="button"
              onClick={clearSelection}
              title="Limpiar"
              className="rounded px-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]"
            >
              ✕
            </button>
          )}
          <button
            type="button"
            onClick={() => { setOpen((v) => !v); inputRef.current?.focus(); }}
            className="rounded px-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]"
            tabIndex={-1}
          >
            ▾
          </button>
        </div>
        {open && (
          <div
            ref={listRef}
            className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
          >
            {items.length === 0 ? (
              <div className="px-3 py-3 text-center text-xs text-[var(--color-muted)]">
                Sin coincidencias.
              </div>
            ) : (
              items.map((it, i) => {
                if (it.kind === "header") {
                  return (
                    <div
                      key={`h${i}`}
                      className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]"
                    >
                      {it.label}
                    </div>
                  );
                }
                const c = it.carrier;
                const isFocused = focusIndex === i;
                const isSelected = c.id === value;
                return (
                  <button
                    key={c.id}
                    type="button"
                    data-idx={i}
                    onMouseEnter={() => setFocusIndex(i)}
                    onClick={() => pick(c)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                      isFocused ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : ""
                    } ${isSelected ? "font-medium" : ""}`}
                  >
                    {it.recent && <span className="text-[10px] opacity-70">🕒</span>}
                    <span className="truncate flex-1">
                      <span>{c.alias}</span>
                      {c.name && <span className="ml-1 text-[11px] text-[var(--color-muted)]">— {c.name}</span>}
                      {c.type === "own" && <span className="ml-1 text-[10px] text-[var(--color-muted)]">(propio)</span>}
                    </span>
                    {(c.vehicles?.length || 0) > 0 && (
                      <span className="text-[10px] text-[var(--color-muted)]">
                        {c.vehicles.length} veh.
                      </span>
                    )}
                  </button>
                );
              })
            )}
            <div className="border-t border-[var(--color-border)] pt-1">
              <button
                type="button"
                onClick={() => { setOpen(false); onCreateNew?.(); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
              >
                + Nuevo transportista
              </button>
            </div>
          </div>
        )}
      </div>
    </label>
  );
}

export function TripEditModal({ open, onClose, trip, carriers, days, defaultDate, cycleId, onSave }) {
  const [carrierId, setCarrierId] = useState("");
  const [vehicleAlias, setVehicleAlias] = useState("");
  const [date, setDate] = useState(defaultDate || "");
  const [kind, setKind] = useState("regular");
  const [qty, setQty] = useState(1);
  const [rate, setRate] = useState(0);
  const [lugar, setLugar] = useState("");
  const [destino, setDestino] = useState("");
  const [personCount, setPersonCount] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [creatingCarrier, setCreatingCarrier] = useState(false);
  const [recentIds, setRecentIds] = useState([]);

  useEffect(() => {
    if (!open) return;
    setRecentIds(loadRecents(cycleId));
  }, [open, cycleId]);

  useEffect(() => {
    if (!open) return;
    if (trip) {
      setCarrierId(trip.carrierId || "");
      setVehicleAlias(trip.vehicleAlias || "");
      setDate(trip.date || defaultDate || "");
      setKind(trip.kind || "regular");
      setQty(trip.qty || 1);
      setRate(trip.rate || 0);
      setLugar(trip.lugar || "");
      setDestino(trip.destino || "");
      setPersonCount(trip.personCount ?? "");
      setNotes(trip.notes || "");
    } else {
      setCarrierId("");
      setVehicleAlias("");
      setDate(defaultDate || "");
      setKind("regular");
      setQty(1);
      setRate(0);
      setLugar("");
      setDestino("");
      setPersonCount("");
      setNotes("");
    }
    setError("");
  }, [open, trip, defaultDate]);

  const carrier = carriers.find((c) => c.id === carrierId);
  const isOwn = carrier?.type === "own";

  // Cuando el carrier cambia, si tiene un solo vehículo lo auto-seleccionamos
  // — ahorra un click en el caso común. Si tiene varios, pre-selecciona el
  // primero (el usuario aún puede cambiarlo).
  const handleCarrierChange = (nextId) => {
    setCarrierId(nextId);
    const c = carriers.find((x) => x.id === nextId);
    const vehicles = c?.vehicles || [];
    if (vehicles.length > 0 && (vehicles.length === 1 || !vehicleAlias)) {
      setVehicleAlias(vehicles[0].alias);
    } else if (vehicles.length === 0) {
      setVehicleAlias("");
    }
  };

  useEffect(() => {
    if (!open || trip) return;
    if (isOwn) setRate(0);
    else if (carrier?.defaultRate) setRate(carrier.defaultRate);
  }, [carrierId, open, trip, isOwn, carrier]);

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (!carrierId) return setError("Selecciona transportista");
    if (!vehicleAlias) return setError("Selecciona vehículo");
    if (!date) return setError("Selecciona fecha");
    setSaving(true);
    try {
      await onSave({
        carrierId,
        vehicleAlias,
        date,
        kind,
        qty: Number(qty) || 1,
        rate: isOwn ? 0 : Number(rate) || 0,
        lugar,
        destino,
        personCount,
        notes,
      });
      pushRecent(cycleId, carrierId);
    } catch (err) {
      setError(err.message || "Error al guardar");
    } finally {
      setSaving(false);
    }
  };

  const vehicleOptions = (carrier?.vehicles || []).map((v) => ({ value: v.alias, label: v.alias }));
  const dayOptions = (days || []).map((d) => ({ value: d, label: d }));
  const kindOptions = TRIP_KINDS.map((k) => ({ value: k.value, label: k.label }));
  const amount = (Number(qty) || 0) * (Number(rate) || 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={trip ? "Editar vuelta" : "Agregar vuelta"}
      size="lg"
      footer={
        <>
          <button onClick={onClose} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {saving ? "Guardando..." : "Guardar"}
          </button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3">
        <CarrierCombobox
          value={carrierId}
          onChange={handleCarrierChange}
          carriers={carriers}
          recentIds={recentIds}
          onCreateNew={() => setCreatingCarrier(true)}
          autoFocus={!trip}
        />
        <Select
          label="Vehículo"
          value={vehicleAlias}
          onChange={setVehicleAlias}
          options={vehicleOptions}
          required
          placeholder={carrier ? "Selecciona..." : "Elige transportista primero"}
        />
        {dayOptions.length > 0 ? (
          <Select label="Fecha" value={date} onChange={setDate} options={dayOptions} required />
        ) : (
          <TextField label="Fecha" type="date" value={date} onChange={setDate} required />
        )}
        <Select label="Tipo" value={kind} onChange={setKind} options={kindOptions} />
        <TextField label="Lugar (origen)" value={lugar} onChange={setLugar} placeholder="ej: C.ALTO/PURRANQUE" />
        <TextField label="Destino" value={destino} onChange={setDestino} placeholder="ej: FRESIA" />
        <TextField label="N° personas" type="number" value={personCount} onChange={setPersonCount} />
        <TextField label="Vueltas (qty)" type="number" value={qty} onChange={setQty} />
        <TextField
          label={isOwn ? "Tarifa (propio = 0)" : "Tarifa por vuelta"}
          type="number"
          value={isOwn ? 0 : rate}
          onChange={(v) => !isOwn && setRate(v)}
        />
        <div className="flex items-center justify-between rounded-md bg-[var(--color-surface-2)] px-3 py-2 text-sm">
          <span className="text-[var(--color-muted)]">Monto</span>
          <span className="font-semibold tabular-nums">{fmtCurrency(amount)}</span>
        </div>
        <div className="col-span-2">
          <TextField label="Notas" value={notes} onChange={setNotes} />
        </div>
        {error && <div className="col-span-2 text-sm text-[var(--color-danger)]">{error}</div>}
      </form>

      <QuickCreateCarrierModal
        open={creatingCarrier}
        onClose={() => setCreatingCarrier(false)}
        onCreated={(created) => {
          setCreatingCarrier(false);
          if (!created?.id) return;
          // handleCarrierChange ya auto-pre-selecciona el primer vehículo.
          handleCarrierChange(created.id);
        }}
      />
    </Modal>
  );
}

// Modal liviano para dar de alta un transportista sin salir del flujo de
// agregar vuelta. Pide solo lo mínimo (alias, nombre, tipo, un vehículo);
// edición completa sigue viviendo en el módulo de Transportes.
function QuickCreateCarrierModal({ open, onClose, onCreated }) {
  const { addCarrier } = useCarriers();
  const [alias, setAlias] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("contracted");
  const [defaultRate, setDefaultRate] = useState("");
  const [vehicleAlias, setVehicleAlias] = useState("");
  const [plate, setPlate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setAlias("");
    setName("");
    setType("contracted");
    setDefaultRate("");
    setVehicleAlias("");
    setPlate("");
    setError("");
  }, [open]);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!alias.trim()) return setError("Alias requerido");
    if (!name.trim()) return setError("Nombre requerido");
    if (!vehicleAlias.trim()) return setError("Agregá al menos un vehículo");
    setBusy(true);
    try {
      const created = await addCarrier({
        alias: alias.trim(),
        name: name.trim(),
        type,
        defaultRate: type === "contracted" ? Number(defaultRate) || 0 : 0,
        vehicles: [
          {
            alias: vehicleAlias.trim(),
            plate: plate.trim() || undefined,
          },
        ],
      });
      onCreated?.(created);
    } catch (err) {
      setError(err.message || "Error al crear");
    } finally {
      setBusy(false);
    }
  };

  const typeOptions = CARRIER_TYPES.map((t) => ({ value: t.value, label: t.label }));

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      title="Nuevo transportista"
      size="md"
      footer={(
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {busy ? "Creando..." : "Crear"}
          </button>
        </>
      )}
    >
      <form onSubmit={submit} className="grid grid-cols-2 gap-3">
        <TextField label="Alias" value={alias} onChange={setAlias} required autoFocus placeholder="ej: JC" />
        <TextField label="Nombre" value={name} onChange={setName} required placeholder="ej: Juan Cárcamo" />
        <Select label="Tipo" value={type} onChange={setType} options={typeOptions} />
        {type === "contracted" && (
          <TextField
            label="Tarifa por defecto"
            type="number"
            value={defaultRate}
            onChange={setDefaultRate}
            placeholder="ej: 25000"
          />
        )}
        <TextField label="Vehículo (alias)" value={vehicleAlias} onChange={setVehicleAlias} required placeholder="ej: Camión 1" />
        <TextField label="Patente" value={plate} onChange={setPlate} placeholder="opcional" />
        {error && <div className="col-span-2 text-sm text-[var(--color-danger)]">{error}</div>}
        <p className="col-span-2 text-[11px] text-[var(--color-muted)]">
          Para agregar más vehículos o ajustar otros datos, editá el transportista desde el módulo de Transportes.
        </p>
      </form>
    </Modal>
  );
}
