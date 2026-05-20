import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  where,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import { db, auth } from "../firebase";
import { logAction } from "./logger";

const TRIPS = "transports";
const PAYMENTS = "transportPayments";
const PAYROLLS = "transportPayrolls";

export const TRIP_KINDS = [
  { value: "regular", label: "Vuelta" },
  { value: "approach", label: "Acercamiento" },
];

export const tripKindLabel = (k) =>
  TRIP_KINDS.find((x) => x.value === k)?.label || k;

const stamp = () => ({
  updatedAt: serverTimestamp(),
  updatedBy: auth.currentUser?.uid || null,
});

const withCreate = () => ({
  createdAt: serverTimestamp(),
  createdBy: auth.currentUser?.uid || null,
  ...stamp(),
});

// ============================================================
// TRIPS
// ============================================================

function normalizeTrip(data) {
  const qty = Number(data.qty) || 1;
  const rate = Number(data.rate) || 0;
  const personCount = data.personCount === "" || data.personCount == null ? null : Number(data.personCount) || 0;
  return {
    carrierId: data.carrierId,
    vehicleAlias: String(data.vehicleAlias || "").trim(),
    cycleId: data.cycleId,
    faenaId: data.faenaId || null,
    subfaenaId: data.subfaenaId || null,
    date: data.date,
    kind: data.kind === "approach" ? "approach" : "regular",
    qty,
    rate,
    amount: qty * rate,
    lugar: data.lugar ? String(data.lugar).trim() : "",
    destino: data.destino ? String(data.destino).trim() : "",
    personCount,
    notes: data.notes ? String(data.notes).trim() : "",
    status: data.status || "pending",
    paymentId: data.paymentId || null,
  };
}

