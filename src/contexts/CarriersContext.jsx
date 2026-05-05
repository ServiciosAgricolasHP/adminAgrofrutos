import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { carriersService } from "../services/carriersService";

const CarriersContext = createContext(null);

export function CarriersProvider({ children }) {
  const [carriers, setCarriers] = useState([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const all = await carriersService.listAll({ includeInactive: true });
      setCarriers(all);
    } catch (err) {
      console.error("[Carriers] load failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const addCarrier = useCallback(async (data) => {
    const created = await carriersService.createCarrier(data);
    await reload();
    return created;
  }, [reload]);

  const updateCarrier = useCallback(async (id, patch) => {
    await carriersService.updateCarrier(id, patch);
    await reload();
  }, [reload]);

  const softDeleteCarrier = useCallback(async (id) => {
    await carriersService.softDelete(id);
    await reload();
  }, [reload]);

  const restoreCarrier = useCallback(async (id) => {
    await carriersService.restore(id);
    await reload();
  }, [reload]);

  const activeCarriers = carriers.filter((c) => c.active !== false);

  return (
    <CarriersContext.Provider
      value={{
        carriers,
        activeCarriers,
        loading,
        reload,
        addCarrier,
        updateCarrier,
        softDeleteCarrier,
        restoreCarrier,
      }}
    >
      {children}
    </CarriersContext.Provider>
  );
}

export function useCarriers() {
  const ctx = useContext(CarriersContext);
  if (!ctx) throw new Error("useCarriers must be used inside CarriersProvider");
  return ctx;
}
