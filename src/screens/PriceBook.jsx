import { useEffect, useMemo, useState } from "react";
import { useToast } from "../contexts/ToastContext";
import { faenasService, priceBookService, priceBookConfigService } from "../services";
import Modal from "../components/Modal";
import Select from "../components/Select";
import TextField from "../components/TextField";
import ConfirmDialog from "../components/ConfirmDialog";

// Registro contable de precios por faena/labor — deliberadamente independiente
// de faenas/cycles/labors reales: acepta faenas "dummy" (solo un nombre, sin
// doc real) para poder documentar temporadas antiguas que no están en el
// sistema. La unidad de precio es un catálogo propio y editable de este libro
// (no los catálogos reales de la app) — crece solo a medida que se escriben
// unidades nuevas (ej. "Saco"), vía <datalist>, sin pantalla de admin aparte.
// Una misma entrada puede tener varias líneas de precio (ej. parte se pagó
// por kilo y parte por metro en el mismo período).

const DEFAULT_UNITS = ["Kilo", "Metro", "Jornada", "Hora", "Trato", "Bandeja", "Capacho"];
const DATALIST_ID = "pricebook-units-list";

const fmtCLP = (v) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(Number(v) || 0);
const fmtDate = (d) => (d ? new Date(d + "T00:00:00").toLocaleDateString("es-CL") : "—");
const fmtRange = (from, to) => `${fmtDate(from)} – ${to ? fmtDate(to) : "vigente"}`;
const emptyPriceLine = () => ({
  unit: "", label: "", payPrice: "", chargePrice: "",
  hasOvertime: false, overtimePayPrice: "", overtimeChargePrice: "",
});
// Match "suave" — la unidad es texto libre del catálogo propio, así que solo
// comparamos sin mayúsculas/espacios; variantes raras simplemente no muestran
// el toggle de horas extra (no es un enum cerrado).
const isJornadaUnit = (unit) => (unit || "").trim().toLowerCase() === "jornada";

const groupKeyOf = (entry) => entry.faenaId || `dummy:${entry.faenaLabel}`;

