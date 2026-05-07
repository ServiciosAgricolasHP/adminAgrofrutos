import { writeBatch, doc, serverTimestamp } from "firebase/firestore";
import { db, auth } from "../firebase";
import { createService } from "./firestoreBase";
import { workdaysService } from "./index";

export const PAYROLL_STATUSES = [
  { value: "pending", label: "Pendiente" },
  { value: "paid", label: "Pagada" },
];

export const payrollsService = createService("payroll", "payrolls");

// Batched: tag every included workday with payrollId. Firestore batch limit = 500.
export async function tagWorkdaysWithPayroll(workdayIds, payrollId) {
  await batchUpdateWorkdays(workdayIds, {
    payrollId,
    payrollTaggedAt: serverTimestamp(),
    payrollTaggedBy: auth.currentUser?.uid || null,
  });
}

// Used when payroll is deleted — release the workdays.
export async function untagWorkdaysFromPayroll(workdayIds) {
  await batchUpdateWorkdays(workdayIds, { payrollId: null, paidAt: null });
}

// Used when payroll is marked paid — also stamp the workdays.
export async function markWorkdaysPaid(workdayIds) {
  await batchUpdateWorkdays(workdayIds, {
    paidAt: serverTimestamp(),
    paidBy: auth.currentUser?.uid || null,
  });
}

export async function unmarkWorkdaysPaid(workdayIds) {
  await batchUpdateWorkdays(workdayIds, { paidAt: null, paidBy: null });
}

async function batchUpdateWorkdays(ids, patch) {
  if (!ids || ids.length === 0) return;
  const chunkSize = 450;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const batch = writeBatch(db);
    const chunk = ids.slice(i, i + chunkSize);
    for (const id of chunk) {
      batch.update(doc(db, "workdays", id), patch);
    }
    await batch.commit();
  }
  workdaysService.invalidate();
}

export async function markPaid(id, workdayIds = []) {
  await markWorkdaysPaid(workdayIds);
  return payrollsService.update(id, { status: "paid", paidAt: new Date().toISOString() });
}

export async function markPending(id, workdayIds = []) {
  await unmarkWorkdaysPaid(workdayIds);
  return payrollsService.update(id, { status: "pending", paidAt: null });
}