export const tripsService = {
  async listByCycle(cycleId) {
    const q = query(collection(db, TRIPS), where("cycleId", "==", cycleId));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  // Push the status filter to Firestore when caller only wants pending trips.
  async listByCarrier(carrierId, { onlyPending = false } = {}) {
    const parts = [where("carrierId", "==", carrierId)];
    if (onlyPending) parts.push(where("status", "==", "pending"));
    const q = query(collection(db, TRIPS), ...parts);
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  // Reads everything in the collection. Avoid in screens — it grows unbounded.
  // Prefer listSince() to bound by date.
  async listAll() {
    const snap = await getDocs(collection(db, TRIPS));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  // Server-side filter by date string (YYYY-MM-DD). Optionally also by status.
  async listSince(sinceDate, { status } = {}) {
    const parts = [where("date", ">=", String(sinceDate || ""))];
    if (status) parts.push(where("status", "==", status));
    const q = query(collection(db, TRIPS), ...parts);
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  // Pending trips not yet linked to a payment summary. paymentId==null filter
  // is applied in JS because Firestore doesn't index missing fields uniformly.
  async listPendingUnlinked() {
    const q = query(collection(db, TRIPS), where("status", "==", "pending"));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => !t.paymentId);
  },

  async create(data) {
    const payload = { ...normalizeTrip(data), ...withCreate() };
    const ref = await addDoc(collection(db, TRIPS), payload);
    await logAction({ action: "create", entity: "transport", entityId: ref.id, after: payload });
    return { id: ref.id, ...payload };
  },

  async update(id, data) {
    const before = (await getDoc(doc(db, TRIPS, id))).data();
    if (before?.status === "paid") throw new Error("No se puede editar una vuelta pagada");
    const payload = { ...normalizeTrip({ ...before, ...data }), ...stamp() };
    await updateDoc(doc(db, TRIPS, id), payload);
    await logAction({ action: "update", entity: "transport", entityId: id, before, after: payload });
    return { id, ...payload };
  },

  async remove(id) {
    const before = (await getDoc(doc(db, TRIPS, id))).data();
    if (before?.status === "paid") throw new Error("No se puede eliminar una vuelta pagada");
    await deleteDoc(doc(db, TRIPS, id));
    await logAction({ action: "delete", entity: "transport", entityId: id, before });
  },
};

// ============================================================
// PAYMENTS (resúmenes)
// ============================================================

// Filtra una lista de tripIds y devuelve solo los que existen actualmente
// en Firestore. Necesario porque un resumen pending puede tener referencias
// a vueltas que el usuario borró después (las pending son borrables) — si
// el batch luego intenta `.update()` esos IDs falla con "No document to
// update" y aborta toda la operación.
async function filterExistingTripIds(tripIds) {
  if (!tripIds || tripIds.length === 0) return [];
  const snaps = await Promise.all(tripIds.map((id) => getDoc(doc(db, TRIPS, id))));
  return tripIds.filter((_, i) => snaps[i].exists());
}

export const paymentsService = {
  async listByCarrier(carrierId) {
    const q = query(collection(db, PAYMENTS), where("carrierId", "==", carrierId));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  async listAll() {
    const snap = await getDocs(collection(db, PAYMENTS));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  // Recent summaries only (filters by createdAt timestamp).
  async listSince(sinceDate) {
    const ts = sinceDate instanceof Date ? sinceDate : new Date(sinceDate);
    const q = query(collection(db, PAYMENTS), where("createdAt", ">=", ts));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  async getById(id) {
    const s = await getDoc(doc(db, PAYMENTS, id));
    return s.exists() ? { id: s.id, ...s.data() } : null;
  },

  // Build a pending summary from currently-pending trips of a carrier within a period.
  // Returns { trips, total } without persisting.
  async previewSummary({ carrierId, periodFrom, periodTo }) {
    const trips = (await tripsService.listByCarrier(carrierId, { onlyPending: true }))
      .filter((t) => !t.paymentId)
      .filter((t) => (!periodFrom || t.date >= periodFrom) && (!periodTo || t.date <= periodTo))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const total = trips.reduce((s, t) => s + (Number(t.amount) || 0), 0);
    return { trips, total };
  },

  // Persist a pending summary linking the given trips.
  async createSummary({ carrierId, periodFrom, periodTo, groupBy = "day", tripIds, total, notes = "" }) {
    const payload = {
      carrierId,
      periodFrom: periodFrom || null,
      periodTo: periodTo || null,
      groupBy,
      tripIds: [...tripIds],
      total: Number(total) || 0,
      status: "pending",
      paidAt: null,
      paidBy: null,
      notes,
      ...withCreate(),
    };
    const ref = await addDoc(collection(db, PAYMENTS), payload);
    // link trips → paymentId
    const batch = writeBatch(db);
    for (const tid of tripIds) {
      batch.update(doc(db, TRIPS, tid), { paymentId: ref.id, ...stamp() });
    }
    await batch.commit();
    await logAction({ action: "create", entity: "transportPayment", entityId: ref.id, after: payload });
    return { id: ref.id, ...payload };
  },

  // Add or remove trips from a pending summary.
  async editSummaryTrips(paymentId, { addTripIds = [], removeTripIds = [] }) {
    const before = await this.getById(paymentId);
    if (!before) throw new Error("Resumen no encontrado");
    if (before.status !== "pending") throw new Error("Solo se pueden editar resúmenes pendientes");
    const ids = new Set(before.tripIds || []);
    for (const id of addTripIds) ids.add(id);
    for (const id of removeTripIds) ids.delete(id);
    const tripIds = [...ids];

    // Recalculate total from current trip amounts
    let total = 0;
    const tripDocs = await Promise.all(tripIds.map((id) => getDoc(doc(db, TRIPS, id))));
    for (const s of tripDocs) {
      if (s.exists()) total += Number(s.data().amount) || 0;
    }

    const batch = writeBatch(db);
    batch.update(doc(db, PAYMENTS, paymentId), { tripIds, total, ...stamp() });
    for (const id of addTripIds) batch.update(doc(db, TRIPS, id), { paymentId, ...stamp() });
    for (const id of removeTripIds) batch.update(doc(db, TRIPS, id), { paymentId: null, ...stamp() });
    await batch.commit();
    await logAction({
      action: "update",
      entity: "transportPayment",
      entityId: paymentId,
      before,
      after: { ...before, tripIds, total },
    });
  },

  // Actualiza solo el `total` del resumen (recalculado en cliente después de
  // editar el `amount` de alguna vuelta vinculada). Pago bloqueado para
  // resúmenes ya `paid`.
  async updateTotal(paymentId, total) {
    const before = await this.getById(paymentId);
    if (!before) throw new Error("Resumen no existe");
    if (before.status === "paid") throw new Error("Resumen pagado no editable");
    await updateDoc(doc(db, PAYMENTS, paymentId), {
      total: Number(total) || 0,
      ...stamp(),
    });
  },

  // Delete a pending summary; trips are unlinked (status remains pending).
  // Si alguna vuelta referenciada ya fue borrada por separado (el resumen
  // arrastra el ID dangling), la salteamos para que el batch no aborte
  // entero con "No document to update".
  async deleteSummary(paymentId) {
    const before = await this.getById(paymentId);
    if (!before) return;
    if (before.status !== "pending") throw new Error("Solo se pueden eliminar resúmenes pendientes");
    const tripIds = before.tripIds || [];
    const existingTripIds = await filterExistingTripIds(tripIds);
    const batch = writeBatch(db);
    for (const tid of existingTripIds) {
      batch.update(doc(db, TRIPS, tid), { paymentId: null, ...stamp() });
    }
    batch.delete(doc(db, PAYMENTS, paymentId));
    await batch.commit();
    await logAction({ action: "delete", entity: "transportPayment", entityId: paymentId, before });
  },

  // Mark summary as paid: all linked trips → status=paid.
  async markPaid(paymentId) {
    const before = await this.getById(paymentId);
    if (!before) throw new Error("Resumen no encontrado");
    if (before.status === "paid") return;
    const tripIds = before.tripIds || [];
    const existingTripIds = await filterExistingTripIds(tripIds);
    const batch = writeBatch(db);
    batch.update(doc(db, PAYMENTS, paymentId), {
      status: "paid",
      paidAt: serverTimestamp(),
      paidBy: auth.currentUser?.uid || null,
      ...stamp(),
    });
    for (const tid of existingTripIds) {
      batch.update(doc(db, TRIPS, tid), { status: "paid", ...stamp() });
    }
    await batch.commit();
    await logAction({
      action: "update",
      entity: "transportPayment",
      entityId: paymentId,
      before,
      after: { ...before, status: "paid" },
    });
  },

  // Revert a paid summary back to pending (trips → pending).
  async revertPaid(paymentId) {
    const before = await this.getById(paymentId);
    if (!before) throw new Error("Resumen no encontrado");
    if (before.status !== "paid") return;
    const tripIds = before.tripIds || [];
    const existingTripIds = await filterExistingTripIds(tripIds);
    const batch = writeBatch(db);
    batch.update(doc(db, PAYMENTS, paymentId), {
      status: "pending",
      paidAt: null,
      paidBy: null,
      ...stamp(),
    });
    for (const tid of existingTripIds) {
      batch.update(doc(db, TRIPS, tid), { status: "pending", ...stamp() });
    }
    await batch.commit();
    await logAction({
      action: "update",
      entity: "transportPayment",
      entityId: paymentId,
      before,
      after: { ...before, status: "pending" },
    });
  },
};

// ============================================================
// PAYROLLS (quincenas — agrupan resúmenes de varios transportistas)
// ============================================================
//
// Modelo: una "quincena" es un payroll que agrupa N resúmenes de pago
// (transportPayments) existentes — usualmente cubre ~15 días pero no es
// estricto (es solo un grupo lógico con nombre + rango de fechas opcional).
//
// Relación: quincena → N resúmenes → N vueltas. Cada `transportPayment` puede
// tener `payrollId` apuntando a su quincena (o null si está "suelto").
//
// Status cascade:
//   - markPaid(quincena) → marca todos sus resúmenes como pagados → marca
//     todas las vueltas de cada resumen como pagadas.
//   - markItemPaid(quincena, paymentId) → solo marca ese resumen y sus
//     vueltas; la quincena queda en pending hasta que todos los items
//     estén pagados o el usuario la marque explícitamente.
//   - revertPaid → cascada inversa.

export const transportPayrollsService = {
  async listAll() {
    const snap = await getDocs(collection(db, PAYROLLS));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  async getById(id) {
    const s = await getDoc(doc(db, PAYROLLS, id));
    return s.exists() ? { id: s.id, ...s.data() } : null;
  },

  // Crea una quincena enlazando los `paymentIds` indicados. Cada resumen
  // queda tagged con `payrollId = <nueva quincena>`. Falla si algún resumen
  // ya pertenece a otra quincena (relación 1:N estricta).
  async create({ name, periodFrom, periodTo, paymentIds = [], notes = "" }) {
    if (!name || !String(name).trim()) throw new Error("Falta nombre de la quincena");
    // Validar que ninguno esté ya enlazado a otro payroll.
    const payDocs = await Promise.all(paymentIds.map((pid) => getDoc(doc(db, PAYMENTS, pid))));
    let total = 0;
    for (const s of payDocs) {
      if (!s.exists()) throw new Error("Resumen referenciado no existe");
      const d = s.data();
      if (d.payrollId) throw new Error(`El resumen "${s.id}" ya está en otra quincena`);
      total += Number(d.total) || 0;
    }
    const payload = {
      name: String(name).trim(),
      periodFrom: periodFrom || null,
      periodTo: periodTo || null,
      paymentIds: [...paymentIds],
      total,
      status: "pending",
      paidAt: null,
      paidBy: null,
      notes: String(notes || "").trim(),
      ...withCreate(),
    };
    const ref = await addDoc(collection(db, PAYROLLS), payload);
    const batch = writeBatch(db);
    for (const pid of paymentIds) {
      batch.update(doc(db, PAYMENTS, pid), { payrollId: ref.id, ...stamp() });
    }
    await batch.commit();
    await logAction({ action: "create", entity: "transportPayroll", entityId: ref.id, after: payload });
    return { id: ref.id, ...payload };
  },

  // Cambiar metadata (nombre/fechas/notas). No toca la lista de resúmenes
  // — para eso usar `addPayments` / `removePayments`.
  async update(id, { name, periodFrom, periodTo, notes }) {
    const before = await this.getById(id);
    if (!before) throw new Error("Quincena no encontrada");
    if (before.status === "paid") throw new Error("La quincena está pagada — revertí el pago antes de editar.");
    const patch = { ...stamp() };
    if (name != null) patch.name = String(name).trim();
    if (periodFrom !== undefined) patch.periodFrom = periodFrom || null;
    if (periodTo !== undefined) patch.periodTo = periodTo || null;
    if (notes !== undefined) patch.notes = String(notes || "").trim();
    await updateDoc(doc(db, PAYROLLS, id), patch);
    await logAction({ action: "update", entity: "transportPayroll", entityId: id, before, after: { ...before, ...patch } });
  },

  // Agregar resúmenes a una quincena pendiente. Recalcula total.
  async addPayments(id, paymentIds) {
    const before = await this.getById(id);
    if (!before) throw new Error("Quincena no encontrada");
    if (before.status === "paid") throw new Error("No se puede modificar una quincena pagada");
    const payDocs = await Promise.all(paymentIds.map((pid) => getDoc(doc(db, PAYMENTS, pid))));
    for (const s of payDocs) {
      if (!s.exists()) throw new Error("Resumen referenciado no existe");
      const d = s.data();
      if (d.payrollId && d.payrollId !== id) throw new Error(`El resumen "${s.id}" ya está en otra quincena`);
    }
    const newSet = new Set([...(before.paymentIds || []), ...paymentIds]);
    const newIds = [...newSet];
    // Recalc total del set completo.
    const allDocs = await Promise.all(newIds.map((pid) => getDoc(doc(db, PAYMENTS, pid))));
    const total = allDocs.reduce((s, d) => s + (d.exists() ? (Number(d.data().total) || 0) : 0), 0);
    const batch = writeBatch(db);
    batch.update(doc(db, PAYROLLS, id), { paymentIds: newIds, total, ...stamp() });
    for (const pid of paymentIds) {
      batch.update(doc(db, PAYMENTS, pid), { payrollId: id, ...stamp() });
    }
    await batch.commit();
    await logAction({ action: "update", entity: "transportPayroll", entityId: id, before, after: { ...before, paymentIds: newIds, total } });
  },

  // Sacar resúmenes de una quincena pendiente. Los resúmenes quedan "sueltos"
  // (payrollId = null) y siguen existiendo. Recalcula total.
  async removePayments(id, paymentIds) {
    const before = await this.getById(id);
    if (!before) throw new Error("Quincena no encontrada");
    if (before.status === "paid") throw new Error("No se puede modificar una quincena pagada");
    const removeSet = new Set(paymentIds);
    const newIds = (before.paymentIds || []).filter((pid) => !removeSet.has(pid));
    const allDocs = await Promise.all(newIds.map((pid) => getDoc(doc(db, PAYMENTS, pid))));
    const total = allDocs.reduce((s, d) => s + (d.exists() ? (Number(d.data().total) || 0) : 0), 0);
    const batch = writeBatch(db);
    batch.update(doc(db, PAYROLLS, id), { paymentIds: newIds, total, ...stamp() });
    for (const pid of paymentIds) {
      batch.update(doc(db, PAYMENTS, pid), { payrollId: null, ...stamp() });
    }
    await batch.commit();
    await logAction({ action: "update", entity: "transportPayroll", entityId: id, before, after: { ...before, paymentIds: newIds, total } });
  },

  // Eliminar quincena. Los resúmenes quedan sueltos (payrollId = null) — no
  // se borran. Solo permitido si está pendiente.
  async delete(id) {
    const before = await this.getById(id);
    if (!before) return;
    if (before.status === "paid") throw new Error("Solo se pueden eliminar quincenas pendientes — revertí el pago primero.");
    const batch = writeBatch(db);
    for (const pid of before.paymentIds || []) {
      batch.update(doc(db, PAYMENTS, pid), { payrollId: null, ...stamp() });
    }
    batch.delete(doc(db, PAYROLLS, id));
    await batch.commit();
    await logAction({ action: "delete", entity: "transportPayroll", entityId: id, before });
  },

  // Cascada total: la quincena + cada resumen contenido + cada vuelta de
  // cada resumen → status="paid". Usa `paymentsService.markPaid` internamente
  // para que la cascada de payment→trips se mantenga consistente.
  async markPaid(id) {
    const before = await this.getById(id);
    if (!before) throw new Error("Quincena no encontrada");
    if (before.status === "paid") return;
    for (const pid of before.paymentIds || []) {
      const payment = await paymentsService.getById(pid);
      if (payment && payment.status !== "paid") {
        await paymentsService.markPaid(pid);
      }
    }
    await updateDoc(doc(db, PAYROLLS, id), {
      status: "paid",
      paidAt: serverTimestamp(),
      paidBy: auth.currentUser?.uid || null,
      ...stamp(),
    });
    await logAction({ action: "update", entity: "transportPayroll", entityId: id, before, after: { ...before, status: "paid" } });
  },

  // Revertir pago en cascada — vuelve a pending la quincena, sus resúmenes
  // y las vueltas de cada resumen.
  async revertPaid(id) {
    const before = await this.getById(id);
    if (!before) throw new Error("Quincena no encontrada");
    if (before.status !== "paid") return;
    for (const pid of before.paymentIds || []) {
      const payment = await paymentsService.getById(pid);
      if (payment && payment.status === "paid") {
        await paymentsService.revertPaid(pid);
      }
    }
    await updateDoc(doc(db, PAYROLLS, id), {
      status: "pending",
      paidAt: null,
      paidBy: null,
      ...stamp(),
    });
    await logAction({ action: "update", entity: "transportPayroll", entityId: id, before, after: { ...before, status: "pending" } });
  },
};

// ============================================================
// Aggregations
// ============================================================

export function groupTripsByDay(trips) {
  const map = new Map();
  for (const t of trips) {
    if (!map.has(t.date)) map.set(t.date, { date: t.date, trips: [], total: 0 });
    const g = map.get(t.date);
    g.trips.push(t);
    g.total += Number(t.amount) || 0;
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function groupTripsByFaena(trips) {
  const map = new Map();
  for (const t of trips) {
    const key = `${t.faenaId || "?"}__${t.subfaenaId || "?"}`;
    if (!map.has(key)) {
      map.set(key, { key, faenaId: t.faenaId, subfaenaId: t.subfaenaId, trips: [], total: 0 });
    }
    const g = map.get(key);
    g.trips.push(t);
    g.total += Number(t.amount) || 0;
  }
  return [...map.values()];
}
