// Pantalla de facturación — v1: importar el RCV (Registro de Compras y Ventas)
// del SII y consultar los documentos importados. La emisión queda fuera de
// alcance por ahora: se hace en el portal SII y después se trae el período
// mensual al sistema vía CSV. Soporta ventas y compras (un CSV cada una).
//
// El doc id de cada DTE es determinístico (`{rutEmisor}_{tipo}_{folio}`), así
// re-importar el mismo período sobreescribe sin duplicar.

import { useEffect, useMemo, useRef, useState } from "react";
import { writeBatch, doc, serverTimestamp } from "firebase/firestore";
import { db, auth } from "../firebase";
import { dteDocumentsService } from "../services";
import { parseSiiRcvCsv, dteTypeLabel } from "../utils/siiCsvParser";
import { formatRutForDisplay } from "../utils/rutUtils";
import Modal from "../components/Modal";

const fmtCurrency = (v) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 }).format(
    Number(v) || 0,
  );
const fmtNumber = (v) =>
  new Intl.NumberFormat("es-CL", { minimumFractionDigits: 0 }).format(Number(v) || 0);

export default function Facturacion() {
  const [kindTab, setKindTab] = useState("venta"); // "venta" | "compra"
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState(null);
  // Filtros sobre el listado.
  const [periodoFilter, setPeriodoFilter] = useState(""); // "YYYY-MM" o ""
  const [tipoFilter, setTipoFilter] = useState(""); // "33" | "61" | ...
  const [search, setSearch] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      // Trae todo y filtra client-side. El volumen esperado son cientos a
      // pocos miles de docs por empresa — manejable. Si crece, cambiar a
      // `wheres: [["kind", "==", kindTab], ["periodo", "==", periodoFilter]]`.
      const list = await dteDocumentsService.list({
        order: ["fechaEmision", "desc"],
        cache: true,
        ttl: 60_000,
      });
      setDocs(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Lista filtrada por tab + filtros activos.
  const filtered = useMemo(() => {
    let arr = docs.filter((d) => d.kind === kindTab);
    if (periodoFilter) arr = arr.filter((d) => d.periodo === periodoFilter);
    if (tipoFilter) arr = arr.filter((d) => String(d.tipo) === String(tipoFilter));
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      arr = arr.filter((d) => {
        const razon = (kindTab === "venta" ? d.razonSocialReceptor : d.razonSocialEmisor) || "";
        const rut = (kindTab === "venta" ? d.rutReceptor : d.rutEmisor) || "";
        return (
          razon.toLowerCase().includes(q) ||
          rut.toLowerCase().includes(q) ||
          String(d.folio).includes(q)
        );
      });
    }
    return arr;
  }, [docs, kindTab, periodoFilter, tipoFilter, search]);

  // Opciones únicas para los selects de filtro (sale del dataset filtrado por kind).
  const periodoOptions = useMemo(() => {
    const set = new Set();
    for (const d of docs) if (d.kind === kindTab && d.periodo) set.add(d.periodo);
    return [...set].sort().reverse();
  }, [docs, kindTab]);

  const tipoOptions = useMemo(() => {
    const set = new Set();
    for (const d of docs) if (d.kind === kindTab) set.add(d.tipo);
    return [...set].sort((a, b) => a - b);
  }, [docs, kindTab]);

  // Totales del listado actual.
  const totals = useMemo(() => {
    return filtered.reduce(
      (acc, d) => ({
        neto: acc.neto + (Number(d.neto) || 0),
        iva: acc.iva + (Number(d.iva) || 0),
        total: acc.total + (Number(d.total) || 0),
        count: acc.count + 1,
      }),
      { neto: 0, iva: 0, total: 0, count: 0 },
    );
  }, [filtered]);

  // --- IMPORTACIÓN ---

  const onFilePick = async (file) => {
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseSiiRcvCsv(buffer);
      if (parsed.records.length === 0) {
        alert("El archivo no contiene registros válidos.");
        return;
      }
      setImportPreview({ file: file.name, ...parsed });
    } catch (err) {
      alert("Error al parsear: " + (err.message || String(err)));
    }
  };

  const confirmImport = async () => {
    if (!importPreview) return;
    setImporting(true);
    try {
      // Verificamos duplicados contra lo que ya tenemos cargado para informar
      // al usuario después del import (no bloquea, solo cuenta).
      const existing = new Set(docs.map((d) => d.id));
      const records = importPreview.records;
      const dupCount = records.filter((r) => existing.has(r.id)).length;

      // Escribimos en chunks de 450 (límite Firestore por batch = 500). Cada
      // doc usa `setDoc` con merge=true para que reimportar el mismo período
      // sobreescriba en lugar de duplicar.
      const uid = auth.currentUser?.uid || null;
      const CHUNK = 450;
      for (let i = 0; i < records.length; i += CHUNK) {
        const slice = records.slice(i, i + CHUNK);
        const batch = writeBatch(db);
        for (const r of slice) {
          const { id, ...rest } = r;
          batch.set(
            doc(db, "dteDocuments", id),
            { ...rest, importedAt: serverTimestamp(), importedBy: uid },
            { merge: true },
          );
        }
        await batch.commit();
      }
      dteDocumentsService.invalidate();
      alert(
        `Importación lista.\n` +
        `Nuevos: ${records.length - dupCount}\n` +
        `Sobrescritos: ${dupCount}\n` +
        `Total: ${records.length}`,
      );
      setImportPreview(null);
      await load();
    } catch (err) {
      alert("Error al guardar: " + (err.message || String(err)));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Facturación</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Importar el Registro de Compras y Ventas (RCV) del portal SII.
          </p>
        </div>
        <ImportButton onPick={onFilePick} />
      </div>

      <div className="mb-3 flex gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1 text-sm self-start">
        {[
          { v: "venta", label: "📤 Ventas (emitidas)" },
          { v: "compra", label: "📥 Compras (recibidas)" },
        ].map((t) => (
          <button
            key={t.v}
            onClick={() => setKindTab(t.v)}
            className={`rounded px-3 py-1 ${
              kindTab === t.v
                ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                : "text-[var(--color-muted)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={periodoFilter}
          onChange={(e) => setPeriodoFilter(e.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs"
        >
          <option value="">Todos los períodos</option>
          {periodoOptions.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select
          value={tipoFilter}
          onChange={(e) => setTipoFilter(e.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs"
        >
          <option value="">Todos los tipos</option>
          {tipoOptions.map((t) => (
            <option key={t} value={t}>
              {t} · {dteTypeLabel(t)}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`Buscar por ${kindTab === "venta" ? "cliente" : "proveedor"}, RUT o folio...`}
          className="flex-1 min-w-[200px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryCard label="Documentos" value={fmtNumber(totals.count)} />
        <SummaryCard label="Neto" value={fmtCurrency(totals.neto)} />
        <SummaryCard label="IVA" value={fmtCurrency(totals.iva)} />
        <SummaryCard label="Total" value={fmtCurrency(totals.total)} highlight />
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center text-[var(--color-muted)]">
          Cargando...
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-[var(--color-border)] text-sm text-[var(--color-muted)]">
          {docs.some((d) => d.kind === kindTab)
            ? "Sin coincidencias para los filtros aplicados."
            : `No hay ${kindTab === "venta" ? "ventas" : "compras"} importadas. Usá "📥 Importar CSV del SII".`}
        </div>
      ) : (
        <div className="flex-1 overflow-auto rounded-md border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--color-surface-2)] text-xs uppercase tracking-wide text-[var(--color-muted)]">
              <tr>
                <th className="px-2 py-2 text-left">Período</th>
                <th className="px-2 py-2 text-left">Fecha</th>
                <th className="px-2 py-2 text-left">Tipo</th>
                <th className="px-2 py-2 text-right">Folio</th>
                <th className="px-2 py-2 text-left">{kindTab === "venta" ? "Cliente" : "Proveedor"}</th>
                <th className="px-2 py-2 text-left">RUT</th>
                <th className="px-2 py-2 text-right">Neto</th>
                <th className="px-2 py-2 text-right">IVA</th>
                <th className="px-2 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => {
                const razon = kindTab === "venta" ? d.razonSocialReceptor : d.razonSocialEmisor;
                const rut = kindTab === "venta" ? d.rutReceptor : d.rutEmisor;
                return (
                  <tr key={d.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-2)]">
                    <td className="px-2 py-1.5 font-mono text-xs text-[var(--color-muted)]">{d.periodo}</td>
                    <td className="px-2 py-1.5 font-mono text-xs">{d.fechaEmision}</td>
                    <td className="px-2 py-1.5 text-xs">
                      <span className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5">
                        {d.tipo}
                      </span>
                      <span className="ml-1 text-[var(--color-muted)]">{d.tipoLabel}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{d.folio}</td>
                    <td className="px-2 py-1.5 truncate max-w-[300px]">{razon || "—"}</td>
                    <td className="px-2 py-1.5 font-mono text-xs">{formatRutForDisplay(rut)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtCurrency(d.neto)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtCurrency(d.iva)}</td>
                    <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{fmtCurrency(d.total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {importPreview && (
        <ImportPreviewModal
          preview={importPreview}
          existingIds={new Set(docs.map((d) => d.id))}
          busy={importing}
          onConfirm={confirmImport}
          onCancel={() => setImportPreview(null)}
        />
      )}
    </div>
  );
}

function SummaryCard({ label, value, highlight = false }) {
  return (
    <div
      className={`rounded-md border px-3 py-2 ${
        highlight
          ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
          : "border-[var(--color-border)] bg-[var(--color-surface)]"
      }`}
    >
      <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${highlight ? "text-[var(--color-accent)]" : ""}`}>
        {value}
      </div>
    </div>
  );
}

// Botón de "Importar CSV" — abre el file picker oculto. Hace de wrapper porque
// el <input type=file> nativo es feo y no se estiliza bien.
function ImportButton({ onPick }) {
  const ref = useRef(null);
  return (
    <>
      <button
        onClick={() => ref.current?.click()}
        className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] shadow-sm hover:bg-[var(--color-accent-hover)]"
      >
        📥 Importar CSV del SII
      </button>
      <input
        ref={ref}
        type="file"
        accept=".csv,text/csv,text/plain"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          onPick(f);
          e.target.value = ""; // permite re-importar el mismo archivo
        }}
      />
    </>
  );
}

