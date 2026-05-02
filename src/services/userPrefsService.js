import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";

const ref = (uid) => doc(db, "users", uid);

export const userPrefsService = {
  async getLayout(uid) {
    if (!uid) return null;
    const snap = await getDoc(ref(uid));
    return snap.data()?.faenaLayout || null;
  },
  async saveLayout(uid, layout) {
    if (!uid) return;
    await setDoc(
      ref(uid),
      { faenaLayout: layout, faenaLayoutUpdatedAt: serverTimestamp() },
      { merge: true },
    );
  },
};

export const FAENA_PALETTE = [
  { value: null, label: "Sin color", swatch: "transparent" },
  { value: "#15803d", label: "Verde" },
  { value: "#fb923c", label: "Naranja" },
  { value: "#a8e6cf", label: "Menta" },
  { value: "#c084fc", label: "Lila" },
  { value: "#facc15", label: "Amarillo" },
  { value: "#f87171", label: "Rojo" },
  { value: "#60a5fa", label: "Azul" },
  { value: "#94a3b8", label: "Gris" },
];

export const UNGROUPED_ID = "ungrouped";

export const defaultLayout = () => ({
  groups: [{ id: UNGROUPED_ID, name: "Sin grupo", color: null }],
  faenaGroup: {},
  faenaColor: {},
});

export function normalizeLayout(layout) {
  const base = defaultLayout();
  if (!layout) return base;
  const groups = Array.isArray(layout.groups) ? [...layout.groups] : [];
  // Always ensure ungrouped exists, last
  const filtered = groups.filter((g) => g.id !== UNGROUPED_ID);
  filtered.push({ id: UNGROUPED_ID, name: "Sin grupo", color: null });
  return {
    groups: filtered,
    faenaGroup: layout.faenaGroup || {},
    faenaColor: layout.faenaColor || {},
  };
}
