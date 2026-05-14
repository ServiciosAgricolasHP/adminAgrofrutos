import { doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db, auth } from "../firebase";
import { createService } from "./firestoreBase";
import { workdaysService } from "./index";
import { isCashBank } from "../utils/banks";
import { restoreAdvancesFromPayroll } from "./advancesService";

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

// ───────────────────────── Edición parcial ─────────────────────────
// Estos helpers permiten "achicar" una nómina pendiente sin tener que
// eliminarla entera: sacar un trabajador o sacar todo lo que aporta un ciclo.
// La nómina debe estar en estado `pending`. Si está pagada, hay que revertir
// el pago primero.
//
// Side-effects:
//   - Untag de los workdays involucrados (libera `payrollId`).
//   - Si un item queda totalmente removido, restaura sus anticipos (les saca
//     la entrada de `payments[]` y recalcula el status). Si el item queda
//     parcialmente reducido (caso ciclo: tenía producción en otro ciclo
//     también), los anticipos se mantienen aplicados — el bruto baja pero
//     el descuento ya consumido sigue valiendo.
//   - Recalcula `items`, `total`, `bankTotal`, `cashTotal`, `workerCount`,
//     `bankCount`, `cashCount`, `workdayIds`, `advanceIds`, `advanceTotal`.

function recalcPayrollAggregates(items) {
  const bank = items.filter((it) => !isCashBank(it.bankCode));
  const cash = items.filter((it) => isCashBank(it.bankCode));
  return {
    items,
    total: items.reduce((s, x) => s + (Number(x.amount) || 0), 0),
    bankTotal: bank.reduce((s, x) => s + (Number(x.amount) || 0), 0),
    cashTotal: cash.reduce((s, x) => s + (Number(x.amount) || 0), 0),
    advanceTotal: items.reduce((s, x) => s + (Number(x.advance) || 0), 0),
    workerCount: items.length,
    bankCount: bank.length,
    cashCount: cash.length,
    workdayIds: items.flatMap((x) => x.workdayIds || []),
    advanceIds: items.flatMap((x) => x.advanceIds || []),
  };
}

export async function removeWorkerFromPayroll(payrollId, workerRut) {
  const p = await payrollsService.getById(payrollId);
  if (!p) throw new Error("Nómina no encontrada");
  if (p.status === "paid") {
    throw new Error("La nómina está pagada — revertí el pago antes de editar.");
  }
  const items = Array.isArray(p.items) ? p.items : [];
  const item = items.find((it) => it.rut === workerRut);
  if (!item) throw new Error(`Trabajador ${workerRut} no está en esta nómina`);

  await untagWorkdaysFromPayroll(item.workdayIds || []);
  if ((item.advanceIds || []).length) {
    await restoreAdvancesFromPayroll(item.advanceIds, payrollId);
  }

  const newItems = items.filter((it) => it.rut !== workerRut);
  const aggregates = recalcPayrollAggregates(newItems);
  await payrollsService.update(payrollId, aggregates);
}

export async function removeCycleFromPayroll(payrollId, cycleId) {
  const p = await payrollsService.getById(payrollId);
  if (!p) throw new Error("Nómina no encontrada");
  if (p.status === "paid") {
    throw new Error("La nómina está pagada — revertí el pago antes de editar.");
  }
  const items = Array.isArray(p.items) ? p.items : [];
  // Los workday docIds llevan el cycleId como prefijo
  // (`{cycleId}__{laborId}__{rut}__{date}[__{ck}]`), así que podemos
  // identificar qué workdays son de este ciclo sin leer cada doc.
  const cyclePrefix = `${cycleId}__`;

  const orphanWorkdayIds = [];
  const advancesToRestore = [];
  const newItems = [];

  for (const it of items) {
    const cycleAmount = Number(it.byCycle?.[cycleId]) || 0;
    if (cycleAmount === 0) {
      // El trabajador no tenía nada de este ciclo — queda igual.
      newItems.push(it);
      continue;
    }
    const cycleWdIds = (it.workdayIds || []).filter((wid) => wid.startsWith(cyclePrefix));
    orphanWorkdayIds.push(...cycleWdIds);
    const remainingWdIds = (it.workdayIds || []).filter((wid) => !wid.startsWith(cyclePrefix));
    const newByCycle = { ...(it.byCycle || {}) };
    delete newByCycle[cycleId];
    const hasRemaining =
      remainingWdIds.length > 0 || Object.keys(newByCycle).length > 0;

    if (!hasRemaining) {
      // El trabajador SOLO tenía producción en este ciclo — sale entero.
      // Restauramos sus anticipos como si nunca se hubieran aplicado.
      advancesToRestore.push(...(it.advanceIds || []));
      continue;
    }
    // Reducción parcial: bajamos gross/amount restando el aporte del ciclo.
    // Los anticipos ya aplicados se mantienen (el bruto baja pero el
    // descuento ya consumido sigue valiendo). Si el neto quedara negativo,
    // lo capeamos a 0.
    const newGross = Math.max(0, Number(it.grossAmount || it.amount || 0) - cycleAmount);
    const newAmount = Math.max(0, Number(it.amount || 0) - cycleAmount);
    newItems.push({
      ...it,
      amount: newAmount,
      grossAmount: newGross,
      byCycle: newByCycle,
      workdayIds: remainingWdIds,
    });
  }

  await untagWorkdaysFromPayroll(orphanWorkdayIds);
  if (advancesToRestore.length) {
    await restoreAdvancesFromPayroll(advancesToRestore, payrollId);
  }

  // Actualizar metadata de ciclos en la nómina.
  const oldCycleIds = Array.isArray(p.cycleIds) ? p.cycleIds : [];
  const oldCycleLabels = Array.isArray(p.cycleLabels) ? p.cycleLabels : [];
  const cycleIdxToDrop = oldCycleIds.indexOf(cycleId);
  const newCycleIds = oldCycleIds.filter((id) => id !== cycleId);
  const newCycleLabels = oldCycleLabels.filter((_, i) => i !== cycleIdxToDrop);
  const newCycleDetails = (p.cycleDetails || []).filter((c) => c.id !== cycleId);

  const aggregates = recalcPayrollAggregates(newItems);
  await payrollsService.update(payrollId, {
    ...aggregates,
    cycleIds: newCycleIds,
    cycleLabels: newCycleLabels,
    cycleDetails: newCycleDetails,
  });
}

export async function markPending(id, workdayIds = []) {
  await unmarkWorkdaysPaid(workdayIds);
  return payrollsService.update(id, { status: "pending", paidAt: null });
}
