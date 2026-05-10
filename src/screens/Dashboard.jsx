import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { faenasService, cyclesService, workersService } from "../services";

const card = "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm";

export default function Dashboard() {
  const [faenas, setFaenas] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [f, c, w] = await Promise.all([
          faenasService.list({ order: ["name", "asc"], cache: true, persist: true, ttl: 10 * 60 * 1000 }),
          cyclesService.list({ cache: true, ttl: 2 * 60 * 1000 }),
          workersService.list({ cache: true, persist: true, ttl: 24 * 60 * 60 * 1000 }),
        ]);
        if (cancelled) return;
        setFaenas(f);
        setCycles(c);
        setWorkers(w);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const metrics = useMemo(() => {
    const openCycles = cycles.filter((c) => c.status !== "closed");
    const closedCycles = cycles.length - openCycles.length;
    const cyclesByFaena = openCycles.reduce((acc, c) => {
      acc[c.faenaId] = (acc[c.faenaId] || 0) + 1;
      return acc;
    }, {});
    return {
      faenas: faenas.length,
      openCycles: openCycles.length,
      closedCycles,
      workers: workers.length,
      cyclesByFaena,
    };
  }, [faenas, cycles, workers]);

  const openCyclesList = useMemo(
    () =>
      cycles
        .filter((c) => c.status !== "closed")
        .map((c) => ({
          ...c,
          faenaName: faenas.find((f) => f.id === c.faenaId)?.name || "—",
        }))
        .slice(0, 8),
    [cycles, faenas],
  );

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-[var(--color-muted)]">Resumen general del sistema.</p>
      </div>

      {loading ? (
        <div className="text-[var(--color-muted)]">Cargando...</div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className={card}>
              <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">Faenas</div>
              <div className="mt-2 text-3xl font-semibold">{metrics.faenas}</div>
            </div>
            <div className={card}>
              <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">Ciclos abiertos</div>
              <div className="mt-2 text-3xl font-semibold text-[var(--color-accent)]">{metrics.openCycles}</div>
              <div className="mt-1 text-xs text-[var(--color-muted)]">{metrics.closedCycles} cerrados</div>
            </div>
            <div className={card}>
              <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">Trabajadores</div>
              <div className="mt-2 text-3xl font-semibold">{metrics.workers}</div>
              <div className="mt-1 text-xs text-[var(--color-muted)]">en catálogo</div>
            </div>
            <div className={card}>
              <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">Faenas activas</div>
              <div className="mt-2 text-3xl font-semibold">{Object.keys(metrics.cyclesByFaena).length}</div>
              <div className="mt-1 text-xs text-[var(--color-muted)]">con ciclo abierto</div>
            </div>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <div className={card}>
              <div className="mb-3 text-xs uppercase tracking-wider text-[var(--color-muted)]">
                Ciclos abiertos
              </div>
              {openCyclesList.length === 0 ? (
                <div className="text-sm text-[var(--color-muted)]">Sin ciclos abiertos.</div>
              ) : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {openCyclesList.map((c) => (
                    <li key={c.id} className="flex items-center justify-between py-2">
                      <div>
                        <div className="text-sm font-medium">{c.label}</div>
                        <div className="text-xs text-[var(--color-muted)]">
                          {c.faenaName} {c.startDate && `· inicio ${c.startDate}`}
                        </div>
                      </div>
                      <Link
                        to={`/cycles/${c.id}`}
                        className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                      >
                        Abrir
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className={card}>
              <div className="mb-3 text-xs uppercase tracking-wider text-[var(--color-muted)]">Faenas</div>
              {faenas.length === 0 ? (
                <div className="text-sm text-[var(--color-muted)]">Sin faenas.</div>
              ) : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {faenas.slice(0, 6).map((f) => (
                    <li key={f.id} className="flex items-center justify-between py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{f.name}</span>
                      </div>
                      <span className="text-xs text-[var(--color-muted)]">
                        {metrics.cyclesByFaena[f.id] || 0} abiertos
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
