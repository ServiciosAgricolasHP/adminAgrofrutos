import { useEffect, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { ModuleRegistry, AllCommunityModule } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import { AG_GRID_LOCALE_ES } from "../utils/agGridLocale";
import { workersService } from "../services";
import { deleteWorkerSafe } from "../services/workersService";
import { formatRutForDisplay } from "../utils/rutUtils";
import { bankName, accountTypeLabel, isCuentaRut } from "../utils/banks";
import WorkerEditModal from "../components/WorkerEditModal";
import ConfirmDialog from "../components/ConfirmDialog";

ModuleRegistry.registerModules([AllCommunityModule]);

export default function Workers() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [search, setSearch] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const list = await workersService.list({
        order: ["name", "asc"],
        cache: true,
        persist: true,
        ttl: 5 * 60 * 1000,
      });
      setRows(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const onSaved = async () => {
    setEdit(null);
    await load();
  };

  const askDelete = (worker) => setConfirm({ worker });
  const doDelete = async () => {
    if (!confirm) return;
    setConfirm((c) => ({ ...c, busy: true }));
    try {
      await deleteWorkerSafe(confirm.worker.id);
      setConfirm(null);
      await load();
    } catch (err) {
      alert(err.message || "Error al eliminar");
      setConfirm(null);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((w) => w.id.toLowerCase().includes(q) || w.name?.toLowerCase().includes(q));
  }, [rows, search]);

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
      { headerName: "Líder", valueGetter: (p) => p.data.groupLeader?.[0] || "—", width: 160 },
      {
        headerName: "IDs QR",
        valueGetter: (p) => (p.data.idQr || []).join(", ") || "—",
        flex: 1,
        minWidth: 140,
      },
      { headerName: "Banco", valueGetter: (p) => bankName(p.data.bankDetails?.[3]), width: 200 },
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
        width: 170,
        pinned: "right",
        cellRenderer: (p) => (
          <div className="flex h-full items-center gap-2">
            <button
              onClick={() => setEdit({ mode: "edit", worker: p.data })}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
            >
              Editar
            </button>
            <button
              onClick={() => askDelete(p.data)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
            >
              Eliminar
            </button>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trabajadores</h1>
          <p className="text-sm text-[var(--color-muted)]">{rows.length} registrados</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por RUT o nombre..."
            className="w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm shadow-sm outline-none focus:border-[var(--color-accent)]"
          />
          <button
            onClick={() => setEdit({ mode: "create", worker: null })}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] shadow-sm hover:bg-[var(--color-accent-hover)]"
          >
            + Nuevo trabajador
          </button>
        </div>
      </div>

      <div
        className={`flex-1 ag-theme-quartz ag-theme-app`}
        style={{ minHeight: 400 }}
      >
        {loading ? (
          <div className="flex h-full items-center justify-center text-[var(--color-muted)]">Cargando...</div>
        ) : (
          <AgGridReact
            rowData={filtered}
            columnDefs={columnDefs}
            defaultColDef={{ resizable: true, sortable: true, filter: true }}
            getRowId={(p) => p.data.id}
            localeText={AG_GRID_LOCALE_ES}
          />
        )}
      </div>

      <WorkerEditModal
        open={!!edit}
        mode={edit?.mode}
        worker={edit?.worker}
        allWorkers={rows}
        onClose={() => setEdit(null)}
        onSaved={onSaved}
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
