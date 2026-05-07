import { useEffect, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { ModuleRegistry, AllCommunityModule } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import { AG_GRID_LOCALE_ES } from "../utils/agGridLocale";
import { workersService } from "../services";
import { deleteWorkerSafe, detectQueryKind } from "../services/workersService";
import { formatRutForDisplay } from "../utils/rutUtils";
import {
  bankName,
  accountTypeLabel,
  isCuentaRut,
  isCashBank,
  defaultBankDetails,
  CASH_BANK_CODE,
} from "../utils/banks";
import WorkerEditModal from "../components/WorkerEditModal";
import WorkerSummaryModal from "../components/WorkerSummaryModal";
import ConfirmDialog from "../components/ConfirmDialog";

ModuleRegistry.registerModules([AllCommunityModule]);

// Strip accents/case for forgiving substring search.
const fold = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

export default function Workers() {
  const [allRows, setAllRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [summary, setSummary] = useState(null);
  const [search, setSearch] = useState("");

  const queryKind = detectQueryKind(search);

  const load = async () => {
    setLoading(true);
    try {
      const list = await workersService.list({
        order: ["name", "asc"],
        cache: true,
        persist: true,
        ttl: 5 * 60 * 1000,
      });
      setAllRows(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim();
    if (!q) return allRows;
    const qf = fold(q);
    if (queryKind === "rut") {
      // RUT search: match against id (also accepts partial like "-B" for foreign suffix).
      const norm = qf.replace(/[.\s]/g, "");
      return allRows.filter((w) => fold(w.id).includes(norm));
    }
    // Name (or any text) search: substring on name AND id (so "-b" still works on lowercase too).
    return allRows.filter((w) => fold(w.name).includes(qf) || fold(w.id).includes(qf));
  }, [allRows, search, queryKind]);

  const onSaved = async () => {
    setEdit(null);
    await load();
  };

  const setBankShortcut = async (worker, kind) => {
    let bankDetails;
    if (kind === "cuentaRut") {
      bankDetails = defaultBankDetails(worker.id);
    } else {
      bankDetails = [worker.id, "", null, CASH_BANK_CODE];
    }
    setAllRows((prev) => prev.map((w) => (w.id === worker.id ? { ...w, bankDetails } : w)));
    try {
      await workersService.update(worker.id, { bankDetails });
    } catch (err) {
      alert(err.message || "Error al actualizar");
      await load();
    }
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
        width: 380,
        pinned: "right",
        cellRenderer: (p) => {
          const isRut = isCuentaRut(p.data.bankDetails);
          const isCash = isCashBank(p.data.bankDetails?.[3]);
          return (
            <div className="flex h-full items-center gap-1">
              <button
                onClick={() => setBankShortcut(p.data, "cuentaRut")}
                title="Asignar Cuenta RUT (Banco Estado)"
                className={`rounded-md border px-2 py-1 text-xs ${
                  isRut && !isCash
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                    : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"
                }`}
              >
                🆔 Cta. RUT
              </button>
              <button
                onClick={() => setBankShortcut(p.data, "efectivo")}
                title="Marcar como Efectivo"
                className={`rounded-md border px-2 py-1 text-xs ${
                  isCash
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                    : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"
                }`}
              >
                💵 Efec.
              </button>
              <button
                onClick={() => setSummary(p.data)}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
              >
                📊
              </button>
              <button
                onClick={() => setEdit({ mode: "edit", worker: p.data })}
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
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trabajadores</h1>
          <p className="text-sm text-[var(--color-muted)]">
            {search.trim() ? `${filtered.length} de ${allRows.length}` : `${allRows.length} registrados`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por RUT o nombre... (vacío = todos)"
              className="w-80 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 pr-16 text-sm shadow-sm outline-none focus:border-[var(--color-accent)]"
            />
            {queryKind && (
              <span className="absolute top-1/2 right-2 -translate-y-1/2 rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-accent)]">
                {queryKind === "rut" ? "RUT" : "Nombre"}
              </span>
            )}
          </div>
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
        ) : filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] text-sm text-[var(--color-muted)]">
            {search.trim() ? `Sin resultados para "${search}".` : "Aún no hay trabajadores."}
          </div>
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
        allWorkers={allRows}
        onClose={() => setEdit(null)}
        onSaved={onSaved}
      />

      <WorkerSummaryModal
        open={!!summary}
        worker={summary}
        onClose={() => setSummary(null)}
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
