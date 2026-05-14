import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
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

// Aplica un patch a una lista de workdays. Usa `updateDoc` individual con
// concurrencia controlada en vez de `writeBatch.update`. Motivo: si algún
// workday ya no existe (caso típico: un admin eliminó el ciclo en cascada y
// los workdays se borraron, pero la nómina sigue refernciándolos en
// `workdayIds`), `batch.update` falla atómicamente con "No document to
// update". Con `updateDoc` por doc podemos tragar el `not-found` puntual y
// seguir limpiando el resto, permitiendo borrar/revertir la nómina sin
// dejarla huérfana. Para los survivors, esto sigue siendo rápido por la
// concurrencia (Promise.all en chunks).
async function batchUpdateWorkdays(ids, patch) {
  if (!ids || ids.length === 0) return;
  const concurrency = 20;
  let skipped = 0;
  for (let i = 0; i < ids.length; i += concurrency) {
    const chunk = ids.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (id) => {
        try {
          await updateDoc(doc(db, "workdays", id), patch);
        } catch (err) {
          const msg = String(err?.message || "");
          if (err?.code === "not-found" || /No document to update/.test(msg)) {
            skipped += 1;
            return;
          }
          throw err;
        }
      }),
    );
  }
  if (skipped > 0) {
    console.warn(
      `batchUpdateWorkdays: ${skipped}/${ids.length} workdays ya no existen (probablemente borrados con su ciclo). Continuando con los demás.`,
    );
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
