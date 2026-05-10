import { useMemo, useRef, useState } from "react";
import { workersService } from "../services";
import { findWorkerByRut } from "../services/workersService";
import { parseCsv, buildWorkerPatch } from "../utils/importWorkers";
import { formatRutForDisplay } from "../utils/rutUtils";

export default function MigrateWorkers() {
  const [rawText, setRawText] = useState("");
  const [parsed, setParsed] = useState({ header: [], rows: [] });
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState({ created: 0, updated: 0, skipped: 0, errors: [] });
  const [filter, setFilter] = useState("");
  const fileRef = useRef(null);

  const onFile = async (file) => {
    const text = await file.text();
    setRawText(text);
    setParsed(parseCsv(text));
    setResults({ created: 0, updated: 0, skipped: 0, errors: [] });
  };

  const filteredRows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return parsed.rows;
    return parsed.rows.filter((r) =>
      [r.rut, r.nombre, r.apellido, r.apellido2, r.correo].some((v) =>
        String(v || "").toLowerCase().includes(q),
      ),
    );
  }, [parsed.rows, filter]);

  const run = async () => {
    if (!parsed.rows.length) return;
    if (!confirm(`¿Migrar ${parsed.rows.length} trabajador(es)? Se actualizarán los existentes (nombre + correo) y crearán los nuevos.`)) return;
    setRunning(true);
    setProgress({ done: 0, total: parsed.rows.length });
    const results = { created: 0, updated: 0, skipped: 0, errors: [] };
    for (let i = 0; i < parsed.rows.length; i++) {
      const row = parsed.rows[i];
      try {
        const rutNorm = String(row.rut || "").trim();
        if (!rutNorm) { results.skipped++; continue; }
        const existing = await findWorkerByRut(rutNorm);
        const built = buildWorkerPatch(row, existing);
        if (built.error) {
          results.errors.push({ row: i + 2, rut: row.rut, error: built.error });
          results.skipped++;
          continue;
        }
        if (built.mode === "update") {
          await workersService.update(built.rut, built.patch);
          results.updated++;
        } else {
          await workersService.create(built.payload, { id: built.rut });
          results.created++;
        }
      } catch (err) {
        results.errors.push({ row: i + 2, rut: row.rut, error: err.message || String(err) });
        results.skipped++;
      }
      setProgress({ done: i + 1, total: parsed.rows.length });
      setResults({ ...results });
    }
    setRunning(false);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Migrar trabajadores desde CSV</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Carga un archivo con columnas <code>RUT;Nombre;APELLIDO;APELLIDO2;CORREO;BANCO;TIPOCUENTA;N_CUENTA</code>.
          Existentes: actualiza nombre + correo. Nuevos: se crean con datos bancarios.
        </p>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          className="text-sm"
        />
        {parsed.rows.length > 0 && (
          <>
            <span className="text-sm text-[var(--color-muted)]">
              {parsed.rows.length} fila(s) parseada(s)
            </span>
            <button
              onClick={run}
              disabled={running}
              className="ml-auto rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
            >
              {running ? `Migrando ${progress.done}/${progress.total}...` : "Ejecutar migración"}
            </button>
          </>
        )}
      </div>

      {(results.created > 0 || results.updated > 0 || results.skipped > 0) && (
        <div className="mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-sm">
          <div className="flex flex-wrap gap-4">
            <div>
              <span className="text-[var(--color-muted)]">Creados:</span>{" "}
              <span className="font-semibold text-[var(--color-success)]">{results.created}</span>
            </div>
            <div>
              <span className="text-[var(--color-muted)]">Actualizados:</span>{" "}
              <span className="font-semibold">{results.updated}</span>
            </div>
            <div>
              <span className="text-[var(--color-muted)]">Saltados:</span>{" "}
              <span className="font-semibold text-[var(--color-warning)]">{results.skipped}</span>
            </div>
            <div>
              <span className="text-[var(--color-muted)]">Errores:</span>{" "}
              <span className="font-semibold text-[var(--color-danger)]">{results.errors.length}</span>
            </div>
          </div>
          {results.errors.length > 0 && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-[var(--color-danger)]">Ver errores</summary>
              <ul className="mt-1 max-h-48 overflow-auto">
                {results.errors.map((e, i) => (
                  <li key={i} className="font-mono">
                    Fila {e.row} — {e.rut} — {e.error}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {parsed.rows.length > 0 && (
        <>
          <div className="mb-2 flex items-center gap-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filtrar..."
              className="w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
            />
            <span className="text-xs text-[var(--color-muted)]">
              {filteredRows.length} de {parsed.rows.length}
            </span>
          </div>
          <div className="flex-1 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[var(--color-surface-2)] text-left text-xs">
                <tr>
                  <th className="px-2 py-1.5">RUT</th>
                  <th className="px-2 py-1.5">Nombre</th>
                  <th className="px-2 py-1.5">Apellido</th>
                  <th className="px-2 py-1.5">Apellido 2</th>
                  <th className="px-2 py-1.5">Correo</th>
                  <th className="px-2 py-1.5">Banco</th>
                  <th className="px-2 py-1.5">Tipo cta.</th>
                  <th className="px-2 py-1.5">N° cuenta</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.slice(0, 500).map((r, i) => (
                  <tr key={i} className="border-t border-[var(--color-border)]">
                    <td className="px-2 py-1 font-mono text-xs">{formatRutForDisplay(r.rut.trim()) || r.rut}</td>
                    <td className="px-2 py-1">{r.nombre}</td>
                    <td className="px-2 py-1">{r.apellido}</td>
                    <td className="px-2 py-1">{r.apellido2}</td>
                    <td className="px-2 py-1 text-xs">{r.correo || <span className="text-[var(--color-muted)]">—</span>}</td>
                    <td className="px-2 py-1 text-xs">{r.banco}</td>
                    <td className="px-2 py-1 text-xs">{r.tipoCuenta}</td>
                    <td className="px-2 py-1 font-mono text-xs">{r.nCuenta}</td>
                  </tr>
                ))}
                {filteredRows.length > 500 && (
                  <tr>
                    <td colSpan={8} className="px-2 py-2 text-center text-xs text-[var(--color-muted)]">
                      Mostrando 500 de {filteredRows.length}. Filtra para ver más.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
