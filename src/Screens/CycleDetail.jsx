import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { cyclesService, harvestsService } from "../services";

export default function CycleDetail() {
  const { id } = useParams();
  const [cycle, setCycle] = useState(null);
  const [harvest, setHarvest] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const c = await cyclesService.getById(id);
      setCycle(c);
      if (c?.harvestId) setHarvest(await harvestsService.getById(c.harvestId));
      setLoading(false);
    })();
  }, [id]);

  if (loading) return <div className="text-[var(--color-muted)]">Cargando...</div>;
  if (!cycle) return <div className="text-[var(--color-muted)]">Ciclo no encontrado.</div>;

  return (
    <div>
      <div className="mb-4 flex items-center gap-2 text-sm text-[var(--color-muted)]">
        <Link to="/harvests" className="hover:text-[var(--color-accent)]">Cosechas</Link>
        <span>/</span>
        <span>{harvest?.name || "—"}</span>
        <span>/</span>
        <span className="text-[var(--color-text)]">{cycle.label}</span>
      </div>
      <h1 className="text-2xl font-semibold">{cycle.label}</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        Estado: {cycle.status} · {(cycle.workerIds || []).length} trabajadores
      </p>
      <div className="mt-6 rounded-lg border border-dashed border-[var(--color-border)] p-8 text-center text-[var(--color-muted)]">
        Grid de días/trabajadores en F5.
      </div>
    </div>
  );
}
