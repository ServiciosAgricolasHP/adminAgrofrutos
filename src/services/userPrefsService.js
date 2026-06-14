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

// Paleta amplia organizada por familia de tonos. La primera entrada (null)
// representa "sin color" — limpia la asignación.
export const FAENA_PALETTE = [
  { value: null, label: "Sin color", swatch: "transparent" },
  // Verdes
  { value: "#15803d", label: "Verde" },
  { value: "#22c55e", label: "Verde claro" },
  { value: "#10b981", label: "Esmeralda" },
  { value: "#a8e6cf", label: "Menta" },
  { value: "#84cc16", label: "Lima" },
  { value: "#65a30d", label: "Oliva" },
  // Azules / cyans
  { value: "#0ea5e9", label: "Cielo" },
  { value: "#60a5fa", label: "Azul" },
  { value: "#2563eb", label: "Azul fuerte" },
  { value: "#06b6d4", label: "Cyan" },
  { value: "#14b8a6", label: "Teal" },
  { value: "#6366f1", label: "Índigo" },
  // Violetas / magentas
  { value: "#8b5cf6", label: "Violeta" },
  { value: "#c084fc", label: "Lila" },
  { value: "#a855f7", label: "Púrpura" },
  { value: "#ec4899", label: "Magenta" },
  { value: "#f472b6", label: "Rosa" },
  // Rojos / corales
  { value: "#ef4444", label: "Rojo" },
  { value: "#f87171", label: "Coral" },
  { value: "#dc2626", label: "Carmesí" },
  // Naranjas / amarillos
  { value: "#fb923c", label: "Naranja" },
  { value: "#f97316", label: "Naranja fuerte" },
  { value: "#f59e0b", label: "Ámbar" },
  { value: "#facc15", label: "Amarillo" },
  // Tierras / neutros
  { value: "#d97706", label: "Mostaza" },
  { value: "#a16207", label: "Bronce" },
  { value: "#78350f", label: "Café" },
  { value: "#94a3b8", label: "Gris" },
  { value: "#475569", label: "Pizarra" },
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
