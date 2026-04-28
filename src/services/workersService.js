import { workersService, workdaysService } from "./index";
import { normalizeRut, validateRut } from "../utils/rutUtils";

export async function findWorkerByRut(rut) {
  const normalized = normalizeRut(rut);
  const found = await workersService.list({ wheres: [["rut", "==", normalized]], take: 1 });
  return found[0] || null;
}

export async function createWorker({ rut, name }) {
  const normalized = normalizeRut(rut);
  if (!validateRut(normalized)) throw new Error("RUT inválido");
  const existing = await findWorkerByRut(normalized);
  if (existing) return existing;
  return workersService.create(
    { rut: normalized, name: String(name || "").trim().toUpperCase() },
    { id: normalized },
  );
}

export async function deleteWorkerSafe(workerId) {
  const days = await workdaysService.list({ wheres: [["workerId", "==", workerId]], take: 1 });
  if (days.length) throw new Error("No se puede eliminar: el trabajador tiene días asociados");
  return workersService.remove(workerId);
}

export { workersService };
