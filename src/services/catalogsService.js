import { collection, doc, getDoc, getDocs, setDoc, serverTimestamp } from "firebase/firestore";
import { db, auth } from "../firebase";
import { logAction } from "./logger";

const COLLECTION = "catalogs";

export const CATALOG_NAMES = ["qualities", "containers", "tratoTypes", "tratoUnits"];

export const CATALOG_DEFAULTS = {
  qualities: [
    { value: 0, label: "Exportación" },
    { value: 1, label: "IQF" },
    { value: 2, label: "Repaso" },
  ],
  containers: [
    { value: 0, label: "kilo" },
    { value: 1, label: "bandeja" },
    { value: 2, label: "capacho" },
    { value: 3, label: "saco" },
  ],
  tratoTypes: [
    { value: 0, label: "Poda" },
    { value: 1, label: "Amarre" },
    { value: 2, label: "Desmalezado" },
    { value: 3, label: "Carpas" },
  ],
  // Unidad de medida que representa el `qty` de un workday de trato en un día
  // dado. Convive con el precio en `dayPrices[labor][date].tN.unit`. El valor 0
  // ("Unidad") es el default genérico — se usa cuando no se elige otra cosa
  // (mantiene compat con cycles previos al feature).
  tratoUnits: [
    { value: 0, label: "Unidad" },
    { value: 1, label: "Metro" },
    { value: 2, label: "Polín" },
    { value: 3, label: "Planta" },
    { value: 4, label: "Hilera" },
  ],
};

const ref = (name) => doc(db, COLLECTION, name);

async function seedIfMissing(name) {
  const snap = await getDoc(ref(name));
  if (!snap.exists()) {
    await setDoc(ref(name), {
      entries: CATALOG_DEFAULTS[name] || [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.uid || null,
    });
    return CATALOG_DEFAULTS[name] || [];
  }
  return snap.data().entries || [];
}

export const catalogsService = {
  async getAll() {
    const snap = await getDocs(collection(db, COLLECTION));
    const map = {};
    for (const d of snap.docs) map[d.id] = d.data().entries || [];
    for (const name of CATALOG_NAMES) {
      if (!map[name]) map[name] = await seedIfMissing(name);
    }
    return map;
  },

  async setEntries(name, entries) {
    await setDoc(
      ref(name),
      { entries, updatedAt: serverTimestamp(), updatedBy: auth.currentUser?.uid || null },
      { merge: true },
    );
    await logAction({ action: "update", entity: "catalog", entityId: name, after: { entries } });
  },
};
