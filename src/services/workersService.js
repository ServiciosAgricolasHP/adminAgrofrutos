import { workersService, workdaysService } from "./index";
import { normalizeRut, validateRut } from "../utils/rutUtils";

// In the existing `worker` collection, the document ID **is** the RUT.
// There is no `rut` field on the document.

export async function findWorkerByRut(rut) {
  const normalized = normalizeRut(rut);
  if (!normalized) return null;
  const found = await workersService.getById(normalized);
  return found; // { id, name, groupLeader?, idQr?, bankDetails? } or null
}

export async function createWorker({ rut, name }) {
  const normalized = normalizeRut(rut);
  if (!validateRut(normalized)) throw new Error("RUT inválido");
  const existing = await findWorkerByRut(normalized);
  if (existing) return existing;
  return workersService.create(
    { name: String(name || "").trim().toUpperCase() },
    { id: normalized },
  );
}

export async function deleteWorkerSafe(workerId) {
  const days = await workdaysService.list({
    wheres: [["workerRut", "==", workerId]],
    take: 1,
  });
  if (days.length) throw new Error("No se puede eliminar: el trabajador tiene días asociados");
  return workersService.remove(workerId);
}

export { workersService };
