import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import { faenasService, cyclesService, workersService } from "../services";
import { functions } from "../firebase";

const card = "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm";

export default function Dashboard() {
  const [faenas, setFaenas] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  // Set de faenaIds colapsadas en el dashboard. Persistida en localStorage
  // para que el usuario no tenga que volver a plegar después de recargar.
  const [collapsedFaenas, setCollapsedFaenas] = useState(() => {
    try {
      const raw = localStorage.getItem("dashboard.collapsedFaenas");
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  });
  const toggleFaenaCollapsed = (id) => {
    setCollapsedFaenas((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try { localStorage.setItem("dashboard.collapsedFaenas", JSON.stringify([...next])); } catch { /* noop */ }
      return next;
    });
  };
  // TEMP: prueba de Cloud Functions (ping). Borrar este bloque (estado, handler
  // y el botón en el header) cuando confirmemos que el plomo funciona.
  const [pingBusy, setPingBusy] = useState(false);
  const [pingResult, setPingResult] = useState(null);
  const runPing = async () => {
    setPingBusy(true);
    setPingResult(null);
    try {
      const { data } = await httpsCallable(functions, "ping")();
      setPingResult({ ok: true, data });
    } catch (err) {
      setPingResult({ ok: false, code: err.code, message: err.message });
    } finally {
      setPingBusy(false);
    }
  };

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

  // Separamos en dos bloques: con ciclos abiertos (activas) y sin (inactivas).
  // En el render salen como secciones distintas con su propio header.
  const activeFaenaGroups = useMemo(
    () => faenaGroups.filter((g) => g.openCycles.length > 0),
    [faenaGroups],
  );
  const inactiveFaenaGroups = useMemo(
    () => faenaGroups.filter((g) => g.openCycles.length === 0),
    [faenaGroups],
  );

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-[var(--color-muted)]">Resumen general del sistema.</p>
        </div>
        <div className="flex items-center gap-2">
          {/* TEMP: botón de prueba de Cloud Functions — eliminar después de verificar */}
          <button
            onClick={runPing}
            disabled={pingBusy}
            className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-1.5 text-sm text-[var(--color-warning)] hover:opacity-80 disabled:opacity-60"
            title="Llama a la Cloud Function `ping` para verificar el plomo (auth + región)"
          >
            {pingBusy ? "Llamando..." : "🧪 Probar ping"}
          </button>
          <Link
            to="/faenas"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
          >
            Ir a Faenas →
          </Link>
        </div>
      </div>

      {/* TEMP: resultado del ping. Eliminar junto con el botón. */}
      {pingResult && (
        <div
          className={`mb-4 rounded-md border p-3 text-xs font-mono ${
            pingResult.ok
              ? "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]"
              : "border-[var(--color-danger)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
          }`}
        >
          {pingResult.ok
            ? `✓ OK — ${JSON.stringify(pingResult.data)}`
            : `✗ ${pingResult.code || "error"}: ${pingResult.message}`}
        </div>
      )}

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
              <div className="flex items-baseline gap-3">
                {faenaGroups.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      const allIds = faenaGroups.map((g) => g.faena.id);
                      const allCollapsed = allIds.every((id) => collapsedFaenas.has(id));
                      const next = new Set(allCollapsed ? [] : allIds);
                      setCollapsedFaenas(next);
                      try { localStorage.setItem("dashboard.collapsedFaenas", JSON.stringify([...next])); } catch { /* noop */ }
                    }}
                    className="text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)]"
                  >
                    {faenaGroups.every((g) => collapsedFaenas.has(g.faena.id))
                      ? "Expandir todo"
                      : "Colapsar todo"}
                  </button>
                )}
                {faenas.length > 0 && (
                  <span className="text-xs text-[var(--color-muted)]">
                    {faenas.length} faena{faenas.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>
            </div>

            {faenaGroups.length === 0 ? (
              <div className={`${card} text-sm text-[var(--color-muted)]`}>
                Sin faenas creadas todavía. Andá a{" "}
                <Link to="/faenas" className="text-[var(--color-accent)] hover:underline">
                  Faenas
                </Link>{" "}
                para empezar.
              </div>
            ) : (() => {
              const renderCard = ({ faena, openCycles, closedCount }) => {
                const isActive = openCycles.length > 0;
                const collapsed = collapsedFaenas.has(faena.id);
                return (
                  <div
                    key={faena.id}
                    className={`${card} ${isActive ? "" : "opacity-75"}`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="flex min-w-0 items-baseline gap-1">
                        <button
                          type="button"
                          onClick={() => toggleFaenaCollapsed(faena.id)}
                          title={collapsed ? "Expandir" : "Colapsar"}
                          className="shrink-0 rounded px-1 text-xs text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
                        >
                          {collapsed ? "▸" : "▾"}
                        </button>
                        <Link
                          to="/faenas"
                          className="truncate text-base font-medium hover:text-[var(--color-accent)]"
                          title={faena.name}
                        >
                          {faena.name}
                        </Link>
                      </div>
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

                    {collapsed ? null : openCycles.length > 0 ? (
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
              };
              return (
                <>
                  {activeFaenaGroups.length > 0 && (
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {activeFaenaGroups.map(renderCard)}
                    </div>
                  )}
                  {inactiveFaenaGroups.length > 0 && (
                    <>
                      <div className="mt-6 mb-3 flex items-baseline gap-2">
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
                          Sin ciclos abiertos
                        </h3>
                        <span className="text-xs text-[var(--color-muted)]">
                          {inactiveFaenaGroups.length}
                        </span>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {inactiveFaenaGroups.map(renderCard)}
                      </div>
                    </>
                  )}
                </>
              );
            })()}
          </section>
        </>
      )}
    </div>
  );
}
