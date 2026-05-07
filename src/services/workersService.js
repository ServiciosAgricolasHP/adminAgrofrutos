import { collection, query, where, orderBy, limit, getDocs, documentId } from "firebase/firestore";
import { db } from "../firebase";
import { workersService, workdaysService } from "./index";
import { normalizeRut, validateRut } from "../utils/rutUtils";

// Auto-detect: starts with digit → RUT search; else name search.
export function detectQueryKind(q) {
  const s = String(q || "").trim();
  if (!s) return null;
  return /^\d/.test(s) ? "rut" : "name";
}

// Server-side prefix search. Returns up to `take` workers matching the query.
export async function searchWorkers(q, { take = 50 } = {}) {
  const kind = detectQueryKind(q);
  if (!kind) return [];
  const raw = String(q).trim();
  const col = collection(db, "worker");

  if (kind === "rut") {
    // Doc id = RUT (e.g. "12345678-9"). Strip dots/spaces, leave dash.
    const prefix = raw.replace(/[.\s]/g, "").toUpperCase();
    const qy = query(
      col,
      where(documentId(), ">=", prefix),
      where(documentId(), "<", prefix + ""),
      limit(take),
    );
    const snap = await getDocs(qy);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  // Name search — try a couple casings since Firestore is case-sensitive.
  const variants = new Set([raw, raw.toUpperCase(), raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()]);
  const seen = new Map();
  for (const v of variants) {
    const qy = query(
      col,
      orderBy("name"),
      where("name", ">=", v),
      where("name", "<", v + ""),
      limit(take),
    );
    const snap = await getDocs(qy);
    for (const d of snap.docs) {
      if (!seen.has(d.id)) seen.set(d.id, { id: d.id, ...d.data() });
    }
    if (seen.size >= take) break;
  }
  return [...seen.values()].slice(0, take);
}

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