// Modal con preview del CSV parseado. Muestra:
//   - resumen (kind, count, total, # duplicados)
//   - tabla con las primeras N filas como sample
//   - errores de parsing (si hubo filas malformed)
function ImportPreviewModal({ preview, existingIds, busy, onConfirm, onCancel }) {
  const { file, kind, records, errors, stats } = preview;
  const dupCount = useMemo(
    () => records.filter((r) => existingIds.has(r.id)).length,
    [records, existingIds],
  );
  const sample = records.slice(0, 8);

  return (
    <Modal
      open
      onClose={busy ? () => {} : onCancel}
      size="2xl"
      title={`Importar ${kind === "venta" ? "ventas" : "compras"} — ${file}`}
      footer={
        <>
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={busy || records.length === 0}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
          >
            {busy ? "Importando..." : `Confirmar (${records.length} doc${records.length === 1 ? "" : "s"})`}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryCard label="Documentos" value={fmtNumber(stats.count)} />
        <SummaryCard label="Monto total" value={fmtCurrency(stats.totalAmount)} highlight />
        <SummaryCard label="Nuevos" value={fmtNumber(records.length - dupCount)} />
        <SummaryCard label="Sobrescribe" value={fmtNumber(dupCount)} />
      </div>

      {Object.keys(stats.byTipo).length > 0 && (
        <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
            Por tipo de documento
          </div>
          <div className="flex flex-wrap gap-1">
            {Object.entries(stats.byTipo).map(([tipo, count]) => (
              <span
                key={tipo}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-xs"
              >
                <span className="font-mono">{tipo}</span>
                <span className="ml-1 text-[var(--color-muted)]">{dteTypeLabel(tipo)}</span>
                <span className="ml-1 font-medium">· {count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 overflow-auto rounded-md border border-[var(--color-border)]">
        <table className="w-full text-xs">
          <thead className="bg-[var(--color-surface-2)] text-[var(--color-muted)]">
            <tr>
              <th className="px-2 py-1 text-left">Fecha</th>
              <th className="px-2 py-1 text-left">Tipo</th>
              <th className="px-2 py-1 text-right">Folio</th>
              <th className="px-2 py-1 text-left">{kind === "venta" ? "Cliente" : "Proveedor"}</th>
              <th className="px-2 py-1 text-left">RUT</th>
              <th className="px-2 py-1 text-right">Total</th>
              <th className="px-2 py-1 text-center">Estado</th>
            </tr>
          </thead>
          <tbody>
            {sample.map((r) => {
              const dup = existingIds.has(r.id);
              const razon = kind === "venta" ? r.razonSocialReceptor : r.razonSocialEmisor;
              const rut = kind === "venta" ? r.rutReceptor : r.rutEmisor;
              return (
                <tr key={r.id} className="border-t border-[var(--color-border)]">
                  <td className="px-2 py-1 font-mono">{r.fechaEmision}</td>
                  <td className="px-2 py-1">{r.tipo} · {r.tipoLabel}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{r.folio}</td>
                  <td className="px-2 py-1 truncate max-w-[200px]">{razon || "—"}</td>
                  <td className="px-2 py-1 font-mono">{formatRutForDisplay(rut)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtCurrency(r.total)}</td>
                  <td className="px-2 py-1 text-center">
                    {dup ? (
                      <span className="rounded bg-[var(--color-warning-soft)] px-1.5 py-0.5 text-[10px] text-[var(--color-warning)]">
                        sobreescribe
                      </span>
                    ) : (
                      <span className="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--color-accent)]">
                        nuevo
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {records.length > sample.length && (
              <tr>
                <td colSpan={7} className="px-2 py-1 text-center text-[var(--color-muted)]">
                  ...y {records.length - sample.length} más
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {errors.length > 0 && (
        <div className="mt-3 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-2 text-xs">
          <div className="mb-1 font-medium text-[var(--color-danger)]">
            {errors.length} línea{errors.length === 1 ? "" : "s"} no se pudieron parsear
          </div>
          <ul className="space-y-0.5">
            {errors.slice(0, 5).map((e, i) => (
              <li key={i} className="font-mono text-[10px] text-[var(--color-muted)]">
                Línea {e.line}: {e.message}
              </li>
            ))}
            {errors.length > 5 && (
              <li className="text-[10px] text-[var(--color-muted)]">
                ...y {errors.length - 5} más.
              </li>
            )}
          </ul>
        </div>
      )}
    </Modal>
  );
}
