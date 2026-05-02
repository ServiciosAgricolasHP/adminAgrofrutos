import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { catalogsService, CATALOG_DEFAULTS } from "../services/catalogsService";

const CatalogsContext = createContext(null);

export function CatalogsProvider({ children }) {
  const [catalogs, setCatalogs] = useState(CATALOG_DEFAULTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const all = await catalogsService.getAll();
        setCatalogs((c) => ({ ...c, ...all }));
      } catch (err) {
        console.error("[Catalogs] load failed:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const addEntry = useCallback(
    async (name, label) => {
      const cur = catalogs[name] || [];
      const trimmed = label.trim();
      if (!trimmed) return null;
      // Reuse existing entry if same label (case-insensitive)
      const existing = cur.find((e) => e.label.toLowerCase() === trimmed.toLowerCase());
      if (existing) return existing.value;
      const nextValue = cur.reduce((m, e) => Math.max(m, e.value), -1) + 1;
      const next = [...cur, { value: nextValue, label: trimmed }];
      await catalogsService.setEntries(name, next);
      setCatalogs((c) => ({ ...c, [name]: next }));
      return nextValue;
    },
    [catalogs],
  );

  const renameEntry = useCallback(
    async (name, value, newLabel) => {
      const cur = catalogs[name] || [];
      const trimmed = newLabel.trim();
      if (!trimmed) return;
      const next = cur.map((e) => (e.value === value ? { ...e, label: trimmed } : e));
      await catalogsService.setEntries(name, next);
      setCatalogs((c) => ({ ...c, [name]: next }));
    },
    [catalogs],
  );

  return (
    <CatalogsContext.Provider value={{ catalogs, loading, addEntry, renameEntry }}>
      {children}
    </CatalogsContext.Provider>
  );
}

export function useCatalogs() {
  const ctx = useContext(CatalogsContext);
  if (!ctx) throw new Error("useCatalogs must be used inside CatalogsProvider");
  return ctx;
}
