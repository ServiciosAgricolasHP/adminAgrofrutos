// Anticipos & Adelantos — single collection with type discriminator.
// type "anticipo": adelanto pequeño / vale (suele ir contra el ciclo en curso).
// type "adelanto": préstamo o adelanto mayor contra futuras nóminas.
import { writeBatch, doc, serverTimestamp } from "firebase/firestore";
import { db, auth } from "../firebase";
import { createService } from "./firestoreBase";

export const ADVANCE_TYPES = [
  { value: "anticipo", label: "Anticipo", icon: "🪙" },
  { value: "adelanto", label: "Adelanto", icon: "💸" },
];

export const advancesService = createService("advance", "advances");

export async function listPendingForWorkers(workerRuts) {
  // Firestore "in" supports up to 30 elements per query.
  const out = [];
  const seen = new Set();
  const ruts = [...new Set(workerRuts)].filter(Boolean);
  for (let i = 0; i < ruts.length; i += 30) {
    const chunk = ruts.slice(i, i + 30);
    const list = await advancesService.list({
      wheres: [
        ["workerRut", "in", chunk],
        ["status", "==", "pending"],
      ],
    });
    for (const a of list) {
      if (!seen.has(a.id)) {
        seen.add(a.id);
        out.push(a);
      }
    }
  }
  return out;
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

// Mark a list of advances as "applied" against a payroll.
export async function applyAdvancesToPayroll(advanceIds, payrollId) {
  if (!advanceIds || advanceIds.length === 0) return;
  await batchPatch(advanceIds, {
    status: "applied",
    appliedPayrollId: payrollId,
    appliedAt: serverTimestamp(),
    appliedBy: auth.currentUser?.uid || null,
  });
}

// Restore advances back to "pending" (when payroll is deleted).
export async function restoreAdvancesFromPayroll(advanceIds) {
  if (!advanceIds || advanceIds.length === 0) return;
  await batchPatch(advanceIds, {
    status: "pending",
    appliedPayrollId: null,
    appliedAt: null,
  });
}

async function batchPatch(ids, patch) {
  const chunkSize = 450;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const batch = writeBatch(db);
    const chunk = ids.slice(i, i + chunkSize);
    for (const id of chunk) {
      batch.update(doc(db, "advances", id), patch);
    }
    await batch.commit();
  }
  advancesService.invalidate();
}
