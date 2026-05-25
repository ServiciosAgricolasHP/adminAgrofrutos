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
          workersService.list({ cache: true, persist: true, ttl: 2 * 60 * 60 * 1000 }),
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

  // Una entrada por faena con sus ciclos abiertos. Las faenas sin ciclo
  // abierto siguen apareciendo (para acceder al detalle de la faena), pero
  // ordenadas al final. Las que tienen ciclos abiertos van primero, por
  // cantidad de actividad descendente.
  const faenaGroups = useMemo(() => {
    const map = new Map();
    for (const f of faenas) {
      map.set(f.id, { faena: f, openCycles: [], closedCount: 0 });
    }
    for (const c of cycles) {
      const entry = map.get(c.faenaId);
      if (!entry) continue;
      if (c.status === "closed") entry.closedCount += 1;
      else entry.openCycles.push(c);
    }
    for (const entry of map.values()) {
      entry.openCycles.sort((a, b) =>
        String(b.startDate || "").localeCompare(String(a.startDate || "")),
      );
    }
    return [...map.values()].sort((a, b) => {
      const ao = a.openCycles.length;
      const bo = b.openCycles.length;
      if (ao !== bo) return bo - ao;
      return String(a.faena.name || "").localeCompare(String(b.faena.name || ""));
    });
  }, [faenas, cycles]);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-[var(--color-muted)]">Resumen general del sistema.</p>
        </div>
        <Link
          to="/faenas"
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
        >
          Ir a Faenas →
        </Link>
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

          <section className="mt-6">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-muted)]">
                Faenas y ciclos abiertos
              </h2>
              {faenas.length > 0 && (
                <span className="text-xs text-[var(--color-muted)]">
                  {faenas.length} faena{faenas.length === 1 ? "" : "s"}
                </span>
              )}
            </div>

            {faenaGroups.length === 0 ? (
              <div className={`${card} text-sm text-[var(--color-muted)]`}>
                Sin faenas creadas todavía. Andá a{" "}
                <Link to="/faenas" className="text-[var(--color-accent)] hover:underline">
                  Faenas
                </Link>{" "}
                para empezar.
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {faenaGroups.map(({ faena, openCycles, closedCount }) => {
                  const isActive = openCycles.length > 0;
                  return (
                    <div
                      key={faena.id}
                      className={`${card} ${isActive ? "" : "opacity-75"}`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <Link
                          to="/faenas"
                          className="truncate text-base font-medium hover:text-[var(--color-accent)]"
                          title={faena.name}
                        >
                          {faena.name}
                        </Link>
                        {isActive ? (
                          <span className="shrink-0 rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent)]">
                            {openCycles.length} abierto{openCycles.length === 1 ? "" : "s"}
                          </span>
                        ) : closedCount > 0 ? (
                          <span className="shrink-0 text-[10px] text-[var(--color-muted)]">
                            {closedCount} cerrado{closedCount === 1 ? "" : "s"}
                          </span>
                        ) : (
                          <span className="shrink-0 text-[10px] text-[var(--color-muted)]">
                            sin ciclos
                          </span>
                        )}
                      </div>

                      {openCycles.length > 0 ? (
                        <ul className="mt-2 space-y-0.5">
                          {openCycles.map((c) => (
                            <li key={c.id}>
                              <Link
                                to={`/cycles/${c.id}`}
                                className="group flex items-center justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-[var(--color-accent-soft)]"
                              >
                                <span className="truncate group-hover:text-[var(--color-accent)]">
                                  {c.label}
                                </span>
                                {c.startDate && (
                                  <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-muted)]">
                                    {c.startDate}
                                  </span>
                                )}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <Link
                          to="/faenas"
                          className="mt-2 inline-block text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)]"
                        >
                          Ver detalle de la faena →
                        </Link>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
