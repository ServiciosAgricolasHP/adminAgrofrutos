import { collection, getDocs, doc, setDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db, auth } from "../firebase";
import { logAction } from "./logger";
import { createService } from "./firestoreBase";

const COLLECTION = "carriers";

export const CARRIER_TYPES = [
  { value: "own", label: "Propio" },
  { value: "contracted", label: "Contratado" },
];

export const carrierTypeLabel = (t) =>
  CARRIER_TYPES.find((x) => x.value === t)?.label || t;

const base = createService("carrier", COLLECTION);

export const carriersService = {
  ...base,

  async listAll({ includeInactive = false } = {}) {
    const snap = await getDocs(collection(db, COLLECTION));
    const out = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return includeInactive ? out : out.filter((c) => c.active !== false);
  },

  async createCarrier({ alias, name, type, defaultRate = 0, vehicles = [], notes = "" }) {
    return base.create({
      alias: (alias || "").trim(),
      name: (name || "").trim(),
      type: type || "contracted",
      defaultRate: Number(defaultRate) || 0,
      vehicles: vehicles.map(normalizeVehicle).filter(Boolean),
      notes: notes || "",
      active: true,
    });
  },

  async updateCarrier(id, patch) {
    const data = { ...patch };
    if ("alias" in data) data.alias = (data.alias || "").trim();
    if ("name" in data) data.name = (data.name || "").trim();
    if ("vehicles" in data) data.vehicles = (data.vehicles || []).map(normalizeVehicle).filter(Boolean);
    if ("defaultRate" in data) data.defaultRate = Number(data.defaultRate) || 0;
    return base.update(id, data);
  },

  async softDelete(id) {
    await updateDoc(doc(db, COLLECTION, id), {
      active: false,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.uid || null,
    });
    base.invalidate();
    await logAction({ action: "update", entity: "carrier", entityId: id, after: { active: false } });
  },

  async restore(id) {
    await updateDoc(doc(db, COLLECTION, id), {
      active: true,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.uid || null,
    });
    base.invalidate();
    await logAction({ action: "update", entity: "carrier", entityId: id, after: { active: true } });
  },
};

function normalizeVehicle(v) {
  const alias = String(v?.alias || "").trim();
  if (!alias) return null;
  const out = { alias };
  if (v.plate) out.plate = String(v.plate).trim();
  if (v.capacity != null && v.capacity !== "") out.capacity = String(v.capacity).trim();
  if (v.notes) out.notes = String(v.notes).trim();
  return out;
}

// Vehicle alias must be unique within a carrier.
export function validateVehicleAlias(carrier, alias, ignoreAlias = null) {
  const a = String(alias || "").trim();
  if (!a) return "Alias requerido";
  const list = carrier?.vehicles || [];
  if (list.some((v) => v.alias === a && v.alias !== ignoreAlias)) {
    return "Alias ya existe en este transportista";
  }
  return null;
}