export default function PriceBook() {
  const toast = useToast();
  const [faenas, setFaenas] = useState([]);
  const [entries, setEntries] = useState([]);
  const [hiddenFaenaIds, setHiddenFaenaIds] = useState(new Set());
  const [units, setUnits] = useState(DEFAULT_UNITS);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(new Set());
  const [formEntry, setFormEntry] = useState(null); // null | {} (nueva) | entry existente
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [hiddenModalOpen, setHiddenModalOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const [fa, en, cfg] = await Promise.all([
        faenasService.list({ order: ["name", "asc"], cache: true }),
        priceBookService.list({ order: ["dateFrom", "desc"] }),
        priceBookConfigService.getById("main"),
      ]);
      setFaenas(fa);
      setEntries(en);
      setHiddenFaenaIds(new Set(cfg?.hiddenFaenaIds || []));
      setUnits(cfg?.units?.length ? cfg.units : DEFAULT_UNITS);
    } catch (err) {
      toast.error("No se pudo cargar el libro de precios: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const faenaById = useMemo(() => new Map(faenas.map((f) => [f.id, f])), [faenas]);

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map = new Map();
    for (const e of entries) {
      const key = groupKeyOf(e);
      if (!map.has(key)) {
        map.set(key, {
          key,
          faenaId: e.faenaId || null,
          faenaLabel: e.faenaId ? faenaById.get(e.faenaId)?.name || e.faenaLabel : e.faenaLabel,
          isDummy: !e.faenaId,
          entries: [],
        });
      }
      map.get(key).entries.push(e);
    }
    let list = [...map.values()];
    if (q) {
      list = list
        .map((g) => ({
          ...g,
          entries: g.faenaLabel?.toLowerCase().includes(q)
            ? g.entries
            : g.entries.filter((e) => e.labor?.toLowerCase().includes(q)),
        }))
        .filter((g) => g.entries.length > 0);
    }
    list.forEach((g) => g.entries.sort((a, b) => (b.dateFrom || "").localeCompare(a.dateFrom || "")));
    list.sort((a, b) => (b.entries[0]?.dateFrom || "").localeCompare(a.entries[0]?.dateFrom || ""));
    return list;
  }, [entries, search, faenaById]);

  const toggleExpanded = (key) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    await priceBookService.remove(confirmDelete.id);
    setConfirmDelete(null);
    toast.success("Entrada eliminada");
    reload();
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Libro de precios");
      ws.addRow([
        "Faena", "Labor", "Unidad", "Detalle", "Precio pagado", "Precio cobrado", "Margen",
        "¿Horas extra?", "HE pagado", "HE cobrado", "Margen HE",
        "Transporte", "Dónde (transporte)", "Costo transporte", "Desde", "Hasta", "Período", "Notas",
      ]);
      ws.getRow(1).font = { bold: true };
      for (const g of groups) {
        for (const e of g.entries) {
          for (const p of e.prices || []) {
            ws.addRow([
              g.faenaLabel,
              e.labor,
              p.unit,
              p.label || "",
              Number(p.payPrice) || 0,
              Number(p.chargePrice) || 0,
              (Number(p.chargePrice) || 0) - (Number(p.payPrice) || 0),
              p.hasOvertime ? "Sí" : "No",
              p.hasOvertime ? Number(p.overtimePayPrice) || 0 : "",
              p.hasOvertime ? Number(p.overtimeChargePrice) || 0 : "",
              p.hasOvertime ? (Number(p.overtimeChargePrice) || 0) - (Number(p.overtimePayPrice) || 0) : "",
              e.transportIncluded ? "Incluido" : "No incluido",
              e.transportIncluded ? "" : e.transportWhere || "",
              e.transportIncluded ? "" : Number(e.transportCost) || 0,
              fmtDate(e.dateFrom),
              e.dateTo ? fmtDate(e.dateTo) : "Vigente",
              e.periodNote || "",
              e.notes || "",
            ]);
          }
        }
      }
      ws.columns.forEach((c) => { c.width = 20; });
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "LibroDePrecios.xlsx";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error("No se pudo exportar: " + err.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <datalist id={DATALIST_ID}>
        {units.map((u) => <option key={u} value={u} />)}
      </datalist>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">📖 Libro de Precios</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Registro contable de precios por faena y labor — incluye faenas antiguas que no están en el sistema.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setHiddenModalOpen(true)}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
          >
            ⚙ Faenas visibles
          </button>
          <button
            onClick={handleExport}
            disabled={exporting || entries.length === 0}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exporting ? "Exportando…" : "⬇ Exportar Excel"}
          </button>
          <button
            onClick={() => setFormEntry({})}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
          >
            + Agregar entrada
          </button>
        </div>
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Buscar por faena o labor…"
        className="w-full max-w-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />

      {loading ? (
        <p className="text-sm text-[var(--color-muted)]">Cargando…</p>
      ) : groups.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-muted)]">
          {entries.length === 0 ? "No hay entradas todavía." : "No hay resultados para esa búsqueda."}
        </p>
      ) : (
        <div className="space-y-2">
          {groups.map((g) => {
            const isOpen = expanded.has(g.key);
            return (
              <div key={g.key} className="rounded-md border border-[var(--color-border)]">
                <button
                  onClick={() => toggleExpanded(g.key)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[var(--color-surface-2)]"
                >
                  <span className="flex items-center gap-2 font-medium">
                    <span>{isOpen ? "▾" : "▸"}</span>
                    <span>{g.faenaLabel || "(sin nombre)"}</span>
                    {g.isDummy && (
                      <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] uppercase text-[var(--color-muted)]">
                        histórica
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-[var(--color-muted)]">{g.entries.length} entrada(s)</span>
                </button>
                {isOpen && (
                  <div className="overflow-x-auto border-t border-[var(--color-border)]">
                    <table className="w-full min-w-[760px] table-fixed text-sm">
                      <colgroup>
                        <col className="w-[15%]" />
                        <col className="w-[32%]" />
                        <col className="w-[25%]" />
                        <col className="w-[16%]" />
                        <col className="w-[12%]" />
                      </colgroup>
                      <thead className="bg-[var(--color-surface-2)] text-left text-xs uppercase tracking-wide text-[var(--color-muted)]">
                        <tr>
                          <th className="px-3 py-2">Labor</th>
                          <th className="px-3 py-2">Precios</th>
                          <th className="px-3 py-2">Transporte</th>
                          <th className="px-3 py-2">Período</th>
                          <th className="px-3 py-2 text-right">Acciones</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-border)]">
                        {g.entries.map((e) => (
                          <tr key={e.id}>
                            <td className="px-3 py-2 align-top">{e.labor}</td>
                            <td className="px-3 py-2 align-top break-words">
                              <div className="space-y-1">
                                {(e.prices || []).map((p, i) => {
                                  const margin = (Number(p.chargePrice) || 0) - (Number(p.payPrice) || 0);
                                  const heMargin = (Number(p.overtimeChargePrice) || 0) - (Number(p.overtimePayPrice) || 0);
                                  return (
                                    <div key={i}>
                                      <div>
                                        <span className="font-medium">{p.unit}{p.label ? ` (${p.label})` : ""}:</span>{" "}
                                        <span className="tabular-nums">{fmtCLP(p.payPrice)} pagado</span>
                                        {" / "}
                                        <span className="tabular-nums">{fmtCLP(p.chargePrice)} cobrado</span>{" "}
                                        <span className={`tabular-nums ${margin < 0 ? "text-[var(--color-danger)]" : "text-[var(--color-success,#16a34a)]"}`}>
                                          ({fmtCLP(margin)})
                                        </span>
                                      </div>
                                      {p.hasOvertime && (
                                        <div className="pl-3 text-xs text-[var(--color-muted)]">
                                          ⏱ Horas extra: <span className="tabular-nums">{fmtCLP(p.overtimePayPrice)} pagado</span>
                                          {" / "}
                                          <span className="tabular-nums">{fmtCLP(p.overtimeChargePrice)} cobrado</span>{" "}
                                          <span className={`tabular-nums ${heMargin < 0 ? "text-[var(--color-danger)]" : "text-[var(--color-success,#16a34a)]"}`}>
                                            ({fmtCLP(heMargin)})
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </td>
                            <td className="px-3 py-2 align-top break-words">
                              {e.transportIncluded ? (
                                "Transporte incluido"
                              ) : (
                                <span title={e.transportWhere || ""}>
                                  No incluido — {e.transportWhere || "sin especificar"} ({fmtCLP(e.transportCost)})
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 align-top text-[var(--color-muted)]">
                              {fmtRange(e.dateFrom, e.dateTo)}
                              {e.periodNote && <div className="text-xs">{e.periodNote}</div>}
                            </td>
                            <td className="px-3 py-2 align-top">
                              <div className="flex justify-end gap-1.5">
                                <button
                                  onClick={() => setFormEntry(e)}
                                  className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                                >
                                  Editar
                                </button>
                                <button
                                  onClick={() => setConfirmDelete(e)}
                                  className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft,rgba(220,38,38,0.12))]"
                                >
                                  ✕
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {formEntry && (
        <EntryFormModal
          initial={formEntry}
          faenas={faenas}
          hiddenFaenaIds={hiddenFaenaIds}
          units={units}
          onClose={() => setFormEntry(null)}
          onSaved={() => { setFormEntry(null); reload(); }}
        />
      )}

      {hiddenModalOpen && (
        <HiddenFaenasModal
          faenas={faenas}
          hiddenFaenaIds={hiddenFaenaIds}
          onClose={() => setHiddenModalOpen(false)}
          onSaved={() => { setHiddenModalOpen(false); reload(); }}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Eliminar entrada"
        message={confirmDelete ? `¿Eliminar el precio de "${confirmDelete.labor}" del período ${fmtRange(confirmDelete.dateFrom, confirmDelete.dateTo)}?` : ""}
        confirmLabel="Eliminar"
        danger
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="space-y-3 rounded-md border border-[var(--color-border)] p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">{title}</div>
      {children}
    </div>
  );
}

function EntryFormModal({ initial, faenas, hiddenFaenaIds, units, onClose, onSaved }) {
  const toast = useToast();
  const isEdit = !!initial.id;
  const [mode, setMode] = useState(initial.faenaId || !initial.id ? "real" : "dummy");
  const [faenaId, setFaenaId] = useState(initial.faenaId || "");
  const [faenaLabel, setFaenaLabel] = useState(initial.faenaId ? "" : initial.faenaLabel || "");
  const [labor, setLabor] = useState(initial.labor || "");
  const [priceLines, setPriceLines] = useState(
    initial.prices?.length ? initial.prices.map((p) => ({ ...p })) : [emptyPriceLine()]
  );
  const [transportIncluded, setTransportIncluded] = useState(initial.id ? !!initial.transportIncluded : true);
  const [transportWhere, setTransportWhere] = useState(initial.transportWhere || "");
  const [transportCost, setTransportCost] = useState(initial.transportCost ?? "");
  const [dateFrom, setDateFrom] = useState(initial.dateFrom || new Date().toLocaleDateString("sv-SE"));
  const [dateTo, setDateTo] = useState(initial.dateTo || "");
  const [periodNote, setPeriodNote] = useState(initial.periodNote || "");
  const [notes, setNotes] = useState(initial.notes || "");
  const [busy, setBusy] = useState(false);

  const visibleFaenas = faenas.filter((f) => !hiddenFaenaIds.has(f.id));

  const updateLine = (i, patch) => {
    setPriceLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  };
  const addLine = () => setPriceLines((prev) => [...prev, emptyPriceLine()]);
  const removeLine = (i) => setPriceLines((prev) => prev.filter((_, idx) => idx !== i));

  const submit = async () => {
    const isReal = mode === "real";
    if (isReal && !faenaId) { toast.error("Elige una faena"); return; }
    if (!isReal && !faenaLabel.trim()) { toast.error("Escribe el nombre de la faena"); return; }
    if (!labor.trim()) { toast.error("La labor es obligatoria"); return; }

    const cleanLines = priceLines.map((l) => ({
      unit: l.unit.trim(),
      label: l.label.trim() || null,
      payPrice: Number(l.payPrice),
      chargePrice: Number(l.chargePrice),
      hasOvertime: isJornadaUnit(l.unit) && !!l.hasOvertime,
      overtimePayPrice: isJornadaUnit(l.unit) && l.hasOvertime ? Number(l.overtimePayPrice) : null,
      overtimeChargePrice: isJornadaUnit(l.unit) && l.hasOvertime ? Number(l.overtimeChargePrice) : null,
    }));
    for (const l of cleanLines) {
      if (!l.unit) { toast.error("Cada línea de precio necesita una unidad"); return; }
      if (!l.payPrice || l.payPrice <= 0) { toast.error(`Precio pagado inválido para "${l.unit}"`); return; }
      if (!l.chargePrice || l.chargePrice <= 0) { toast.error(`Precio cobrado inválido para "${l.unit}"`); return; }
      if (l.hasOvertime) {
        if (!l.overtimePayPrice || l.overtimePayPrice <= 0) { toast.error(`Indica cuánto se pagó de hora extra para "${l.unit}"`); return; }
        if (!l.overtimeChargePrice || l.overtimeChargePrice <= 0) { toast.error(`Indica cuánto se cobró de hora extra para "${l.unit}"`); return; }
      }
    }
    if (!dateFrom) { toast.error("La fecha de inicio es obligatoria"); return; }
    if (dateTo && dateTo < dateFrom) { toast.error("La fecha de fin no puede ser anterior a la de inicio"); return; }
    if (!transportIncluded) {
      if (!transportWhere.trim()) { toast.error("Indica dónde se cobró el transporte"); return; }
      if (!Number(transportCost) || Number(transportCost) <= 0) { toast.error("Indica cuánto se cobró el transporte"); return; }
    }

    const resolvedFaenaLabel = isReal ? faenas.find((f) => f.id === faenaId)?.name || "" : faenaLabel.trim();

    setBusy(true);
    try {
      // Suma al catálogo propio del libro cualquier unidad nueva que se haya escrito.
      const newUnits = cleanLines
        .map((l) => l.unit)
        .filter((u) => !units.some((existing) => existing.toLowerCase() === u.toLowerCase()));
      if (newUnits.length) {
        const dedup = [...new Set([...units, ...newUnits])];
        await priceBookConfigService.upsert("main", { units: dedup });
      }

      const payload = {
        faenaId: isReal ? faenaId : null,
        faenaLabel: resolvedFaenaLabel,
        labor: labor.trim(),
        prices: cleanLines,
        transportIncluded,
        transportWhere: transportIncluded ? null : transportWhere.trim(),
        transportCost: transportIncluded ? null : Number(transportCost),
        dateFrom,
        dateTo: dateTo || null,
        periodNote: periodNote.trim() || null,
        notes: notes.trim() || null,
      };
      if (isEdit) await priceBookService.update(initial.id, payload);
      else await priceBookService.create(payload);
      toast.success(isEdit ? "Entrada actualizada" : "Entrada agregada");
      onSaved();
    } catch (err) {
      toast.error("No se pudo guardar: " + err.message);
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]";

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? "Editar entrada" : "Nueva entrada"}
      size="lg"
      footer={
        <>
          <button onClick={onClose} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
          >
            {busy ? "Guardando…" : "Guardar"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Section title="Faena">
          <div className="flex gap-2 text-sm">
            <button
              type="button"
              onClick={() => setMode("real")}
              className={`flex-1 rounded-md border px-3 py-1.5 ${mode === "real" ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]" : "border-[var(--color-border)]"}`}
            >
              Faena existente
            </button>
            <button
              type="button"
              onClick={() => setMode("dummy")}
              className={`flex-1 rounded-md border px-3 py-1.5 ${mode === "dummy" ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]" : "border-[var(--color-border)]"}`}
            >
              Faena histórica (sin registro)
            </button>
          </div>
          {mode === "real" ? (
            <Select
              label="Faena"
              required
              value={faenaId}
              onChange={setFaenaId}
              options={visibleFaenas.map((f) => ({ value: f.id, label: f.name }))}
            />
          ) : (
            <TextField label="Nombre de la faena" required value={faenaLabel} onChange={setFaenaLabel} placeholder="Ej. Fundo Los Alerces — 2022" />
          )}
          <TextField label="Labor" required value={labor} onChange={setLabor} placeholder="Ej. Cosecha, Poda, Raleo…" />
        </Section>

        <Section title="Precios">
          <div className="space-y-3">
            {priceLines.map((line, i) => (
              <div key={i} className="space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex w-full flex-wrap gap-2 sm:flex-nowrap">
                    <div className="w-full sm:flex-1">
                      <span className="mb-1 block text-sm text-[var(--color-muted)]">
                        Unidad <span className="text-[var(--color-danger)]">*</span>
                      </span>
                      <input
                        type="text"
                        list={DATALIST_ID}
                        value={line.unit}
                        onChange={(e) => updateLine(i, { unit: e.target.value })}
                        placeholder="Ej. Kilo, Saco, Metro…"
                        className={inputCls}
                      />
                    </div>
                    <div className="w-full sm:flex-1">
                      <TextField
                        label="Detalle (opcional)"
                        value={line.label}
                        onChange={(v) => updateLine(i, { label: v })}
                        placeholder="Ej. Primera pasada, Calidad exportación…"
                      />
                    </div>
                  </div>
                  {priceLines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeLine(i)}
                      title="Quitar esta línea"
                      className="mt-6 shrink-0 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft,rgba(220,38,38,0.12))]"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 sm:flex-nowrap">
                  <div className="w-full sm:flex-1">
                    <TextField label="Pagado" type="number" required value={line.payPrice} onChange={(v) => updateLine(i, { payPrice: v })} placeholder="0" />
                  </div>
                  <div className="w-full sm:flex-1">
                    <TextField label="Cobrado" type="number" required value={line.chargePrice} onChange={(v) => updateLine(i, { chargePrice: v })} placeholder="0" />
                  </div>
                </div>

                {isJornadaUnit(line.unit) && (
                  <div className="space-y-2 border-t border-[var(--color-border)] pt-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={!!line.hasOvertime}
                        onChange={(e) => updateLine(i, { hasOvertime: e.target.checked })}
                      />
                      ¿Hubo horas extras?
                    </label>
                    {line.hasOvertime && (
                      <div className="flex flex-wrap gap-2 sm:flex-nowrap">
                        <div className="w-full sm:flex-1">
                          <TextField
                            label="HE — Pagado"
                            type="number"
                            required
                            value={line.overtimePayPrice}
                            onChange={(v) => updateLine(i, { overtimePayPrice: v })}
                            placeholder="0"
                          />
                        </div>
                        <div className="w-full sm:flex-1">
                          <TextField
                            label="HE — Cobrado"
                            type="number"
                            required
                            value={line.overtimeChargePrice}
                            onChange={(v) => updateLine(i, { overtimeChargePrice: v })}
                            placeholder="0"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addLine}
            className="text-sm text-[var(--color-accent)] hover:underline"
          >
            + Agregar otra unidad de pago
          </button>
          <p className="text-xs text-[var(--color-muted)]">
            Si la faena se cosechó/pagó con más de una unidad (ej. parte por kilo, parte por saco), agrega una línea por cada una.
          </p>
        </Section>

        <Section title="Transporte">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={transportIncluded} onChange={(e) => setTransportIncluded(e.target.checked)} />
            Transporte incluido en el precio
          </label>
          {!transportIncluded && (
            <div className="flex flex-wrap gap-2 sm:flex-nowrap">
              <div className="w-full sm:flex-1">
                <TextField label="¿Dónde? (ruta / proveedor)" required value={transportWhere} onChange={setTransportWhere} placeholder="Ej. Fundo X → Planta Y" />
              </div>
              <div className="w-full sm:flex-1">
                <TextField label="¿Cuánto se cobró?" type="number" required value={transportCost} onChange={setTransportCost} placeholder="0" />
              </div>
            </div>
          )}
        </Section>

        <Section title="Vigencia">
          <div className="flex flex-wrap gap-2 sm:flex-nowrap">
            <label className="block w-full sm:flex-1">
              <span className="mb-1 block text-sm text-[var(--color-muted)]">
                Desde <span className="text-[var(--color-danger)]">*</span>
              </span>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputCls} />
            </label>
            <label className="block w-full sm:flex-1">
              <span className="mb-1 block text-sm text-[var(--color-muted)]">Hasta (vacío = vigente)</span>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputCls} />
            </label>
          </div>
          <TextField label="Período (opcional)" value={periodNote} onChange={setPeriodNote} placeholder="Ej. Temporada 2025-2026" />
        </Section>

        <label className="block">
          <span className="mb-1 block text-sm text-[var(--color-muted)]">Notas (opcional)</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputCls} />
        </label>
      </div>
    </Modal>
  );
}

function HiddenFaenasModal({ faenas, hiddenFaenaIds, onClose, onSaved }) {
  const toast = useToast();
  const [hidden, setHidden] = useState(new Set(hiddenFaenaIds));
  const [busy, setBusy] = useState(false);

  const toggle = (id) => {
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const submit = async () => {
    setBusy(true);
    try {
      await priceBookConfigService.upsert("main", { hiddenFaenaIds: [...hidden] });
      toast.success("Preferencias guardadas");
      onSaved();
    } catch (err) {
      toast.error("No se pudo guardar: " + err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Faenas visibles en el selector"
      size="sm"
      footer={
        <>
          <button onClick={onClose} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
          >
            {busy ? "Guardando…" : "Guardar"}
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-[var(--color-muted)]">
        Desmarca las faenas que no quieres ver en el selector "Faena existente" del libro de precios (ej. nombres poco legibles o de prueba). No afecta a Faenas, Calendario ni el resto de la app.
      </p>
      <div className="max-h-80 space-y-1 overflow-y-auto">
        {faenas.map((f) => (
          <label key={f.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--color-surface-2)]">
            <input type="checkbox" checked={!hidden.has(f.id)} onChange={() => toggle(f.id)} />
            <span>{f.name || "(sin nombre)"}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
