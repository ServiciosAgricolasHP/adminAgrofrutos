import { useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { ModuleRegistry, AllCommunityModule } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import { AG_GRID_LOCALE_ES } from "../utils/agGridLocale";
import { workersService } from "../services";
import { deleteWorkerSafe, detectQueryKind, searchWorkers } from "../services/workersService";
import { formatRutForDisplay } from "../utils/rutUtils";
import {
  bankName,
  accountTypeLabel,
  isCuentaRut,
  isCashBank,
} from "../utils/banks";
import WorkerEditModal from "../components/WorkerEditModal";
import WorkerSummaryModal from "../components/WorkerSummaryModal";
import GroupSummaryModal from "../components/GroupSummaryModal";
import ConfirmDialog from "../components/ConfirmDialog";
import ResizableArea from "../components/ResizableArea";
import { useIsMobile } from "../hooks/useIsMobile";

ModuleRegistry.registerModules([AllCommunityModule]);

const MIN_SEARCH = 4;

export default function Workers() {
  const isMobile = useIsMobile();
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [edit, setEdit] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [summary, setSummary] = useState(null);
  const [groupSummaryOpen, setGroupSummaryOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [allWorkersForModal, setAllWorkersForModal] = useState([]);
  // Filtros opcionales (componibles con la búsqueda). Cuando alguno está
  // activo, los resultados salen de la lista completa cacheada en lugar de la
  // búsqueda server-side, y la regla de "≥4 caracteres" se relaja.
  // leaderFilter: "" | "__none__" | <nombre líder UPPER>
  // payFilter: "" | "cash" | "transfer"
  const [leaderFilter, setLeaderFilter] = useState("");
  const [payFilter, setPayFilter] = useState("");
  const cacheRef = useRef(new Map());
  const reqIdRef = useRef(0);

  const queryKind = detectQueryKind(search);
  const queryRaw = search.trim();
  const queryReady = queryRaw.replace(/[.\s-]/g, "").length >= MIN_SEARCH;
  const filtersActive = leaderFilter !== "" || payFilter !== "";

  // Debounced server-side search (≥ MIN_SEARCH chars). Caches results per
  // query within the session to avoid hitting Firestore on re-typed queries.
  useEffect(() => {
    if (!queryReady) {
      setResults([]);
      setLoading(false);
      return;
    }
    const key = queryRaw.toLowerCase();
    const cached = cacheRef.current.get(key);
    if (cached) {
      setResults(cached);
      setLoading(false);
      return;
    }
    const myId = ++reqIdRef.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const list = await searchWorkers(queryRaw, { take: 100 });
        if (reqIdRef.current !== myId) return;
        cacheRef.current.set(key, list);
        setResults(list);
      } finally {
        if (reqIdRef.current === myId) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [queryRaw, queryReady]);

  // Lazy-load full workers list (used by the edit modal for similarity check
  // and leader pool, y también para los filtros opt-in). Hits Firestore at
  // most once per 2h thanks to the cache.
  const ensureAllForModal = async () => {
    if (allWorkersForModal.length) return allWorkersForModal;
    const list = await workersService.list({
      order: ["name", "asc"],
      cache: true,
      persist: true,
      ttl: 2 * 60 * 60 * 1000,
    });
    setAllWorkersForModal(list);
    return list;
  };

  // Pre-cargar la lista en cuanto el usuario active cualquier filtro.
  useEffect(() => {
    if (filtersActive && allWorkersForModal.length === 0) {
      ensureAllForModal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersActive]);

  // Líderes únicos para el dropdown (toma del dataset completo cacheado).
  const leaderOptions = useMemo(() => {
    const set = new Set();
    for (const w of allWorkersForModal) {
      const l = (w.groupLeader?.[0] || "").toString().toUpperCase().trim();
      if (l) set.add(l);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "es"));
  }, [allWorkersForModal]);

  const stripAccents = (s) =>
    String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

  // Cuando hay filtros activos los resultados salen del dataset completo.
  // La búsqueda por texto se aplica encima como substring acentos-insensitive
  // sobre nombre y RUT (componible).
  const displayedResults = useMemo(() => {
    if (!filtersActive) return results;
    let arr = allWorkersForModal;
    if (leaderFilter === "__none__") {
      arr = arr.filter((w) => !((w.groupLeader?.[0] || "").toString().trim()));
    } else if (leaderFilter) {
      arr = arr.filter(
        (w) => (w.groupLeader?.[0] || "").toString().toUpperCase().trim() === leaderFilter,
      );
    }
    if (payFilter === "cash") {
      arr = arr.filter((w) => isCashBank(w.bankDetails?.[3]));
    } else if (payFilter === "transfer") {
      arr = arr.filter((w) => w.bankDetails?.[3] && !isCashBank(w.bankDetails?.[3]));
    }
    if (queryRaw) {
      const needle = stripAccents(queryRaw.replace(/[.\s-]/g, ""));
      if (needle) {
        arr = arr.filter((w) => {
          const name = stripAccents(w.name);
          const id = stripAccents(String(w.id || "").replace(/[.\s-]/g, ""));
          return name.includes(needle) || id.includes(needle);
        });
      }
    }
    return arr;
  }, [filtersActive, leaderFilter, payFilter, allWorkersForModal, queryRaw, results]);

  const showResults = filtersActive || queryReady;
  const clearFilters = () => {
    setLeaderFilter("");
    setPayFilter("");
  };

  const refreshCurrentSearch = async () => {
    cacheRef.current.delete(queryRaw.toLowerCase());
    if (!queryReady) return;
    setLoading(true);
    try {
      const list = await searchWorkers(queryRaw, { take: 100 });
      cacheRef.current.set(queryRaw.toLowerCase(), list);
      setResults(list);
    } finally {
      setLoading(false);
    }
  };

  const onSaved = async () => {
    setEdit(null);
    await refreshCurrentSearch();
    // Si la lista completa está cargada (por filtros o por el modal), la
    // refrescamos también — `workersService.update` ya invalidó el cache.
    if (allWorkersForModal.length) {
      try {
        const list = await workersService.list({
          order: ["name", "asc"],
          cache: true,
          persist: true,
          ttl: 2 * 60 * 60 * 1000,
        });
        setAllWorkersForModal(list);
      } catch { /* noop */ }
    }
  };

  const openCreate = async () => {
    await ensureAllForModal();
    setEdit({ mode: "create", worker: null });
  };

  const openEdit = async (worker) => {
    await ensureAllForModal();
    setEdit({ mode: "edit", worker });
  };

  const askDelete = (worker) => setConfirm({ worker });
  const doDelete = async () => {
    if (!confirm) return;
    setConfirm((c) => ({ ...c, busy: true }));
    try {
      await deleteWorkerSafe(confirm.worker.id);
      setConfirm(null);
      await refreshCurrentSearch();
    } catch (err) {
      alert(err.message || "Error al eliminar");
      setConfirm(null);
    }
  };

  const columnDefs = useMemo(
    () => [
      {
        headerName: "RUT",
        field: "id",
        width: 140,
        valueFormatter: (p) => formatRutForDisplay(p.value),
        pinned: "left",
      },
      { headerName: "Nombre", field: "name", flex: 1, minWidth: 180, pinned: "left" },
      { headerName: "Líder", valueGetter: (p) => (p.data.groupLeader?.[0] || "").toUpperCase().trim() || "—", width: 160 },
      {
        headerName: "IDs QR",
        valueGetter: (p) => (p.data.idQr || []).join(", ") || "—",
        flex: 1,
        minWidth: 140,
      },
      {
        headerName: "Banco",
        valueGetter: (p) => bankName(p.data.bankDetails?.[3]),
        width: 200,
        cellRenderer: (p) => {
          const cash = isCashBank(p.data.bankDetails?.[3]);
          return (
            <span className={cash ? "font-medium text-[var(--color-accent)]" : ""}>
              {bankName(p.data.bankDetails?.[3]) || "—"}
            </span>
          );
        },
      },
      {
        headerName: "Tipo cuenta",
        valueGetter: (p) => accountTypeLabel(p.data.bankDetails?.[2]),
        width: 140,
        cellRenderer: (p) => (
          <span className={isCuentaRut(p.data.bankDetails) ? "text-[var(--color-accent)]" : ""}>
            {accountTypeLabel(p.data.bankDetails?.[2])}
          </span>
        ),
      },
      { headerName: "N° cuenta", valueGetter: (p) => p.data.bankDetails?.[1] || "—", width: 140 },
      {
        headerName: "RUT pago",
        valueGetter: (p) => formatRutForDisplay(p.data.bankDetails?.[0] || ""),
        width: 130,
      },
      {
        headerName: "",
        width: 260,
        pinned: "right",
        cellRenderer: (p) => {
          const isCash = isCashBank(p.data.bankDetails?.[3]);
          return (
            <div className="flex h-full items-center gap-1">
              {/* Indicador informativo de medio de pago — no es un toggle.
                  El cambio Banco ↔ Efectivo ahora vive solo en el modal
                  de edición. */}
              <span
                className={`inline-flex items-center rounded-md border px-2 py-1 text-xs ${
                  isCash
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                    : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-muted)]"
                }`}
                title={isCash ? "Pago en efectivo" : "Pago por transferencia"}
              >
                {isCash ? "💵 Efectivo" : "🏦 Transferencia"}
              </span>
              <button
                onClick={() => setSummary(p.data)}
                title="Ver resumen del trabajador"
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
              >
                📊
              </button>
              <button
                onClick={() => openEdit(p.data)}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
              >
                Editar
              </button>
              <button
                onClick={() => askDelete(p.data)}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
              >
                ✕
              </button>
            </div>
          );
        },
      },
    ],
    [],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trabajadores</h1>
          <p className="text-sm text-[var(--color-muted)]">
            {showResults
              ? `${displayedResults.length} resultado(s)`
              : `Escribe al menos ${MIN_SEARCH} caracteres para buscar`}
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div className="relative w-full sm:w-80">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Buscar por RUT o nombre (mín. ${MIN_SEARCH} caracteres)...`}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 pr-16 text-sm shadow-sm outline-none focus:border-[var(--color-accent)]"
            />
            {queryKind && (
              <span className="absolute top-1/2 right-2 -translate-y-1/2 rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-accent)]">
                {queryKind === "rut" ? "RUT" : "Nombre"}
              </span>
            )}
          </div>
          <button
            onClick={() => setGroupSummaryOpen(true)}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-accent-soft)] sm:w-auto"
            title="Armar un grupo de trabajadores y generar matriz + resúmenes individuales"
          >
            📊 Resúmenes por grupo
          </button>
          <button
            onClick={openCreate}
            className="w-full rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] shadow-sm hover:bg-[var(--color-accent-hover)] sm:w-auto"
          >
            + Nuevo trabajador
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <select
          value={leaderFilter}
          onChange={(e) => setLeaderFilter(e.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs shadow-sm focus:border-[var(--color-accent)] outline-none"
          title="Filtrar por líder de grupo"
        >
          <option value="">👥 Líder: todos</option>
          <option value="__none__">— Sin líder —</option>
          {leaderOptions.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setPayFilter((v) => (v === "cash" ? "" : "cash"))}
          className={`rounded-md border px-2 py-1.5 ${
            payFilter === "cash"
              ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
              : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"
          }`}
        >
          💵 Efectivo
        </button>
        <button
          type="button"
          onClick={() => setPayFilter((v) => (v === "transfer" ? "" : "transfer"))}
          className={`rounded-md border px-2 py-1.5 ${
            payFilter === "transfer"
              ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
              : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"
          }`}
        >
          🏦 Transferencia
        </button>
        {filtersActive && (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
          >
            ✕ Limpiar filtros
          </button>
        )}
      </div>

      <ResizableArea storageKey="workers-grid" defaultHeight={460} minHeight={280}>
      <div
        className={`h-full ${isMobile ? "" : "ag-theme-quartz ag-theme-app"}`}
      >
        {!showResults ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] text-sm text-[var(--color-muted)]">
            Escribe al menos {MIN_SEARCH} caracteres (RUT o nombre) o activá un filtro para listar.
          </div>
        ) : loading && !filtersActive ? (
          <div className="flex h-full items-center justify-center text-[var(--color-muted)]">Buscando...</div>
        ) : filtersActive && allWorkersForModal.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[var(--color-muted)]">Cargando trabajadores...</div>
        ) : displayedResults.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] text-sm text-[var(--color-muted)]">
            Sin resultados{search ? ` para "${search}"` : ""}.
          </div>
        ) : isMobile ? (
          <div className="space-y-2">
            {displayedResults.map((w) => {
              const isCash = isCashBank(w.bankDetails?.[3]);
              const leader = (w.groupLeader?.[0] || "").toUpperCase().trim() || "—";
              return (
                <div
                  key={w.id}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-2"
                >
                  <div>
                    <div className="text-base font-semibold leading-tight">{w.name}</div>
                    <div className="font-mono text-xs text-[var(--color-muted)]">
                      {formatRutForDisplay(w.id)}
                    </div>
                  </div>
                  <div className="text-xs">
                    <span className={isCash ? "font-medium text-[var(--color-accent)]" : ""}>
                      {bankName(w.bankDetails?.[3]) || "—"}
                    </span>
                    <span className="mx-1 text-[var(--color-muted)]">·</span>
                    <span className={isCuentaRut(w.bankDetails) ? "text-[var(--color-accent)]" : ""}>
                      {accountTypeLabel(w.bankDetails?.[2])}
                    </span>
                    {w.bankDetails?.[1] && (
                      <>
                        <span className="mx-1 text-[var(--color-muted)]">·</span>
                        <span className="font-mono">{w.bankDetails[1]}</span>
                      </>
                    )}
                  </div>
                  <div className="text-xs text-[var(--color-muted)]">
                    Líder: <span className="text-[var(--color-text)]">{leader}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 pt-1">
                    <span
                      className={`inline-flex items-center rounded-md border px-2 py-1 text-xs ${
                        isCash
                          ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                          : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-muted)]"
                      }`}
                      title={isCash ? "Pago en efectivo" : "Pago por transferencia"}
                    >
                      {isCash ? "💵 Efectivo" : "🏦 Transferencia"}
                    </span>
                    <button
                      onClick={() => setSummary(w)}
                      title="Ver resumen del trabajador"
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                    >
                      📊
                    </button>
                    <button
                      onClick={() => openEdit(w)}
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                    >
                      Editar
                    </button>
                    <button
                      onClick={() => askDelete(w)}
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <AgGridReact
            rowData={displayedResults}
            columnDefs={columnDefs}
            defaultColDef={{ resizable: true, sortable: true, filter: true }}
            getRowId={(p) => p.data.id}
            localeText={AG_GRID_LOCALE_ES}
          />
        )}
      </div>
      </ResizableArea>

      <WorkerEditModal
        open={!!edit}
        mode={edit?.mode}
        worker={edit?.worker}
        allWorkers={allWorkersForModal}
        onClose={() => setEdit(null)}
        onSaved={onSaved}
      />

      <WorkerSummaryModal
        open={!!summary}
        worker={summary}
        onClose={() => setSummary(null)}
      />

      <GroupSummaryModal
        open={groupSummaryOpen}
        onClose={() => setGroupSummaryOpen(false)}
      />

      <ConfirmDialog
        open={!!confirm}
        title="Eliminar trabajador"
        message={confirm ? `¿Eliminar a ${confirm.worker.name}? Solo permitido si no tiene días registrados.` : ""}
        confirmLabel="Eliminar"
        danger
        busy={confirm?.busy}
        onCancel={() => !confirm?.busy && setConfirm(null)}
        onConfirm={doDelete}
      />
    </div>
  );
}
