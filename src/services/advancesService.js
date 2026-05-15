// Anticipos & Bonos — single collection with type discriminator.
// type "anticipo": descuento sobre la próxima nómina (sign = -1).
// type "bono":     suma sobre la próxima nómina (sign = +1).
//
// Legacy "adelanto" se normaliza a "anticipo" al leer (mismo signo, mismo flujo).
//
// Doc shape:
//   id, type, workerRut, workerName, amount, date, note,
//   status: "pending" | "partial" | "applied" | "cancelled",
//   amountPaid: number (sum of payments[]),
//   payments: [{ payrollId, amount, paidAt }],
//   appliedPayrollId: string | null  (last payroll that touched it; legacy)
//   appliedAt, appliedBy
//
// "pending"  → no amount applied yet (or amountPaid == 0).
// "partial"  → amountPaid > 0 but < amount; can keep being applied.
// "applied"  → amountPaid >= amount.
import { writeBatch, doc, getDoc, serverTimestamp } from "firebase/firestore";
import { db, auth } from "../firebase";
import { createService } from "./firestoreBase";

export const ADVANCE_TYPES = [
  { value: "anticipo", label: "Anticipo", icon: "🪙", sign: -1 },
  { value: "bono",     label: "Bono",     icon: "🎁", sign: +1 },
];

const LEGACY_TYPE_MAP = { adelanto: "anticipo" };

export function normalizeAdvanceType(type) {
  return LEGACY_TYPE_MAP[type] || type || "anticipo";
}

export function advanceSign(advOrType) {
  const t = typeof advOrType === "string" ? advOrType : advOrType?.type;
  return normalizeAdvanceType(t) === "bono" ? +1 : -1;
}

export function isBono(advOrType) {
  return advanceSign(advOrType) > 0;
}

export function advanceTypeMeta(type) {
  const t = normalizeAdvanceType(type);
  return ADVANCE_TYPES.find((x) => x.value === t) || ADVANCE_TYPES[0];
}

export const advancesService = createService("advance", "advances");

export async function listPendingForWorkers(workerRuts) {
  // Firestore caps disjunctive normal form at 30. Two compound `in` filters
  // multiply: 30 ruts × 2 statuses = 60 → too many disjunctions. We keep the
  // workerRut chunk at 15 and filter status client-side to stay under the
  // limit even if the status set grows in the future.
  const out = [];
  const seen = new Set();
  const ruts = [...new Set(workerRuts)].filter(Boolean);
  const PENDING_STATUSES = new Set(["pending", "partial"]);
  for (let i = 0; i < ruts.length; i += 15) {
    const chunk = ruts.slice(i, i + 15);
    const list = await advancesService.list({
      wheres: [["workerRut", "in", chunk]],
    });
    for (const a of list) {
      if (seen.has(a.id)) continue;
      // Legacy docs without a `status` field are treated as pending.
      const st = a.status || "pending";
      if (!PENDING_STATUSES.has(st)) continue;
      seen.add(a.id);
      out.push(a);
    }
  }
  return out;
}

// Helper: how much of an advance is still owed.
export function advanceRemaining(adv) {
  const amount = Number(adv?.amount) || 0;
  const paid = Number(adv?.amountPaid) || 0;
  return Math.max(0, amount - paid);
}

export async function listAllPending() {
  return advancesService.list({
    wheres: [["status", "==", "pending"]],
    order: ["date", "desc"],
  });
}

export async function listAll() {
  return advancesService.list({ order: ["date", "desc"] });
}

// Apply partial / full payments against advances.
// `applications`: [{ advanceId, amount }]  — `amount` is what this payroll
// actually paid against that advance. The advance's status flips to "partial"
// or "applied" depending on whether amountPaid reaches the full amount.
export async function applyAdvancesToPayroll(applications, payrollId) {
  if (!applications || applications.length === 0) return;
  // Fetch each advance to compute its new amountPaid + status.
  const docs = await Promise.all(
    applications.map(async (app) => {
      const snap = await getDoc(doc(db, "advances", app.advanceId));
      return { app, data: snap.exists() ? snap.data() : null };
    }),
  );

  const now = new Date(); // serverTimestamp() can't be used inside arrayUnion
  const uid = auth.currentUser?.uid || null;
  const chunkSize = 450;
  for (let i = 0; i < docs.length; i += chunkSize) {
    const batch = writeBatch(db);
    for (const { app, data } of docs.slice(i, i + chunkSize)) {
      if (!data) continue;
      const total = Number(data.amount) || 0;
      const prevPaid = Number(data.amountPaid) || 0;
      const newPaid = Math.min(total, prevPaid + (Number(app.amount) || 0));
      const status = newPaid >= total && total > 0 ? "applied" : (newPaid > 0 ? "partial" : "pending");
      const payments = Array.isArray(data.payments) ? [...data.payments] : [];
      payments.push({ payrollId, amount: Number(app.amount) || 0, paidAt: now.toISOString() });
      batch.update(doc(db, "advances", app.advanceId), {
        status,
        amountPaid: newPaid,
        payments,
        appliedPayrollId: payrollId,
        appliedAt: serverTimestamp(),
        appliedBy: uid,
      });
    }
    await batch.commit();
  }
  advancesService.invalidate();
}

// Reverse the payments[] entries that match `payrollId`. If no other payroll
// has paid against it, the advance returns to "pending"; otherwise it stays
// "partial" with the reduced amountPaid.
export async function restoreAdvancesFromPayroll(advanceIds, payrollId) {
  if (!advanceIds || advanceIds.length === 0) return;
  const docs = await Promise.all(
    advanceIds.map(async (id) => {
      const snap = await getDoc(doc(db, "advances", id));
      return { id, data: snap.exists() ? snap.data() : null };
    }),
  );
  const chunkSize = 450;
  for (let i = 0; i < docs.length; i += chunkSize) {
    const batch = writeBatch(db);
    for (const { id, data } of docs.slice(i, i + chunkSize)) {
      if (!data) continue;
      const total = Number(data.amount) || 0;
      const payments = Array.isArray(data.payments) ? data.payments : [];
      const remainingPayments = payments.filter((p) => p.payrollId !== payrollId);
      const newPaid = remainingPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const status = newPaid >= total && total > 0 ? "applied" : (newPaid > 0 ? "partial" : "pending");
      batch.update(doc(db, "advances", id), {
        status,
        amountPaid: newPaid,
        payments: remainingPayments,
        // Best effort: clear appliedPayrollId only if this was the last pointer.
        appliedPayrollId: status === "pending" ? null : (data.appliedPayrollId === payrollId ? null : data.appliedPayrollId),
        appliedAt: status === "pending" ? null : data.appliedAt,
      });
    }
    await batch.commit();
  }
  advancesService.invalidate();
}
