import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { AgGridReact } from "ag-grid-react";
import { ModuleRegistry, AllCommunityModule } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import { toPng, toBlob } from "html-to-image";
import { cyclesService, faenasService, subfaenasService, workdaysService, workersService, groupLeadersService } from "../services";
import { formatRutForDisplay } from "../utils/rutUtils";
import { parseAmount } from "../utils/formula";
import { AG_GRID_LOCALE_ES } from "../utils/agGridLocale";
import {
  COSECHA_MODES,
  comboKey as makeComboKey,
  parseComboKey,
  qualityLabel,
  containerLabel,
  tratoTypeLabel,
  comboLabel,
  getDayCombos,
  getDaySingle,
  normalizeDayPricesEntry,
  workdayDocId,
  workdayMapKey,
  normalizeTratoDayPrices,
  getTratoTiers,
  normalizeTratoWorkday,
  getTratoTierTotals,
  PISO_COMBO_KEY,
  effectivePiso,
  getDayPiso,
} from "../utils/cosechaCombos";
import {
  TRATO_HE_MODES,
  DEFAULT_BONUS_MANEJO,
  DEFAULT_BONUS_SUPERVISION,
  DEFAULT_OVERTIME_RATE,
  DEFAULT_BASE_DAY,
  isWeekendDate,
  isRedDay,
  calcTratoHEAmount,
  workdayHasData,
} from "../utils/tratoHE";
import { useAuth } from "../contexts/AuthContext";
import { useCatalogs } from "../contexts/CatalogsContext";
import Modal from "../components/Modal";
import TextField from "../components/TextField";
import Select from "../components/Select";
import ConfirmDialog from "../components/ConfirmDialog";
import { useResizableHeight, ResizeHandle } from "../components/ResizableArea";
import WorkerPickerModal from "../components/WorkerPickerModal";
import WorkerEditModal from "../components/WorkerEditModal";
import TransportsModal from "../components/TransportsModal";
import CycleSummaryModal from "../components/CycleSummaryModal";
import { tripsService } from "../services/transportsService";

ModuleRegistry.registerModules([AllCommunityModule]);

const todayStr = () => new Date().toISOString().slice(0, 10);
const newId = () => (crypto?.randomUUID?.() || `id_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);

const fmtCurrency = (value) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 }).format(
    Number(value) || 0,
  );

const LABOR_TYPES = [
  { value: "main", label: "Pago al día" },
  { value: "supervision", label: "Supervisión" },
  { value: "extra", label: "Adicional" },
  { value: "cosecha", label: "Cosecha" },
  { value: "trato", label: "A trato" },
  { value: "tratoHE", label: "Jornadas con horas extras" },
];

const SINGLE_COMBO = "0_0";

function normalizeCycle(c) {
  let days = Array.isArray(c.days) ? [...c.days] : null;
  let labors = c.labors;
  if (!labors || !labors.length) {
    labors = [{ id: newId(), name: "Principal", type: "main", workers: c.workers || [] }];
  }
  if (!days) {
    const union = new Set();
    for (const l of labors) for (const d of l.days || []) union.add(d);
    days = [...union].sort();
  }
  labors = labors.map(({ days: _drop, ...rest }) => rest);
  return { ...c, days, labors };
}

function LeaderPickerModal({ open, onClose, leaders, workerName, busy, onPick }) {
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (open) setFilter("");
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toUpperCase();
    if (!q) return leaders;
    return leaders.filter((l) => l.includes(q));
  }, [leaders, filter]);

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title={`Asignar líder a ${workerName}`} size="md">
      <div className="space-y-3">
        <TextField
          label="Buscar líder"
          value={filter}
          onChange={setFilter}
          autoFocus
          placeholder="Filtrar..."
        />
        <div className="max-h-72 overflow-y-auto rounded-md border border-[var(--color-border)]">
          {leaders.length === 0 ? (
            <div className="p-3 text-sm text-[var(--color-muted)]">
              No hay líderes habilitados. Habilita líderes en la colección <code>groupLeader</code>.
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-3 text-sm text-[var(--color-muted)]">Sin resultados.</div>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {filtered.map((l) => (
                <li key={l}>
                  <button
                    onClick={() => onPick(l)}
                    disabled={busy}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
                  >
                    <span className="font-medium">{l}</span>
                    <span className="text-xs text-[var(--color-muted)]">→</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Header component for day columns / column groups. Renders the date plus a
// 📝 indicator that highlights when an annotation exists for that day. Click
// anywhere on the header opens the day-note modal. When a note exists, the
// browser tooltip shows the note text itself (so the user can read it on
// hover without opening the modal).
function DayHeader(props) {
  const { date, note, onClickNote, displayName } = props;
  const hasNote = !!String(note || "").trim();
  return (
    <span
      onClick={(e) => { e.stopPropagation(); onClickNote?.(date); }}
      title={hasNote ? note : "Agregar anotación del día"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        cursor: "pointer",
        width: "100%",
        height: "100%",
        userSelect: "none",
        padding: "0 4px",
      }}
    >
      <span>{displayName || date}</span>
      <span style={{
        fontSize: 12,
        color: hasNote ? "var(--color-accent)" : "var(--color-muted)",
        opacity: hasNote ? 1 : 0.55,
      }}>📝</span>
    </span>
  );
}

function GroupHeaderRowRenderer(props) {
  const data = props.data || {};
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 12px",
        height: "100%",
        background: "var(--color-accent-soft)",
        borderTop: "1px solid var(--color-border)",
        borderBottom: "1px solid var(--color-border)",
        fontWeight: 600,
        fontSize: 12,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "var(--color-accent)",
      }}
    >
      <span>👥 {data._leader}</span>
      <span style={{ opacity: 0.7, fontWeight: 400 }}>· {data._count} trab.</span>
    </div>
  );
}

// Columna "P" que se anexa al final de cada día en cosecha/trato. Toggle del
// piso del trabajador en ese día: click crea/borra el workday `_piso`. Solo
// es clickable si ya existe alguna producción del día (sin workday previo
// el botón queda deshabilitado).
function buildPisoChildCol(date, labor, dayPrices, disabled, togglePiso) {
  const eff = effectivePiso(labor, dayPrices, date);
  return {
    headerName: "P",
    headerTooltip: eff > 0 ? `Piso del día: $${eff.toLocaleString("es-CL")}` : "Sin piso configurado",
    field: `${date}__piso`,
    editable: false,
    width: 56,
    cellStyle: { textAlign: "center", padding: 0 },
    cellRenderer: (p) => {
      const checked = (Number(p.value) || 0) > 0;
      const hasWd = !!p.data?.[`${date}__piso_has_wd`];
      const canToggle = !disabled && hasWd && eff > 0;
      const title = !hasWd
        ? "Asigna primero producción este día"
        : eff === 0
          ? "Configura el piso del día o el default de la labor"
          : checked
            ? `Quitar piso ($${eff.toLocaleString("es-CL")})`
            : `Asignar piso ($${eff.toLocaleString("es-CL")})`;
      return (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (canToggle) togglePiso(labor.id, date, p.data.rut);
          }}
          disabled={!canToggle}
          title={title}
          className={`flex h-full w-full items-center justify-center text-base transition-colors ${
            checked
              ? "bg-amber-500/20 text-amber-700 hover:bg-amber-500/30 dark:text-amber-300"
              : canToggle
                ? "text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
                : "cursor-not-allowed text-[var(--color-muted)] opacity-30"
          }`}
        >
          {checked ? "🪙" : "·"}
        </button>
      );
    },
  };
}

function buildRowsCosecha(workers, days, wdMap, dayCombosByDate) {
  return workers.map((w) => {
    const row = { rut: w.rut, name: w.name, _isTemp: !!w.isTemp, _isOrphan: !!w.isOrphan };
    let total = 0;
    for (const d of days) {
      const combos = dayCombosByDate[d] || [];
      let dayTotal = 0;
      let hasProduction = false;
      for (const c of combos) {
        const wd = wdMap[workdayMapKey(w.rut, d, c.key)];
        const qty = Number(wd?.qty) || 0;
        const amt = Number(wd?.amount) || 0;
        if (wd) hasProduction = true;
        row[`${d}__${c.key}`] = qty;
        row[`${d}__${c.key}__amt`] = amt;
        dayTotal += amt;
      }
      const pisoWd = wdMap[workdayMapKey(w.rut, d, PISO_COMBO_KEY)];
      const pisoAmt = pisoWd ? Number(pisoWd.amount) || 0 : 0;
      row[`${d}__piso`] = pisoAmt;
      row[`${d}__piso_has_wd`] = hasProduction;
      dayTotal += pisoAmt;
      row[`${d}__total`] = dayTotal;
      total += dayTotal;
    }
    row.total = total;
    return row;
  });
}

function buildRowsTratoHE(workers, days, wdMap) {
  return workers.map((w) => {
    const row = { rut: w.rut, name: w.name, _isTemp: !!w.isTemp, _isOrphan: !!w.isOrphan };
    let total = 0;
    for (const d of days) {
      const wd = wdMap[workdayMapKey(w.rut, d, SINGLE_COMBO)];
      const qty = Number(wd?.qty) || 0;
      const he = Number(wd?.overtimeHours) || 0;
      const m = !!wd?.hasManejo;
      const s = !!wd?.hasSupervision;
      const x = Number(wd?.extras) || 0;
      const amt = Number(wd?.amount) || 0;
      row[`${d}__qty`] = qty;
      row[`${d}__he`] = he;
      row[`${d}__m`] = m;
      row[`${d}__s`] = s;
      row[`${d}__x`] = x;
      row[`${d}__amt`] = amt;
      total += amt;
    }
    row.total = total;
    return row;
  });
}

function buildRowsTrato(workers, days, wdMap, dayTiersByDate) {
  return workers.map((w) => {
    const row = { rut: w.rut, name: w.name, _isTemp: !!w.isTemp, _isOrphan: !!w.isOrphan };
    let total = 0;
    for (const d of days) {
      const tiers = dayTiersByDate[d] || [];
      let dayTotal = 0;
      let hasProduction = false;
      for (const t of tiers) {
        const wd = wdMap[workdayMapKey(w.rut, d, t.key)];
        const qty = Number(wd?.qty) || 0;
        const amt = Number(wd?.amount) || 0;
        if (wd) hasProduction = true;
        row[`${d}__${t.key}`] = qty;
        row[`${d}__${t.key}__amt`] = amt;
        dayTotal += amt;
      }
      const pisoWd = wdMap[workdayMapKey(w.rut, d, PISO_COMBO_KEY)];
      const pisoAmt = pisoWd ? Number(pisoWd.amount) || 0 : 0;
      row[`${d}__piso`] = pisoAmt;
      row[`${d}__piso_has_wd`] = hasProduction;
      dayTotal += pisoAmt;
      row[`${d}__total`] = dayTotal;
      total += dayTotal;
    }
    row.total = total;
    return row;
  });
}

function buildRowsNormal(workers, days, wdMap) {
  return workers.map((w) => {
    const row = { rut: w.rut, name: w.name, _isTemp: !!w.isTemp, _isOrphan: !!w.isOrphan, _monthly: !!w.monthly };
    let total = 0;
    for (const d of days) {
      const wd = wdMap[workdayMapKey(w.rut, d, SINGLE_COMBO)];
      const amount = Number(wd?.amount) || 0;
      row[d] = amount;
      // Presence flag so monthly cells can render ✓ without re-reading wdMap.
      row[`${d}__present`] = !!wd;
      total += amount;
    }
    row.total = total;
    return row;
  });
}

export default function CycleDetail() {
  const { id } = useParams();
  const { isAdmin } = useAuth();
  const { catalogs, addEntry: addCatalogEntry, renameEntry: renameCatalogEntry } = useCatalogs();

  const [cycle, setCycle] = useState(null);
  const [faena, setFaena] = useState(null);
  const [subfaena, setSubfaena] = useState(null);
  const [workdaysByLabor, setWorkdaysByLabor] = useState({});
  const [loading, setLoading] = useState(true);
  const [activeLaborId, setActiveLaborId] = useState(null);

  const [addDayOpen, setAddDayOpen] = useState(false);
  const [newDay, setNewDay] = useState(todayStr());
  const [selectedDays, setSelectedDays] = useState(() => new Set());
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  // Grid height + drag handle: handle is rendered as a full-width splitter
  // right above the grid so it is always visible. The wrapping div uses this
  // height directly.
  const { height: gridHeight, onPointerDown: onGridResizeStart, reset: resetGridHeight } =
    useResizableHeight("cycle-detail-grid", 460, 280);

  // Day notes: one annotation per day, shared across all labors of the cycle.
  // Stored at cycle.dayNotes = { "YYYY-MM-DD": "text" }. Edited via a modal
  // that opens when the user clicks the date header (DayHeader component).
  const [editingDayNote, setEditingDayNote] = useState(null); // date string or null
  const [editingDayNoteText, setEditingDayNoteText] = useState("");
  const [dayNoteBusy, setDayNoteBusy] = useState(false);

  // Modal para agregar un nuevo precio (tier) en un trato. Reemplaza al
  // prompt() nativo que rompía el estilo de la app.
  const [addPriceModal, setAddPriceModal] = useState(null);
  // shape: { laborId, date, nextKey, defaultMode, value }
  const [addPriceBusy, setAddPriceBusy] = useState(false);

  // Collapsible sections (metrics + prices). Persisted so the user only has
  // to hide them once per device. Helps reclaim vertical space for the grid.
  const [metricsCollapsed, setMetricsCollapsed] = useState(() => {
    try { return localStorage.getItem("cycleDetail.metricsCollapsed") === "true"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("cycleDetail.metricsCollapsed", String(metricsCollapsed)); } catch { /* noop */ }
  }, [metricsCollapsed]);
  const [pricesCollapsed, setPricesCollapsed] = useState(() => {
    try { return localStorage.getItem("cycleDetail.pricesCollapsed") === "true"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("cycleDetail.pricesCollapsed", String(pricesCollapsed)); } catch { /* noop */ }
  }, [pricesCollapsed]);

  const [pickerOpen, setPickerOpen] = useState(false);
  // Holds the synthetic TEMP-* rut of the worker currently being converted
  // to a real RUT. When set, opens a second picker that replaces this temp
  // entry (and rewrites all of its workday docs) with the chosen real worker.
  const [assignTempRut, setAssignTempRut] = useState(null);
  const [assignBusy, setAssignBusy] = useState(false);

  const [removeWorker, setRemoveWorker] = useState(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  // Edición rápida del trabajador desde la grilla — doble click en la
  // columna RUT abre el mismo modal del módulo de Trabajadores. No aplica
  // a temporales (no existen como doc en `worker`).
  const [editingWorkerRut, setEditingWorkerRut] = useState(null);

  const [laborForm, setLaborForm] = useState(null);
  const [removeLabor, setRemoveLabor] = useState(null);

  const [photoMode, setPhotoMode] = useState(false);
  const [copyToast, setCopyToast] = useState("");
  const [closeFlow, setCloseFlow] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [dayPrices, setDayPrices] = useState({});
  const [localPriceInputs, setLocalPriceInputs] = useState({});

  const [addComboFor, setAddComboFor] = useState(null);
  const [removeCombo, setRemoveCombo] = useState(null);
  const [catalogsOpen, setCatalogsOpen] = useState(false);
  // tratoHE-specific modals
  const [bonusEdit, setBonusEdit] = useState(null);   // { laborId, date, workerRut }
  const [dayModeEdit, setDayModeEdit] = useState(null); // { laborId, date }
  const [defaultLeadersOpen, setDefaultLeadersOpen] = useState(false);
  const [tratoHEView, setTratoHEView] = useState("detalle"); // "detalle" | "resumen"
  const [cosechaView, setCosechaView] = useState("detalle"); // "detalle" | "resumen"
  const [tratoView, setTratoView] = useState("detalle"); // "detalle" | "resumen"
  const [transportsOpen, setTransportsOpen] = useState(false);
  const [cycleTrips, setCycleTrips] = useState([]);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [groupView, setGroupView] = useState(() => {
    try { return localStorage.getItem("cycleDetail.groupView") === "group" ? "group" : "all"; }
    catch { return "all"; }
  });
  const [allWorkers, setAllWorkers] = useState([]);
  const [enabledLeaders, setEnabledLeaders] = useState([]);
  const [groupBusy, setGroupBusy] = useState(false);

  const gridRef = useRef(null);
  const photoRef = useRef(null);
  // Undo stack: each entry is a batch (array) of { rut, field, oldValue }.
  // Ctrl+Z pops one batch and replays the old values. Single edits push a
  // 1-item batch; fillDown/paste push N-item batches so they undo in one step.
  const undoStackRef = useRef([]);
  const isUndoingRef = useRef(false);
  const pendingBatchRef = useRef(null);
  const UNDO_LIMIT = 50;

  useEffect(() => {
    (async () => {
      setLoading(true);
      const c = await cyclesService.getById(id);
      if (!c) { setLoading(false); return; }
      const normalized = normalizeCycle(c);
      const needsPersist =
        !c.labors || !c.labors.length || !Array.isArray(c.days) || (c.labors || []).some((l) => Array.isArray(l.days));
      if (needsPersist) {
        await cyclesService.update(id, { days: normalized.days, labors: normalized.labors });
      }
      setCycle(normalized);
      setActiveLaborId(normalized.labors[0]?.id || null);

      const rawDP = c.dayPrices || {};
      const normalizedDP = {};
      let dpChanged = false;
      for (const lid of Object.keys(rawDP)) {
        normalizedDP[lid] = {};
        const labor = (c.labors || []).find((l) => l.id === lid);
        const laborDefaultMode = labor?.tratoMode || "unit";
        for (const date of Object.keys(rawDP[lid])) {
          const before = rawDP[lid][date];
          const isTratoType = labor?.type === "trato";
          const after = isTratoType
            ? normalizeTratoDayPrices(before, laborDefaultMode)
            : normalizeDayPricesEntry(before);
          normalizedDP[lid][date] = after;
          if (JSON.stringify(before) !== JSON.stringify(after)) dpChanged = true;
        }
      }
      setDayPrices(normalizedDP);
      if (dpChanged) await cyclesService.update(id, { dayPrices: normalizedDP });

      if (normalized.faenaId) setFaena(await faenasService.getById(normalized.faenaId));
      if (normalized.subfaenaId) setSubfaena(await subfaenasService.getById(normalized.subfaenaId));

      const wds = await workdaysService.list({ wheres: [["cycleId", "==", id]] });
      const byLabor = {};
      const labors = normalized.labors || [];
      for (const w of wds) {
        const lid = w.laborId || labors[0]?.id;
        // Derive the combo/tier key (ck) for the in-memory map. The docId
        // encodes it as the optional 5th segment ("...__rut__date__ck"); when
        // absent the doc was written with the implicit "0_0". Trato docs need
        // their tier key (e.g. "t0", "t1") because the row builder looks them
        // up that way — using qualityX/Y here yields "0_0" and silently hides
        // every value in the grid. Legacy trato docs (no __tN suffix) are
        // treated as tier 0.
        const parts = String(w.id || "").split("__");
        const laborForDoc = labors.find((l) => l.id === lid);
        const isTrato = laborForDoc?.type === "trato";
        let ck;
        if (parts.length >= 5) {
          ck = parts.slice(4).join("__");
        } else if (isTrato) {
          ck = "t0";
        } else {
          const x = Number(w.qualityX) || 0;
          const y = Number(w.containerY) || 0;
          ck = makeComboKey(x, y);
        }
        if (!byLabor[lid]) byLabor[lid] = {};
        // Piso workdays no se normalizan como trato (no tienen tiers reales).
        const normalizedWd = w.pisoOnly || ck === PISO_COMBO_KEY ? w : normalizeTratoWorkday(w);
        byLabor[lid][workdayMapKey(w.workerRut, w.date, ck)] = normalizedWd;
      }
      setWorkdaysByLabor(byLabor);
      setLoading(false);
    })();
  }, [id]);

  const closed = cycle?.status === "closed";
  const readOnly = closed && !isAdmin;

  const loadAllWorkers = async () => {
    const list = await workersService.list({
      order: ["name", "asc"],
      cache: true,
      persist: true,
      ttl: 24 * 60 * 60 * 1000,
    });
    setAllWorkers(list);
  };

  const loadEnabledLeaders = async () => {
    const list = await groupLeadersService.list({
      cache: true,
      persist: true,
      ttl: 24 * 60 * 60 * 1000,
    });
    const names = list
      .filter((d) => d.habilitado === true)
      .map((d) => String(d.name || d.nombre || d.id || "").trim().toUpperCase())
      .filter(Boolean);
    const dedup = [...new Set(names)].sort();
    setEnabledLeaders(dedup);
  };

  useEffect(() => {
    loadAllWorkers();
    loadEnabledLeaders();
  }, []);

  useEffect(() => {
    try { localStorage.setItem("cycleDetail.groupView", groupView); } catch { /* ignore */ }
  }, [groupView]);

  const rutToLeader = useMemo(() => {
    const m = new Map();
    for (const w of allWorkers) {
      const l = String(w.groupLeader?.[0] || "").trim().toUpperCase();
      if (l) m.set(w.id, l);
    }
    // Temp workers live only inside labor.workers; their leader (if any) is
    // stored as a plain string field on that entry rather than the array form
    // used on the canonical worker doc. We walk every labor so the map is
    // valid even if the active labor changes later.
    for (const labor of cycle?.labors || []) {
      for (const w of labor.workers || []) {
        if (!w?.isTemp) continue;
        const l = String(w.groupLeader || "").trim().toUpperCase();
        if (l) m.set(w.rut, l);
      }
    }
    return m;
  }, [allWorkers, cycle]);

  // Lookup table for the current canonical name of each worker. Used at row
  // build time so name edits in the Workers screen propagate to open cycles
  // without rewriting the (denormalized) `labor.workers[i].name` snapshot.
  const rutToName = useMemo(() => {
    const m = new Map();
    for (const w of allWorkers) {
      if (w?.name) m.set(w.id, w.name);
    }
    return m;
  }, [allWorkers]);

  const LEADER_LOCAL = "CHILENOS";
  const LEADER_FOREIGN = "EXTRANJEROS";
  const LEADER_NONE = "__NONE__";

  const orderLeaders = (leaders) => {
    const arr = [...leaders];
    return arr.sort((a, b) => {
      if (a === b) return 0;
      if (a === LEADER_LOCAL) return -1;
      if (b === LEADER_LOCAL) return 1;
      if (a === LEADER_FOREIGN) return -1;
      if (b === LEADER_FOREIGN) return 1;
      if (a === LEADER_NONE) return 1;
      if (b === LEADER_NONE) return -1;
      return a.localeCompare(b);
    });
  };

  const activeLabor = useMemo(
    () => cycle?.labors?.find((l) => l.id === activeLaborId) || cycle?.labors?.[0] || null,
    [cycle, activeLaborId],
  );

  const isCosechaLabor = activeLabor?.type === "cosecha";
  const isTratoLabor = activeLabor?.type === "trato";
  const isTratoHELabor = activeLabor?.type === "tratoHE";
  const isQtyLabor = isCosechaLabor || isTratoLabor || isTratoHELabor;
  const days = cycle?.days || [];
  const workers = activeLabor?.workers || [];
  const wdMap = (activeLabor && workdaysByLabor[activeLabor.id]) || {};
  const defaultMode = activeLabor?.cosechaMode || activeLabor?.tratoMode || "unit";

  // Días de la labor activa que muestran la columna "P" en la grilla. Para
  // no agregar ruido, la columna solo aparece en días que ya tienen piso
  // configurado en `dayPrices` o que tienen al menos un workday pisoOnly
  // asignado a algún trabajador.
  const daysWithPiso = useMemo(() => {
    if (!activeLabor || (!isCosechaLabor && !isTratoLabor)) return new Set();
    const s = new Set();
    const dp = dayPrices[activeLabor.id] || {};
    for (const d in dp) {
      if ((Number(dp[d]?.piso) || 0) > 0) s.add(d);
    }
    for (const k in wdMap) {
      const wd = wdMap[k];
      if (wd?.pisoOnly && wd.date) s.add(wd.date);
    }
    return s;
  }, [activeLabor, isCosechaLabor, isTratoLabor, dayPrices, wdMap]);

  const dayCombosByDate = useMemo(() => {
    if (!isCosechaLabor || !activeLabor) return {};
    const wdMapForLabor = workdaysByLabor[activeLabor.id] || {};
    const out = {};
    for (const d of days) {
      const fromPrices = getDayCombos(dayPrices, activeLabor.id, d, defaultMode);
      const seen = new Set(fromPrices.map((c) => c.key));
      const result = [...fromPrices];
      for (const k in wdMapForLabor) {
        if (!k.includes(`__${d}__`)) continue;
        const wd = wdMapForLabor[k];
        const x = Number(wd.qualityX) || 0;
        const y = Number(wd.containerY) || 0;
        const ck = makeComboKey(x, y);
        if (!seen.has(ck) && (Number(wd.qty) || 0) > 0) {
          result.push({ key: ck, x, y, price: 0, mode: defaultMode });
          seen.add(ck);
        }
      }
      result.sort((a, b) => a.x - b.x || a.y - b.y);
      out[d] = result;
    }
    return out;
  }, [isCosechaLabor, activeLabor, days, dayPrices, defaultMode, workdaysByLabor]);

  const dayTiersByDate = useMemo(() => {
    if (!isTratoLabor || !activeLabor) return {};
    const wdMapForLabor = workdaysByLabor[activeLabor.id] || {};
    const out = {};
    for (const d of days) {
      const fromPrices = getTratoTiers(dayPrices, activeLabor.id, d, defaultMode);
      const seen = new Set(fromPrices.map((t) => t.key));
      const result = [...fromPrices];
      for (const k in wdMapForLabor) {
        if (!k.includes(`__${d}__`)) continue;
        const wd = wdMapForLabor[k];
        if (!wd?.tiers) continue;
        for (const tk of Object.keys(wd.tiers)) {
          const tierKey = `t${tk}`;
          if (!seen.has(tierKey) && Number(wd.tiers[tk]?.qty) > 0) {
            const existing = dayPrices?.[activeLabor.id]?.[d]?.[tierKey] || {};
            result.push({ key: tierKey, index: Number(tk), price: Number(existing.price) || 0, mode: existing.mode || defaultMode });
            seen.add(tierKey);
          }
        }
      }
      result.sort((a, b) => a.index - b.index);
      out[d] = result;
    }
    return out;
  }, [isTratoLabor, activeLabor, days, dayPrices, defaultMode, workdaysByLabor]);

  const dayNotes = cycle?.dayNotes || {};

  const openDayNote = (date) => {
    setEditingDayNote(date);
    setEditingDayNoteText(String(dayNotes?.[date] || ""));
  };

  const closeDayNote = () => {
    if (dayNoteBusy) return;
    setEditingDayNote(null);
    setEditingDayNoteText("");
  };

  const saveDayNote = async () => {
    if (!editingDayNote) return;
    setDayNoteBusy(true);
    try {
      const text = String(editingDayNoteText || "").trim();
      const nextNotes = { ...(cycle?.dayNotes || {}) };
      if (text) nextNotes[editingDayNote] = text;
      else delete nextNotes[editingDayNote];
      await cyclesService.update(id, { dayNotes: nextNotes });
      setCycle((c) => (c ? { ...c, dayNotes: nextNotes } : c));
      setEditingDayNote(null);
      setEditingDayNoteText("");
    } finally {
      setDayNoteBusy(false);
    }
  };

  // Resolve each worker's current canonical name from the workers cache.
  // Falls back to the snapshot stored in labor.workers (used for temp workers
  // and as a safety net while the cache loads).
  const resolvedWorkers = useMemo(
    () => workers.map((w) => (w?.isTemp ? w : { ...w, name: rutToName.get(w.rut) || w.name })),
    [workers, rutToName],
  );

  // Trabajadores que tienen workdays en esta labor pero ya no están en
  // labor.workers (típicamente porque alguien los quitó del listado sin
  // limpiar la producción). Los inyectamos al grid con flag `isOrphan`
  // para que el usuario los vea y pueda quitarlos. Sin esto, las métricas
  // y el payroll los siguen contando pero no aparecen en el grid.
  const orphanWorkers = useMemo(() => {
    if (!activeLabor) return [];
    const inLabor = new Set((workers || []).map((w) => w.rut));
    const seen = new Set();
    const out = [];
    for (const k in wdMap) {
      const wd = wdMap[k];
      const rut = wd?.workerRut;
      if (!rut || inLabor.has(rut) || seen.has(rut)) continue;
      seen.add(rut);
      out.push({
        rut,
        name: rutToName.get(rut) || rut,
        isOrphan: true,
      });
    }
    return out;
  }, [activeLabor, workers, wdMap, rutToName]);

  const gridWorkers = useMemo(
    () => [...resolvedWorkers, ...orphanWorkers],
    [resolvedWorkers, orphanWorkers],
  );

  const rowDataRaw = useMemo(() => {
    if (isCosechaLabor) return buildRowsCosecha(gridWorkers, days, wdMap, dayCombosByDate);
    if (isTratoLabor) return buildRowsTrato(gridWorkers, days, wdMap, dayTiersByDate);
    if (isTratoHELabor) return buildRowsTratoHE(gridWorkers, days, wdMap);
    return buildRowsNormal(gridWorkers, days, wdMap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridWorkers, days, wdMap, isCosechaLabor, isTratoLabor, isTratoHELabor, dayCombosByDate, dayTiersByDate]);

  const groupBuckets = useMemo(() => {
    const buckets = new Map();
    for (const row of rowDataRaw) {
      const leader = rutToLeader.get(row.rut) || LEADER_NONE;
      if (!buckets.has(leader)) buckets.set(leader, []);
      buckets.get(leader).push(row);
    }
    for (const [, rows] of buckets) rows.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    return buckets;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowDataRaw, rutToLeader]);

  const orderedGroups = useMemo(() => {
    const keys = orderLeaders([...groupBuckets.keys()]);
    return keys.map((k) => ({
      key: k,
      label: k === LEADER_NONE ? "SIN GRUPO" : k,
      count: groupBuckets.get(k)?.length || 0,
      rows: groupBuckets.get(k) || [],
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupBuckets]);

  const useGrouped = groupView === "group" && !photoMode;

  const rowData = useMemo(() => {
    if (!useGrouped) return rowDataRaw;
    const out = [];
    for (const g of orderedGroups) {
      out.push({
        rut: `__group__${g.key}`,
        _isHeader: true,
        _leader: g.label,
        _leaderKey: g.key,
        _count: g.count,
      });
      for (const r of g.rows) out.push(r);
    }
    return out;
  }, [useGrouped, rowDataRaw, orderedGroups]);

  const scrollToGroup = (key) => {
    const api = gridRef.current?.api;
    if (!api) return;
    const node = api.getRowNode(`__group__${key}`);
    if (node) api.ensureNodeVisible(node, "top");
  };

  const assignLeaderToWorker = async (rut, leader) => {
    const w = allWorkers.find((x) => x.id === rut);
    const prev = Array.isArray(w?.groupLeader) ? w.groupLeader : [];
    const next = [leader, ...prev.filter((p) => String(p).toUpperCase() !== leader)];
    setGroupBusy(true);
    try {
      await workersService.update(rut, { groupLeader: next });
      await loadAllWorkers();
    } finally {
      setGroupBusy(false);
    }
  };

  const [leaderPickerFor, setLeaderPickerFor] = useState(null); // rut | null

  const totalsByLabor = useMemo(() => {
    const out = {};
    if (!cycle?.labors) return out;
    for (const l of cycle.labors) {
      const m = workdaysByLabor[l.id] || {};
      let sum = 0;
      for (const k in m) {
        const wd = m[k];
        sum += l.type === "trato" ? getTratoTierTotals(wd).amount : (Number(wd.amount) || 0);
      }
      out[l.id] = sum;
    }
    return out;
  }, [cycle?.labors, workdaysByLabor]);

  const totalQtyByContainerByLabor = useMemo(() => {
    const out = {};
    if (!cycle?.labors) return out;
    for (const l of cycle.labors) {
      if (l.type !== "cosecha") continue;
      const m = workdaysByLabor[l.id] || {};
      const byContainer = {};
      for (const k in m) {
        const wd = m[k];
        const y = Number(wd.containerY) || 0;
        const qty = Number(wd.qty) || 0;
        byContainer[y] = (byContainer[y] || 0) + qty;
      }
      out[l.id] = byContainer;
    }
    return out;
  }, [cycle?.labors, workdaysByLabor]);

  const totalQtyByLabor = useMemo(() => {
    const out = {};
    if (!cycle?.labors) return out;
    for (const l of cycle.labors) {
      if (l.type !== "trato") continue;
      const m = workdaysByLabor[l.id] || {};
      let sum = 0;
      for (const k in m) sum += getTratoTierTotals(m[k]).qty;
      out[l.id] = sum;
    }
    return out;
  }, [cycle?.labors, workdaysByLabor]);

  // Pisos por labor: cuenta y suma total de los workdays pisoOnly. Solo
  // aplica a trato/cosecha; el resto siempre será 0.
  const pisoMetricsByLabor = useMemo(() => {
    const out = {};
    if (!cycle?.labors) return out;
    for (const l of cycle.labors) {
      const m = workdaysByLabor[l.id] || {};
      let count = 0;
      let amount = 0;
      for (const k in m) {
        const wd = m[k];
        if (!wd?.pisoOnly) continue;
        count += 1;
        amount += Number(wd.amount) || 0;
      }
      out[l.id] = { count, amount };
    }
    return out;
  }, [cycle?.labors, workdaysByLabor]);

  // tratoHE: jornadas (qty) y horas extras separadas por feriado/normal
  const tratoHEMetricsByLabor = useMemo(() => {
    const out = {};
    if (!cycle?.labors) return out;
    for (const l of cycle.labors) {
      if (l.type !== "tratoHE") continue;
      const m = workdaysByLabor[l.id] || {};
      let normalQty = 0, holidayQty = 0;
      let normalHE = 0, holidayHE = 0;
      let workersWithBonus = 0;
      const seenWorkers = new Set();
      for (const k in m) {
        const wd = m[k];
        const cfg = getDaySingle(dayPrices, l.id, wd.date, "normal");
        const red = isRedDay(wd.date, cfg);
        const qty = Number(wd.qty) || 0;
        const he = Number(wd.overtimeHours) || 0;
        if (red) { holidayQty += qty; holidayHE += he; }
        else { normalQty += qty; normalHE += he; }
        if ((wd.hasManejo || wd.hasSupervision) && !seenWorkers.has(wd.workerRut)) {
          seenWorkers.add(wd.workerRut);
          workersWithBonus++;
        }
      }
      out[l.id] = { normalQty, holidayQty, normalHE, holidayHE, workersWithBonus };
    }
    return out;
  }, [cycle?.labors, workdaysByLabor, dayPrices]);

  const totalQtyByDayCombo = useMemo(() => {
    if (!isCosechaLabor || !activeLabor) return {};
    const m = workdaysByLabor[activeLabor.id] || {};
    const out = {};
    for (const d of days) {
      out[d] = {};
      const combos = dayCombosByDate[d] || [];
      for (const c of combos) {
        let sum = 0;
        for (const w of workers) {
          sum += Number(m[workdayMapKey(w.rut, d, c.key)]?.qty) || 0;
        }
        out[d][c.key] = sum;
      }
    }
    return out;
  }, [isCosechaLabor, activeLabor, workdaysByLabor, days, workers, dayCombosByDate]);

  // Per-tier metrics for trato labors
  const tratoTierMetricsByLabor = useMemo(() => {
    const out = {};
    if (!cycle?.labors) return out;
    for (const l of cycle.labors) {
      if (l.type !== "trato") continue;
      const m = workdaysByLabor[l.id] || {};
      const tiers = {};
      for (const k in m) {
        const wd = m[k];
        if (!wd?.tiers) continue;
        for (const [tk, tv] of Object.entries(wd.tiers)) {
          const idx = Number(tk);
          if (!tiers[idx]) tiers[idx] = { qty: 0, amount: 0, workerCount: new Set() };
          tiers[idx].qty += Number(tv?.qty) || 0;
          tiers[idx].amount += Number(tv?.amount) || 0;
          tiers[idx].workerCount.add(wd.workerRut);
        }
      }
      // Convert Sets to counts for serialization
      for (const idx of Object.keys(tiers)) tiers[idx].workerCount = tiers[idx].workerCount.size;
      out[l.id] = tiers;
    }
    return out;
  }, [cycle?.labors, workdaysByLabor]);

  const transportTotal = useMemo(
    () => cycleTrips.reduce((s, t) => s + (Number(t.amount) || 0), 0),
    [cycleTrips],
  );

  const grandTotal = useMemo(
    () => Object.values(totalsByLabor).reduce((a, b) => a + b, 0) + transportTotal,
    [totalsByLabor, transportTotal],
  );

  const reloadTransports = async () => {
    if (!id) return;
    try {
      const list = await tripsService.listByCycle(id);
      setCycleTrips(list);
    } catch (err) {
      console.error("[Transports] load failed:", err);
    }
  };

  useEffect(() => {
    reloadTransports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const persistDays = async (nextDays) => {
    await cyclesService.update(id, { days: nextDays });
    setCycle((c) => ({ ...c, days: nextDays }));
  };

  const persistLabor = async (next) => {
    const nextLabors = cycle.labors.map((l) => (l.id === next.id ? next : l));
    await cyclesService.update(id, { labors: nextLabors });
    setCycle((c) => ({ ...c, labors: nextLabors }));
  };

  // ============================================================
  // Combo / single-price helpers
  // ============================================================

  const getCombo = (laborId, date, ck) => {
    const combos = laborId === activeLabor?.id && isCosechaLabor
      ? (dayCombosByDate[date] || [])
      : getDayCombos(dayPrices, laborId, date, defaultMode);
    return combos.find((c) => c.key === ck) || { key: ck, x: 0, y: 0, price: 0, mode: defaultMode };
  };

  const recalcDayCombo = async (laborId, date, ck, price, mode, isTrato) => {
    const labor = cycle.labors.find((l) => l.id === laborId);
    if (!labor || (labor.type !== "cosecha" && labor.type !== "trato")) return;
    const wdMapForLabor = workdaysByLabor[laborId] || {};
    const { x, y } = parseComboKey(ck);
    const updates = {};
    for (const w of labor.workers) {
      const mapKey = workdayMapKey(w.rut, date, ck);
      const wd = wdMapForLabor[mapKey];
      if (!wd) continue;
      const qty = Number(wd.qty) || 0;
      if (qty === 0) continue;
      const amount = mode === "flat" ? price : qty * price;
      const docId = workdayDocId(id, laborId, w.rut, date, ck);
      const patch = isTrato
        ? { ...wd, amount }
        : { ...wd, qualityX: x, containerY: y, amount };
      await workdaysService.upsert(docId, patch);
      updates[mapKey] = patch;
    }
    if (Object.keys(updates).length > 0) {
      setWorkdaysByLabor((prev) => ({
        ...prev,
        [laborId]: { ...(prev[laborId] || {}), ...updates },
      }));
    }
  };

  const persistComboConfig = async (laborId, date, ck, patch, isTrato = false) => {
    const dayEntry = normalizeDayPricesEntry(dayPrices[laborId]?.[date]);
    const current = dayEntry[ck] || { price: 0, mode: defaultMode };
    const merged = { ...current, ...patch };
    const nextDay = { ...dayEntry, [ck]: merged };
    const next = { ...dayPrices, [laborId]: { ...(dayPrices[laborId] || {}), [date]: nextDay } };
    setDayPrices(next);
    await cyclesService.update(id, { dayPrices: next });
    await recalcDayCombo(laborId, date, ck, merged.price, merged.mode, isTrato);
  };

  // Piso = monto fijo configurable por día (con fallback al pisoDefault de la
  // labor). Conviven en el mismo doc `dayPrices[labId][date]` como campo
  // `piso` al lado de los combos/tiers.
  const persistDayPiso = async (laborId, date, value) => {
    const dayEntry = normalizeDayPricesEntry(dayPrices[laborId]?.[date]);
    const nextDay = { ...dayEntry, piso: Number(value) || 0 };
    if (!nextDay.piso) delete nextDay.piso;
    const next = { ...dayPrices, [laborId]: { ...(dayPrices[laborId] || {}), [date]: nextDay } };
    setDayPrices(next);
    await cyclesService.update(id, { dayPrices: next });
  };

  // Toggle del piso por (worker, date) para la labor activa. Crea/borra un
  // workday separado con `comboKey: "_piso"` y `pisoOnly: true`. El monto
  // viene del piso efectivo (día > labor.pisoDefault). Requiere que ya
  // exista al menos un workday de producción para esa fecha.
  const togglePiso = async (laborId, date, workerRut) => {
    const labor = cycle.labors.find((l) => l.id === laborId);
    if (!labor) return;
    const mapKey = workdayMapKey(workerRut, date, PISO_COMBO_KEY);
    const docId = workdayDocId(id, laborId, workerRut, date, PISO_COMBO_KEY);
    const existing = (workdaysByLabor[laborId] || {})[mapKey];
    if (existing) {
      await workdaysService.remove(docId);
      setWorkdaysByLabor((prev) => {
        const lab = { ...(prev[laborId] || {}) };
        delete lab[mapKey];
        return { ...prev, [laborId]: lab };
      });
      return;
    }
    const amount = effectivePiso(labor, dayPrices, date);
    if (!amount) {
      alert("Configura primero el piso por día o el piso default en la labor.");
      return;
    }
    const next = {
      cycleId: id, laborId, workerRut, date,
      qty: 0, amount,
      pisoOnly: true,
    };
    await workdaysService.upsert(docId, next);
    setWorkdaysByLabor((prev) => {
      const lab = { ...(prev[laborId] || {}) };
      lab[mapKey] = { id: docId, ...next };
      return { ...prev, [laborId]: lab };
    });
  };

  const addComboToDay = async (laborId, date, x, y) => {
    const ck = makeComboKey(x, y);
    const dayEntry = normalizeDayPricesEntry(dayPrices[laborId]?.[date]);
    if (dayEntry[ck]) return;
    const nextDay = { ...dayEntry, [ck]: { price: 0, mode: defaultMode } };
    const next = { ...dayPrices, [laborId]: { ...(dayPrices[laborId] || {}), [date]: nextDay } };
    setDayPrices(next);
    await cyclesService.update(id, { dayPrices: next });
  };

  // ============================================================
  // tratoHE-specific helpers
  // ============================================================

  const tratoHERates = (labor) => ({
    bonusManejo: labor?.bonusManejo ?? DEFAULT_BONUS_MANEJO,
    bonusSupervision: labor?.bonusSupervision ?? DEFAULT_BONUS_SUPERVISION,
    overtimeRate: labor?.overtimeRate ?? DEFAULT_OVERTIME_RATE,
    baseDayDefault: labor?.baseDayDefault ?? DEFAULT_BASE_DAY,
  });

  const effectiveDayPrice = (labor, dayCfg) =>
    Number(dayCfg?.price) || Number(labor?.baseDayDefault) || DEFAULT_BASE_DAY;

  const computeTratoHEAmount = (labor, dayCfg, wd) =>
    calcTratoHEAmount({
      qty: wd.qty,
      overtimeHours: wd.overtimeHours,
      hasManejo: wd.hasManejo,
      hasSupervision: wd.hasSupervision,
      extras: wd.extras,
      dayPrice: effectiveDayPrice(labor, dayCfg),
      dayMode: dayCfg?.mode || "normal",
      ...tratoHERates(labor),
    });

  const upsertTratoHEWorkday = async (laborId, date, workerRut, patch) => {
    const labor = cycle.labors.find((l) => l.id === laborId);
    if (!labor) return { amount: 0 };
    const mapKey = workdayMapKey(workerRut, date, SINGLE_COMBO);
    const docId = workdayDocId(id, laborId, workerRut, date, SINGLE_COMBO);
    const existing = (workdaysByLabor[laborId] || {})[mapKey];
    const defaults = labor.bonusDefaults?.[workerRut] || {};
    const seed = existing
      ? { ...existing }
      : { qty: 0, overtimeHours: 0, extras: 0, hasManejo: !!defaults.manejo, hasSupervision: !!defaults.supervision };
    const merged = { ...seed, ...patch };
    const dayCfg = getDaySingle(dayPrices, laborId, date, "normal");
    const amount = computeTratoHEAmount(labor, dayCfg, merged);
    const wd = { cycleId: id, laborId, workerRut, date, ...merged, amount };

    if (!workdayHasData(wd)) {
      if (existing) {
        await workdaysService.remove(docId);
        setWorkdaysByLabor((prev) => {
          const lab = { ...(prev[laborId] || {}) };
          delete lab[mapKey];
          return { ...prev, [laborId]: lab };
        });
      }
      return { amount: 0 };
    }
    await workdaysService.upsert(docId, wd);
    setWorkdaysByLabor((prev) => {
      const lab = { ...(prev[laborId] || {}) };
      lab[mapKey] = wd;
      return { ...prev, [laborId]: lab };
    });
    return { amount };
  };

  const recalcDayTratoHE = async (laborId, date) => {
    const labor = cycle.labors.find((l) => l.id === laborId);
    if (!labor || labor.type !== "tratoHE") return;
    const dayCfg = getDaySingle(dayPrices, laborId, date, "normal");
    const wdMapForLabor = workdaysByLabor[laborId] || {};
    const updates = {};
    for (const w of labor.workers) {
      const mapKey = workdayMapKey(w.rut, date, SINGLE_COMBO);
      const wd = wdMapForLabor[mapKey];
      if (!wd) continue;
      const amount = computeTratoHEAmount(labor, dayCfg, wd);
      if (amount === wd.amount) continue;
      const docId = workdayDocId(id, laborId, w.rut, date, SINGLE_COMBO);
      const next = { ...wd, amount };
      await workdaysService.upsert(docId, next);
      updates[mapKey] = next;
    }
    if (Object.keys(updates).length > 0) {
      setWorkdaysByLabor((prev) => ({
        ...prev,
        [laborId]: { ...(prev[laborId] || {}), ...updates },
      }));
    }
  };

  const recalcAllTratoHE = async (laborId) => {
    const labor = cycle.labors.find((l) => l.id === laborId);
    if (!labor || labor.type !== "tratoHE") return;
    const wdMapForLabor = workdaysByLabor[laborId] || {};
    const updates = {};
    for (const k in wdMapForLabor) {
      const wd = wdMapForLabor[k];
      const dayCfg = getDaySingle(dayPrices, laborId, wd.date, "normal");
      const amount = computeTratoHEAmount(labor, dayCfg, wd);
      if (amount === wd.amount) continue;
      const docId = workdayDocId(id, laborId, wd.workerRut, wd.date, SINGLE_COMBO);
      const next = { ...wd, amount };
      await workdaysService.upsert(docId, next);
      updates[k] = next;
    }
    if (Object.keys(updates).length > 0) {
      setWorkdaysByLabor((prev) => ({
        ...prev,
        [laborId]: { ...(prev[laborId] || {}), ...updates },
      }));
    }
  };

  const persistTratoHEDay = async (laborId, date, patch) => {
    const dayEntry = normalizeDayPricesEntry(dayPrices[laborId]?.[date]);
    const current = dayEntry["0_0"] || {
      price: cycle.labors.find((l) => l.id === laborId)?.baseDayDefault ?? DEFAULT_BASE_DAY,
      mode: "normal",
      isHoliday: false,
    };
    const merged = { ...current, ...patch };
    const nextDay = { ...dayEntry, "0_0": merged };
    const next = { ...dayPrices, [laborId]: { ...(dayPrices[laborId] || {}), [date]: nextDay } };
    setDayPrices(next);
    await cyclesService.update(id, { dayPrices: next });
    await recalcDayTratoHE(laborId, date);
  };

  const persistTratoHEBonusDefaults = async (laborId, defaults) => {
    const nextLabors = cycle.labors.map((l) =>
      l.id === laborId ? { ...l, bonusDefaults: defaults } : l,
    );
    await cyclesService.update(id, { labors: nextLabors });
    setCycle((c) => ({ ...c, labors: nextLabors }));
  };

  const removeComboFromDay = async (laborId, date, ck) => {
    const wdMapForLabor = workdaysByLabor[laborId] || {};
    for (const k in wdMapForLabor) {
      if (k.endsWith(`__${ck}`) && k.includes(`__${date}__`)) {
        if (Number(wdMapForLabor[k].qty) > 0) {
          alert("No se puede quitar: hay producción registrada en este combo.");
          return false;
        }
      }
    }
    const dayEntry = normalizeDayPricesEntry(dayPrices[laborId]?.[date]);
    delete dayEntry[ck];
    const next = { ...dayPrices, [laborId]: { ...(dayPrices[laborId] || {}), [date]: dayEntry } };
    setDayPrices(next);
    await cyclesService.update(id, { dayPrices: next });
    return true;
  };

  const inputKey = (laborId, date, ck) => `${laborId}__${date}__${ck}`;

  const handlePriceBlur = (laborId, date, ck, isTrato = false) => {
    const k = inputKey(laborId, date, ck);
    const raw = localPriceInputs[k];
    if (raw === undefined) return;
    const price = parseAmount(String(raw)) || 0;
    setLocalPriceInputs((prev) => { const n = { ...prev }; delete n[k]; return n; });
    // For tier keys (t0, t1, etc.) route through persistComboConfig so existing wds get recalculated
    if (isTrato && typeof ck === "string" && ck.startsWith("t")) {
      const entry = dayPrices?.[laborId]?.[date];
      const cur = entry?.[ck];
      if (!cur || price !== Number(cur.price)) {
        persistComboConfig(laborId, date, ck, { price }, true);
      }
      return;
    }
    const cur = isTrato
      ? getDaySingle(dayPrices, laborId, date, defaultMode)
      : getCombo(laborId, date, ck);
    if (price !== cur.price) {
      persistComboConfig(laborId, date, ck, { price }, isTrato);
    }
  };

  const getPriceInputValue = (laborId, date, ck, isTrato = false) => {
    const k = inputKey(laborId, date, ck);
    if (k in localPriceInputs) return localPriceInputs[k];
    // For tier keys (t0, t1, etc.)
    if (isTrato && typeof ck === "string" && ck.startsWith("t")) {
      const entry = dayPrices?.[laborId]?.[date];
      const tier = entry?.[ck];
      return tier?.price || "";
    }
    const cur = isTrato
      ? getDaySingle(dayPrices, laborId, date, defaultMode)
      : getCombo(laborId, date, ck);
    return cur.price || "";
  };

  // ============================================================
  // Cell value changed
  // ============================================================

  // Field is one of the per-day editable fields (cosecha combo, trato tier,
  // tratoHE qty/he, normal). All other fields (rut/name/total/__amt/__total)
  // are derived and shouldn't be batch-written.
  const isEditableField = (field) => {
    if (!field) return false;
    if (["rut", "name", "total"].includes(field)) return false;
    if (field.endsWith("__amt") || field.endsWith("__total")) return false;
    return true;
  };

  const dispatchCellChange = async (node, colDef, newValue) => {
    if (!node || !colDef) return;
    if (!isEditableField(colDef.field)) return;
    const oldValue = node.data?.[colDef.field];
    await onCellValueChanged({
      colDef,
      data: node.data,
      newValue,
      oldValue,
      node,
    });
  };

  // Ctrl+D fill down: take the focused cell's value, write it to the same
  // column on every selected row. Use Shift+Click on the row checkboxes to
  // pick the destination range first.
  const fillDown = async (params) => {
    if (readOnly || photoMode) return;
    const api = gridRef.current?.api;
    if (!api) return;
    const colDef = params.colDef;
    if (!isEditableField(colDef?.field)) return;
    const sourceValue = params.data?.[colDef.field];
    if (sourceValue == null || sourceValue === "" || sourceValue === 0) {
      setCopyToast("Celda fuente vacía");
      setTimeout(() => setCopyToast(""), 1500);
      return;
    }
    const selected = api.getSelectedNodes();
    if (selected.length === 0) {
      setCopyToast("Selecciona filas con Shift+Click primero");
      setTimeout(() => setCopyToast(""), 2200);
      return;
    }
    pendingBatchRef.current = [];
    let count = 0;
    for (const node of selected) {
      if (node.id === params.node?.id) continue;
      await dispatchCellChange(node, colDef, sourceValue);
      count++;
    }
    if (pendingBatchRef.current.length) {
      undoStackRef.current.push(pendingBatchRef.current);
      if (undoStackRef.current.length > UNDO_LIMIT) undoStackRef.current.shift();
    }
    pendingBatchRef.current = null;
    setCopyToast(`✓ Copiado a ${count} fila(s)`);
    setTimeout(() => setCopyToast(""), 1500);
  };

  // Ctrl+V paste: split the clipboard by lines and apply each value to the
  // displayed row at sourceIndex+i in the same column. Tabs (multi-column
  // copies from Excel) are not yet supported — only the first column is used.
  const pasteFromClipboard = async (params) => {
    if (readOnly || photoMode) return;
    const api = gridRef.current?.api;
    if (!api) return;
    const colDef = params.colDef;
    if (!isEditableField(colDef?.field)) return;
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setCopyToast("No pude leer el portapapeles");
      setTimeout(() => setCopyToast(""), 2000);
      return;
    }
    if (!text) return;
    const lines = text.replace(/\r/g, "").split("\n").map((l) => l.split("\t")[0]);
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length === 0) return;
    const startIdx = params.node?.rowIndex;
    if (startIdx == null) return;
    pendingBatchRef.current = [];
    let count = 0;
    let lineIdx = 0;
    let targetIdx = startIdx;
    while (lineIdx < lines.length) {
      const node = api.getDisplayedRowAtIndex(targetIdx);
      if (!node) break;
      if (node.data?._isHeader) {
        targetIdx++;
        continue;
      }
      await dispatchCellChange(node, colDef, lines[lineIdx]);
      lineIdx++;
      targetIdx++;
      count++;
    }
    if (pendingBatchRef.current.length) {
      undoStackRef.current.push(pendingBatchRef.current);
      if (undoStackRef.current.length > UNDO_LIMIT) undoStackRef.current.shift();
    }
    pendingBatchRef.current = null;
    setCopyToast(`✓ Pegadas ${count} celda(s)`);
    setTimeout(() => setCopyToast(""), 1500);
  };

  // Ctrl+Z undo: pop the most recent batch off the stack and replay each
  // entry's old value. While replaying we set isUndoingRef so onCellValueChanged
  // does not push the revert itself onto the stack.
  const undoLast = async () => {
    if (readOnly || photoMode) return;
    const batch = undoStackRef.current.pop();
    if (!batch || batch.length === 0) {
      setCopyToast("Nada que deshacer");
      setTimeout(() => setCopyToast(""), 1500);
      return;
    }
    const api = gridRef.current?.api;
    if (!api) return;
    isUndoingRef.current = true;
    try {
      for (let i = batch.length - 1; i >= 0; i--) {
        const { rut, field, oldValue } = batch[i];
        let target = null;
        api.forEachNode((n) => { if (n.data?.rut === rut) target = n; });
        if (!target) continue;
        await dispatchCellChange(target, { field }, oldValue);
      }
      setCopyToast(`↶ Deshecho (${batch.length} celda${batch.length === 1 ? "" : "s"})`);
      setTimeout(() => setCopyToast(""), 1500);
    } finally {
      isUndoingRef.current = false;
    }
  };

  const onCellKeyDown = async (params) => {
    const e = params.event;
    if (!e) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;
    const key = String(e.key || "").toLowerCase();
    if (key === "d") {
      e.preventDefault();
      e.stopPropagation();
      await fillDown(params);
    } else if (key === "v") {
      e.preventDefault();
      e.stopPropagation();
      await pasteFromClipboard(params);
    } else if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      await undoLast();
    }
  };

  const onCellValueChanged = async (params) => {
    const field = params.colDef.field;
    if (!field || field === "total" || field === "rut" || field === "name" || field.endsWith("__amt") || field.endsWith("__total")) return;

    // Push to undo stack before mutating. Skip when we are replaying an undo.
    if (!isUndoingRef.current) {
      const oldValue = params.oldValue !== undefined ? params.oldValue : params.data?.[field];
      const entry = { rut: params.data?.rut, field, oldValue };
      if (pendingBatchRef.current) {
        pendingBatchRef.current.push(entry);
      } else {
        undoStackRef.current.push([entry]);
        if (undoStackRef.current.length > UNDO_LIMIT) undoStackRef.current.shift();
      }
    }

    if (isCosechaLabor) {
      const [date, ...rest] = field.split("__");
      const ck = rest.join("_");
      const { x, y } = parseComboKey(ck);
      const workerRut = params.data.rut;
      const docId = workdayDocId(id, activeLabor.id, workerRut, date, ck);
      const mapKey = workdayMapKey(workerRut, date, ck);
      const qty = parseAmount(params.newValue) || 0;
      const combo = getCombo(activeLabor.id, date, ck);
      const amount = combo.mode === "flat" ? combo.price : qty * combo.price;

      if (qty === 0) {
        if (wdMap[mapKey]) {
          await workdaysService.remove(docId);
          setWorkdaysByLabor((prev) => {
            const lab = { ...(prev[activeLabor.id] || {}) };
            delete lab[mapKey];
            return { ...prev, [activeLabor.id]: lab };
          });
        }
        params.node.setDataValue(field, 0);
        params.node.setDataValue(`${field}__amt`, 0);
      } else {
        await workdaysService.upsert(docId, {
          cycleId: id, laborId: activeLabor.id, workerRut, date,
          qualityX: x, containerY: y, qty, amount,
        });
        setWorkdaysByLabor((prev) => {
          const lab = { ...(prev[activeLabor.id] || {}) };
          lab[mapKey] = { ...lab[mapKey], cycleId: id, laborId: activeLabor.id, workerRut, date, qualityX: x, containerY: y, qty, amount };
          return { ...prev, [activeLabor.id]: lab };
        });
        params.node.setDataValue(field, qty);
        params.node.setDataValue(`${field}__amt`, amount);
      }

      let newTotal = 0;
      for (const d of days) {
        const combos = dayCombosByDate[d] || [];
        for (const c of combos) {
          const f = `${d}__${c.key}`;
          if (f === field) newTotal += amount;
          else newTotal += Number(params.data[`${f}__amt`]) || 0;
        }
      }
      params.node.setDataValue("total", newTotal);
      return;
    }

    if (isTratoHELabor) {
      const m = field.match(/^(\d{4}-\d{2}-\d{2})__(qty|he)$/);
      if (!m) return;
      const [, date, kind] = m;
      const workerRut = params.data.rut;
      const newVal = parseAmount(params.newValue) || 0;
      const patch = kind === "qty" ? { qty: newVal } : { overtimeHours: newVal };
      const result = await upsertTratoHEWorkday(activeLabor.id, date, workerRut, patch);
      params.node.setDataValue(field, newVal);
      params.node.setDataValue(`${date}__amt`, result.amount);
      let newTotal = 0;
      for (const d of days) {
        if (d === date) newTotal += result.amount;
        else newTotal += Number(params.data[`${d}__amt`]) || 0;
      }
      params.node.setDataValue("total", newTotal);
      return;
    }

    if (isTratoLabor) {
      const [date, ...rest] = field.split("__");
      const tierKey = rest.join("_"); // e.g., "t0", "t1"
      const workerRut = params.data.rut;
      const docId = workdayDocId(id, activeLabor.id, workerRut, date, tierKey);
      const mapKey = workdayMapKey(workerRut, date, tierKey);
      const qty = parseAmount(params.newValue) || 0;

      // Find the tier config to calculate amount
      const tiers = dayTiersByDate[date] || [];
      const tier = tiers.find((t) => t.key === tierKey);
      const amount = tier && tier.mode === "flat" ? (qty > 0 ? tier.price : 0) : qty * (tier?.price || 0);

      if (qty === 0) {
        if (wdMap[mapKey]) {
          await workdaysService.remove(docId);
          setWorkdaysByLabor((prev) => {
            const lab = { ...(prev[activeLabor.id] || {}) };
            delete lab[mapKey];
            return { ...prev, [activeLabor.id]: lab };
          });
        }
        params.node.setDataValue(field, 0);
        params.node.setDataValue(`${field}__amt`, 0);
      } else {
        await workdaysService.upsert(docId, {
          cycleId: id, laborId: activeLabor.id, workerRut, date, qty, amount,
        });
        setWorkdaysByLabor((prev) => {
          const lab = { ...(prev[activeLabor.id] || {}) };
          lab[mapKey] = { ...lab[mapKey], cycleId: id, laborId: activeLabor.id, workerRut, date, qty, amount };
          return { ...prev, [activeLabor.id]: lab };
        });
        params.node.setDataValue(field, qty);
        params.node.setDataValue(`${field}__amt`, amount);
      }

      // Recalc total from grid row data
      let rowTotal = 0;
      for (const d of days) {
        const combos = dayTiersByDate[d] || [];
        for (const t of combos) {
          const f = `${d}__${t.key}`;
          if (f === field) rowTotal += amount;
          else rowTotal += Number(params.data[`${f}__amt`]) || 0;
        }
      }
      params.node.setDataValue("total", rowTotal);
      return;
    }

    // Normal labor
    const date = field;
    const workerRut = params.data.rut;
    const docId = workdayDocId(id, activeLabor.id, workerRut, date, SINGLE_COMBO);
    const mapKey = workdayMapKey(workerRut, date, SINGLE_COMBO);
    const amount = parseAmount(params.newValue);

    if (amount === 0) {
      if (wdMap[mapKey]) {
        await workdaysService.remove(docId);
        setWorkdaysByLabor((prev) => {
          const lab = { ...(prev[activeLabor.id] || {}) };
          delete lab[mapKey];
          return { ...prev, [activeLabor.id]: lab };
        });
      }
    } else {
      await workdaysService.upsert(docId, { cycleId: id, laborId: activeLabor.id, workerRut, date, amount });
      setWorkdaysByLabor((prev) => {
        const lab = { ...(prev[activeLabor.id] || {}) };
        lab[mapKey] = { ...lab[mapKey], cycleId: id, laborId: activeLabor.id, workerRut, date, amount };
        return { ...prev, [activeLabor.id]: lab };
      });
    }
    params.node.setDataValue(date, amount);
    const total = days.reduce((acc, d) => acc + (d === date ? amount : Number(params.data[d]) || 0), 0);
    params.node.setDataValue("total", total);
  };

  // ============================================================
  // Days
  // ============================================================

  const addDay = async () => {
    if (!newDay) return;
    if (days.includes(newDay)) { setAddDayOpen(false); return; }
    await persistDays([...days, newDay].sort());
    setAddDayOpen(false);
  };

  const addSelectedDays = async () => {
    const toAdd = [...selectedDays].filter((d) => !days.includes(d));
    if (toAdd.length === 0) { setAddDayOpen(false); return; }
    await persistDays([...days, ...toAdd].sort());
    setSelectedDays(new Set());
    setAddDayOpen(false);
  };

  const toggleSelectedDay = (date) => {
    setSelectedDays((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  const removeDay = async (date) => {
    const wds = await workdaysService.list({
      wheres: [["cycleId", "==", id], ["date", "==", date]], take: 1,
    });
    if (wds.length) {
      alert(`No se puede quitar ${date}: hay producción registrada en alguna labor para ese día.`);
      return;
    }
    if (!confirm(`¿Quitar la columna ${date}?`)) return;
    await persistDays(days.filter((d) => d !== date));
  };

  // ============================================================
  // Workers
  // ============================================================

  const pickWorker = async (worker) => {
    if (workers.find((w) => w.rut === worker.rut)) { setPickerOpen(false); return; }
    const entry = { rut: worker.rut, name: worker.name };
    if (worker.isTemp) {
      entry.isTemp = true;
      // Temp workers don't have a row in the `worker` collection, so their
      // leader is stored alongside the entry inside labor.workers and read
      // back when building the per-leader group view.
      if (worker.groupLeader) entry.groupLeader = String(worker.groupLeader).toUpperCase();
    }
    await persistLabor({ ...activeLabor, workers: [...workers, entry] });
    setPickerOpen(false);
  };

  // Toggle the "pago mensual" flag for a worker inside the current labor.
  // Stored as `monthly: true` on the labor.workers entry. Used only for
  // "normal" labors (supervisión, etc.) — when set, the day cells switch to
  // a presence checkbox and the workday is saved with amount=0 so it never
  // makes it into the payroll transfer.
  const toggleMonthly = async (rut) => {
    if (readOnly || !activeLabor) return;
    const nextWorkers = workers.map((w) =>
      w.rut === rut ? { ...w, monthly: !w.monthly } : w,
    );
    await persistLabor({ ...activeLabor, workers: nextWorkers });
  };

  // Create / remove a 0-amount workday for monthly workers — used as the
  // "presente sin pago" toggle from the day cell. Reusing the existing
  // workday infrastructure keeps metrics + jornada counters consistent. The
  // caller passes `currentlyPresent` from the rendered row data so we never
  // depend on a possibly-stale closure of wdMap.
  const toggleAttendance = async (rut, date, currentlyPresent) => {
    if (readOnly || !activeLabor) return;
    const mapKey = workdayMapKey(rut, date, SINGLE_COMBO);
    const docId = workdayDocId(id, activeLabor.id, rut, date, SINGLE_COMBO);
    if (currentlyPresent) {
      await workdaysService.remove(docId);
      setWorkdaysByLabor((prev) => {
        const lab = { ...(prev[activeLabor.id] || {}) };
        delete lab[mapKey];
        return { ...prev, [activeLabor.id]: lab };
      });
    } else {
      await workdaysService.upsert(docId, {
        cycleId: id, laborId: activeLabor.id, workerRut: rut, date,
        amount: 0, attendanceOnly: true,
      });
      setWorkdaysByLabor((prev) => {
        const lab = { ...(prev[activeLabor.id] || {}) };
        lab[mapKey] = { cycleId: id, laborId: activeLabor.id, workerRut: rut, date, amount: 0, attendanceOnly: true };
        return { ...prev, [activeLabor.id]: lab };
      });
    }
  };

  const askRemoveWorker = (rut) => {
    const w = workers.find((x) => x.rut === rut);
    if (w) setRemoveWorker(w);
  };

  const confirmRemoveWorker = async () => {
    if (!removeWorker) return;
    setRemoveBusy(true);
    try {
      // Temp workers: borrar también todas sus workdays en este ciclo. Son
      // datos descartables y no deben quedar huérfanos en Firestore.
      if (removeWorker.isTemp) {
        const all = await workdaysService.list({
          wheres: [["cycleId", "==", id], ["workerRut", "==", removeWorker.rut]],
        });
        for (const wd of all) await workdaysService.remove(wd.id);
        setWorkdaysByLabor((prev) => {
          const next = {};
          for (const [lid, m] of Object.entries(prev)) {
            const filtered = {};
            for (const [k, v] of Object.entries(m)) {
              if (v?.workerRut !== removeWorker.rut) filtered[k] = v;
            }
            next[lid] = filtered;
          }
          return next;
        });
        await persistLabor({ ...activeLabor, workers: workers.filter((w) => w.rut !== removeWorker.rut) });
        setRemoveWorker(null);
        return;
      }
      const existing = await workdaysService.list({
        wheres: [["cycleId", "==", id], ["laborId", "==", activeLabor.id], ["workerRut", "==", removeWorker.rut]],
        take: 1,
      });
      if (existing.length) {
        alert("No se puede quitar: el trabajador tiene producción registrada en esta labor.");
        setRemoveWorker(null);
        return;
      }
      await persistLabor({ ...activeLabor, workers: workers.filter((w) => w.rut !== removeWorker.rut) });
      setRemoveWorker(null);
    } finally {
      setRemoveBusy(false);
    }
  };

  // Convert a temporary worker (TEMP-...) into a real one. Replaces the entry
  // in the labor's workers array and rewrites every workday doc that used the
  // temp rut. The doc id embeds the rut, so we copy each doc to a new id and
  // delete the old one — there is no rename in Firestore.
  const convertTempToReal = async (real) => {
    const tempRut = assignTempRut;
    if (!tempRut || !real?.rut) { setAssignTempRut(null); return; }
    if (real.isTemp) { setAssignTempRut(null); return; }
    if (real.rut === tempRut) { setAssignTempRut(null); return; }
    if (workers.some((w) => w.rut === real.rut)) {
      alert("Ese trabajador ya existe en este ciclo. Quita primero la fila duplicada antes de asignar.");
      return;
    }
    setAssignBusy(true);
    try {
      const wds = await workdaysService.list({
        wheres: [["cycleId", "==", id], ["workerRut", "==", tempRut]],
      });
      for (const wd of wds) {
        const parts = String(wd.id).split("__");
        if (parts.length < 4) continue;
        parts[2] = real.rut;
        const newDocId = parts.join("__");
        const { id: _omit, ...rest } = wd;
        await workdaysService.upsert(newDocId, { ...rest, workerRut: real.rut });
        await workdaysService.remove(wd.id);
      }
      // Update labor.workers in place — preserve order.
      const nextWorkers = workers.map((w) =>
        w.rut === tempRut ? { rut: real.rut, name: real.name } : w,
      );
      await persistLabor({ ...activeLabor, workers: nextWorkers });
      // Rebuild local wdMap for this labor: re-key entries that pointed at temp.
      setWorkdaysByLabor((prev) => {
        const next = { ...prev };
        for (const [lid, m] of Object.entries(prev)) {
          const newMap = {};
          for (const [k, v] of Object.entries(m)) {
            if (v?.workerRut === tempRut) {
              const newKey = workdayMapKey(real.rut, v.date, k.split("__")[2] || SINGLE_COMBO);
              newMap[newKey] = { ...v, workerRut: real.rut };
            } else {
              newMap[k] = v;
            }
          }
          next[lid] = newMap;
        }
        return next;
      });
      setAssignTempRut(null);
    } catch (err) {
      console.error(err);
      alert("No se pudo asignar el RUT: " + (err.message || err));
    } finally {
      setAssignBusy(false);
    }
  };

  // ============================================================
  // Labor
  // ============================================================

  const openCreateLabor = () =>
    setLaborForm({
      mode: "create",
      data: {
        name: "", type: "extra",
        cosechaMode: "unit",
        tratoMode: "unit",
        tratoType: catalogs.tratoTypes?.[0]?.value ?? 0,
        baseDayDefault: DEFAULT_BASE_DAY,
        bonusManejo: DEFAULT_BONUS_MANEJO,
        bonusSupervision: DEFAULT_BONUS_SUPERVISION,
        overtimeRate: DEFAULT_OVERTIME_RATE,
      },
    });

  const openEditLabor = () =>
    setLaborForm({
      mode: "edit",
      data: {
        id: activeLabor.id,
        name: activeLabor.name,
        type: activeLabor.type,
        cosechaMode: activeLabor.cosechaMode || "unit",
        tratoMode: activeLabor.tratoMode || "unit",
        tratoType: activeLabor.tratoType ?? (catalogs.tratoTypes?.[0]?.value ?? 0),
        baseDayDefault: activeLabor.baseDayDefault ?? DEFAULT_BASE_DAY,
        bonusManejo: activeLabor.bonusManejo ?? DEFAULT_BONUS_MANEJO,
        bonusSupervision: activeLabor.bonusSupervision ?? DEFAULT_BONUS_SUPERVISION,
        overtimeRate: activeLabor.overtimeRate ?? DEFAULT_OVERTIME_RATE,
      },
    });

  const submitLabor = async (e) => {
    e.preventDefault();
    if (!laborForm.data.name.trim()) return;
    const buildLabor = (existing = {}) => {
      const base = {
        ...existing,
        name: laborForm.data.name.trim(),
        type: laborForm.data.type,
      };
      if (laborForm.data.type === "cosecha") {
        base.cosechaMode = laborForm.data.cosechaMode;
      }
      if (laborForm.data.type === "trato") {
        base.tratoMode = laborForm.data.tratoMode;
        base.tratoType = Number(laborForm.data.tratoType);
      }
      if (laborForm.data.type === "tratoHE") {
        base.baseDayDefault = Number(laborForm.data.baseDayDefault) || DEFAULT_BASE_DAY;
        base.bonusManejo = Number(laborForm.data.bonusManejo) || DEFAULT_BONUS_MANEJO;
        base.bonusSupervision = Number(laborForm.data.bonusSupervision) || DEFAULT_BONUS_SUPERVISION;
        base.overtimeRate = Number(laborForm.data.overtimeRate) || DEFAULT_OVERTIME_RATE;
      }
      return base;
    };
    if (laborForm.mode === "create") {
      const labor = { id: newId(), ...buildLabor(), workers: [] };
      const nextLabors = [...cycle.labors, labor];
      await cyclesService.update(id, { labors: nextLabors });
      setCycle((c) => ({ ...c, labors: nextLabors }));
      setActiveLaborId(labor.id);
    } else {
      const nextLabors = cycle.labors.map((l) =>
        l.id === laborForm.data.id ? buildLabor(l) : l,
      );
      await cyclesService.update(id, { labors: nextLabors });
      setCycle((c) => ({ ...c, labors: nextLabors }));
      // Recalc workdays if tratoHE rates may have changed
      if (laborForm.data.type === "tratoHE") {
        // Need to wait for state update before recalc reads new labor rates.
        // Simpler: do recalc using nextLabors directly via inline calc.
        const updatedLabor = nextLabors.find((l) => l.id === laborForm.data.id);
        const wdMapForLabor = workdaysByLabor[updatedLabor.id] || {};
        const updates = {};
        for (const k in wdMapForLabor) {
          const wd = wdMapForLabor[k];
          const dayCfg = getDaySingle(dayPrices, updatedLabor.id, wd.date, "normal");
          const amount = computeTratoHEAmount(updatedLabor, dayCfg, wd);
          if (amount === wd.amount) continue;
          const docId = workdayDocId(id, updatedLabor.id, wd.workerRut, wd.date, SINGLE_COMBO);
          const next = { ...wd, amount };
          await workdaysService.upsert(docId, next);
          updates[k] = next;
        }
        if (Object.keys(updates).length > 0) {
          setWorkdaysByLabor((prev) => ({
            ...prev,
            [updatedLabor.id]: { ...(prev[updatedLabor.id] || {}), ...updates },
          }));
        }
      }
    }
    setLaborForm(null);
  };

  const askRemoveLabor = () => setRemoveLabor(activeLabor);
  const confirmRemoveLabor = async () => {
    if (!removeLabor) return;
    const wds = await workdaysService.list({
      wheres: [["cycleId", "==", id], ["laborId", "==", removeLabor.id]], take: 1,
    });
    if (wds.length) {
      alert("No se puede quitar: la labor tiene producción registrada.");
      setRemoveLabor(null);
      return;
    }
    if (cycle.labors.length === 1) {
      alert("Debe existir al menos una labor.");
      setRemoveLabor(null);
      return;
    }
    const nextLabors = cycle.labors.filter((l) => l.id !== removeLabor.id);
    await cyclesService.update(id, { labors: nextLabors });
    setCycle((c) => ({ ...c, labors: nextLabors }));
    setActiveLaborId(nextLabors[0]?.id || null);
    setRemoveLabor(null);
  };

  // ============================================================
  // Misc
  // ============================================================

  const showToast = (msg) => {
    setCopyToast(msg);
    setTimeout(() => setCopyToast(""), 1800);
  };

  const handleCloseCycle = async () => {
    setCloseBusy(true);
    try {
      await cyclesService.update(id, { status: "closed", endDate: todayStr() });
      setCycle((c) => ({ ...c, status: "closed", endDate: todayStr() }));
      setCloseFlow(false);
      showToast("Ciclo cerrado");
    } finally {
      setCloseBusy(false);
    }
  };

  const handleReopenCycle = async () => {
    if (!confirm("¿Reabrir el ciclo?")) return;
    await cyclesService.update(id, { status: "open", endDate: null });
    setCycle((c) => ({ ...c, status: "open", endDate: null }));
    showToast("Ciclo reabierto");
  };

  const exportPng = async () => {
    if (!photoRef.current) return;
    setExporting(true);
    try {
      const bg = getComputedStyle(document.body).backgroundColor || "#ffffff";
      const dataUrl = await toPng(photoRef.current, { backgroundColor: bg, pixelRatio: 2, cacheBust: true });
      const link = document.createElement("a");
      link.download = `${cycle.label}_${activeLabor?.name || "labor"}_${todayStr()}.png`.replace(/\s+/g, "_");
      link.href = dataUrl;
      link.click();
      showToast("PNG descargado");
    } catch (err) {
      console.error(err);
      showToast("No se pudo generar el PNG");
    } finally {
      setExporting(false);
    }
  };

  const copyImage = async () => {
    if (!photoRef.current) return;
    setExporting(true);
    try {
      const bg = getComputedStyle(document.body).backgroundColor || "#ffffff";
      const blob = await toBlob(photoRef.current, { backgroundColor: bg, pixelRatio: 2, cacheBust: true });
      if (!blob) throw new Error("No se pudo generar la imagen");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      showToast("Imagen copiada");
    } catch (err) {
      console.error(err);
      showToast("No se pudo copiar la imagen");
    } finally {
      setExporting(false);
    }
  };

  const printPhoto = async () => {
    if (!photoRef.current) return;
    setExporting(true);
    try {
      const bg = getComputedStyle(document.body).backgroundColor || "#ffffff";
      const dataUrl = await toPng(photoRef.current, { backgroundColor: bg, pixelRatio: 2, cacheBust: true });
      const win = window.open("", "_blank", "width=1100,height=800");
      if (!win) return;
      win.document.write(`<!DOCTYPE html><html><head><title>${cycle.label} · ${activeLabor?.name || ""}</title>
        <style>
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
          body { margin: 0; padding: 16px; background: #fff; }
          img { max-width: 100%; height: auto; display: block; }
          @media print { @page { size: landscape; margin: 8mm; } body { padding: 0; } }
        </style>
      </head><body><img src="${dataUrl}" /></body></html>`);
      win.document.close();
      win.focus();
      setTimeout(() => { win.print(); }, 300);
    } catch (err) {
      console.error(err);
      showToast("No se pudo imprimir");
    } finally {
      setExporting(false);
    }
  };

  // ============================================================
  // Column defs
  // ============================================================

  const columnDefs = useMemo(() => {
    const baseLeft = [
      {
        headerName: "RUT", field: "rut", editable: false, width: 140, pinned: "left",
        checkboxSelection: !photoMode, headerCheckboxSelection: !photoMode,
        onCellDoubleClicked: (p) => {
          if (p.data?._isHeader || p.data?._isTemp) return;
          const rut = p.data?.rut;
          if (rut) setEditingWorkerRut(rut);
        },
        cellRenderer: (p) => {
          if (p.data?._isHeader) return null;
          if (p.data?._isTemp) {
            if (readOnly) {
              return <span className="text-xs italic text-[var(--color-muted)]">sin RUT</span>;
            }
            return (
              <button
                type="button"
                onClick={() => setAssignTempRut(p.data.rut)}
                className="rounded border border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
                title="Asignar un RUT real a este trabajador temporal"
              >
                Asignar RUT
              </button>
            );
          }
          return (
            <span
              className="cursor-pointer hover:underline"
              title="Doble click para editar el trabajador"
            >
              {formatRutForDisplay(p.value)}
            </span>
          );
        },
      },
      {
        headerName: "Nombre", field: "name", editable: false, width: 220, pinned: "left",
        cellRenderer: (p) => {
          if (p.data?._isHeader) return p.value;
          const badges = [];
          if (p.data?._isTemp) {
            badges.push(
              <span
                key="temp"
                className="rounded border border-amber-500/50 bg-amber-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300"
                title="Trabajador temporal: solo vive en este ciclo y se ignora al pagar"
              >
                Temporal
              </span>
            );
          }
          if (p.data?._monthly) {
            badges.push(
              <span
                key="monthly"
                className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/20 text-[10px] font-bold text-emerald-700 dark:text-emerald-300"
                title="Pago mensual: las jornadas se registran como asistencia pero no entran al payroll"
              >
                M
              </span>
            );
          }
          if (p.data?._isOrphan) {
            badges.push(
              <span
                key="orphan"
                className="rounded border border-rose-500/50 bg-rose-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-300"
                title="Tiene producción registrada pero ya no está en el listado del labor. Las métricas y el payroll lo siguen contando. Eliminar sus workdays o re-agregarlo al listado."
              >
                Huérfano
              </span>
            );
          }
          if (badges.length === 0) return p.value;
          return (
            <span className="inline-flex items-center gap-1.5">
              <span>{p.value}</span>
              {badges}
            </span>
          );
        },
      },
    ];
    const totalCol = {
      headerName: isQtyLabor ? "TOTAL ($)" : "TOTAL",
      field: "total", editable: false, width: 150, pinned: "right",
      valueFormatter: (p) => fmtCurrency(p.value),
      cellStyle: { fontWeight: 600, color: "var(--color-accent)" },
    };
    const isNormalLaborForCol = !isCosechaLabor && !isTratoLabor && !isTratoHELabor;
    const actionsCol = photoMode ? [] : [{
      headerName: "", field: "_actions", editable: false,
      width: useGrouped ? 240 : (isNormalLaborForCol ? 130 : 90), pinned: "right",
      cellRenderer: (p) => {
        const rut = p.data?.rut;
        if (!rut || p.data?._isHeader) return null;
        const isTemp = !!p.data?._isTemp;
        const isMonthly = !!p.data?._monthly;
        const isNormalLabor = !isCosechaLabor && !isTratoLabor && !isTratoHELabor;
        const showAssign = useGrouped && !rutToLeader.has(rut) && !readOnly && !isTemp;
        return (
          <div className="flex items-center gap-1.5">
            {isNormalLabor && !readOnly && (
              <button
                type="button"
                onClick={() => toggleMonthly(rut)}
                className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-bold ${
                  isMonthly
                    ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-700 hover:bg-emerald-500/30 dark:text-emerald-300"
                    : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
                }`}
                title={isMonthly
                  ? "Pago mensual activo. Click para volver a pago por día."
                  : "Marcar como pago mensual (no entra al payroll)."}
              >
                M
              </button>
            )}
            {showAssign && (
              <>
                <button
                  type="button"
                  onClick={() => assignLeaderToWorker(rut, LEADER_LOCAL)}
                  disabled={groupBusy}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
                  title="Marcar como CHILENOS"
                >
                  Chilenos
                </button>
                <button
                  type="button"
                  onClick={() => setLeaderPickerFor(rut)}
                  disabled={groupBusy}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
                  title="Elegir otro líder"
                >
                  …
                </button>
              </>
            )}
            <button
              onClick={() => askRemoveWorker(rut)}
              disabled={readOnly}
              className="text-xs text-[var(--color-danger)] hover:underline disabled:opacity-40"
            >
              Quitar
            </button>
          </div>
        );
      },
    }];

    // Click-to-edit annotation header. Shared across single columns and
    // column groups. Each day either gets `headerComponent` (single column)
    // or `headerGroupComponent` (group with children).
    const dayHdrParams = (d) => ({
      date: d, note: dayNotes[d] || "", onClickNote: openDayNote,
    });
    const dayCellHdr = (d) => ({
      headerComponent: DayHeader,
      headerComponentParams: dayHdrParams(d),
    });
    const dayGroupHdr = (d) => ({
      headerGroupComponent: DayHeader,
      headerGroupComponentParams: dayHdrParams(d),
    });

    if (isCosechaLabor) {
      if (cosechaView === "resumen") {
        const dayCols = days.map((d) => ({
          headerName: d,
          field: `${d}__total`,
          editable: false,
          width: 110,
          ...dayCellHdr(d),
          valueFormatter: (p) => (p.value ? fmtCurrency(p.value) : ""),
          cellRenderer: (p) => {
            const amt = Number(p.value) || 0;
            if (!amt) return "";
            return <span className="text-right text-sm font-semibold tabular-nums">{fmtCurrency(amt)}</span>;
          },
          cellStyle: { textAlign: "right" },
        }));
        return [...baseLeft, ...dayCols, totalCol, ...actionsCol];
      }
      const dayGroups = days.map((d) => {
        const combos = dayCombosByDate[d] || [];
        const children = combos.map((c) => ({
          headerName: comboLabel(catalogs, c.x, c.y),
          field: `${d}__${c.key}`,
          editable: !readOnly && !photoMode,
          width: 120,
          type: "numericColumn",
          valueParser: (p) => parseAmount(p.newValue),
          cellRenderer: (p) => {
            const qty = Number(p.value) || 0;
            const amt = Number(p.data?.[`${d}__${c.key}__amt`]) || 0;
            if (!qty && !amt) return "";
            return (
              <div className="leading-tight">
                <div className="font-medium tabular-nums">
                  {qty.toLocaleString("es-CL")} {containerLabel(catalogs, c.y)}
                </div>
                {amt > 0 && (
                  <div className="text-[10px] text-[var(--color-muted)] tabular-nums">{fmtCurrency(amt)}</div>
                )}
              </div>
            );
          },
        }));
        if (daysWithPiso.has(d)) {
          children.push(buildPisoChildCol(d, activeLabor, dayPrices, readOnly || photoMode, togglePiso));
        }
        return {
          headerName: d, groupId: `g_${d}`,
          ...dayGroupHdr(d),
          children: children.length ? children : [{
            headerName: "—", field: `${d}__placeholder`, editable: false, width: 80, valueGetter: () => "",
          }],
        };
      });
      return [...baseLeft, ...dayGroups, totalCol, ...actionsCol];
    }

    if (isTratoLabor) {
      if (tratoView === "resumen") {
        const dayCols = days.map((d) => ({
          headerName: d,
          field: `${d}__total`,
          editable: false,
          width: 110,
          ...dayCellHdr(d),
          valueFormatter: (p) => (p.value ? fmtCurrency(p.value) : ""),
          cellRenderer: (p) => {
            const amt = Number(p.value) || 0;
            if (!amt) return "";
            return <span className="text-right text-sm font-semibold tabular-nums">{fmtCurrency(amt)}</span>;
          },
          cellStyle: { textAlign: "right" },
        }));
        return [...baseLeft, ...dayCols, totalCol, ...actionsCol];
      }
      const dayGroups = days.map((d) => {
        const tiers = dayTiersByDate[d] || [];
        const children = tiers.map((t) => ({
          headerName: `${fmtCurrency(t.price)} ${t.mode === "flat" ? "/día" : "/unid"}`,
          field: `${d}__${t.key}`,
          editable: !readOnly && !photoMode,
          width: 120,
          type: "numericColumn",
          valueParser: (p) => parseAmount(p.newValue),
          cellRenderer: (p) => {
            const qty = Number(p.value) || 0;
            const amt = Number(p.data?.[`${d}__${t.key}__amt`]) || 0;
            if (!qty && !amt) return "";
            return (
              <div className="leading-tight">
                <div className="font-medium tabular-nums">{qty.toLocaleString("es-CL")}</div>
                {amt > 0 && (
                  <div className="text-[10px] text-[var(--color-muted)] tabular-nums">{fmtCurrency(amt)}</div>
                )}
              </div>
            );
          },
        }));
        if (daysWithPiso.has(d)) {
          children.push(buildPisoChildCol(d, activeLabor, dayPrices, readOnly || photoMode, togglePiso));
        }
        return {
          headerName: d, groupId: `g_${d}`,
          ...dayGroupHdr(d),
          children: children.length ? children : [{
            headerName: "—", field: `${d}__placeholder`, editable: false, width: 80, valueGetter: () => "",
          }],
        };
      });
      return [...baseLeft, ...dayGroups, totalCol, ...actionsCol];
    }

    if (isTratoHELabor) {
      const labor = activeLabor;
      const rates = {
        bonusManejo: labor?.bonusManejo ?? DEFAULT_BONUS_MANEJO,
        bonusSupervision: labor?.bonusSupervision ?? DEFAULT_BONUS_SUPERVISION,
        overtimeRate: labor?.overtimeRate ?? DEFAULT_OVERTIME_RATE,
      };
      const buildBreakdown = (data, d, cfg) => {
        const qty = Number(data?.[`${d}__qty`]) || 0;
        const he = Number(data?.[`${d}__he`]) || 0;
        const m = !!data?.[`${d}__m`];
        const s = !!data?.[`${d}__s`];
        const x = Number(data?.[`${d}__x`]) || 0;
        const lines = [];
        const base = cfg.mode === "overtimeOnly" ? 0 : qty;
        if (cfg.mode === "overtimeOnly") {
          lines.push(`Solo HE (sin base)`);
        } else if (qty > 0) {
          lines.push(`Base: ${fmtCurrency(base)}`);
        }
        if (he > 0) lines.push(`HE: ${he}h × ${fmtCurrency(rates.overtimeRate)} = ${fmtCurrency(he * rates.overtimeRate)}`);
        if (m) lines.push(`Manejo: ${fmtCurrency(rates.bonusManejo)}`);
        if (s) lines.push(`Supervisión: ${fmtCurrency(rates.bonusSupervision)}`);
        if (x !== 0) lines.push(`Extras: ${fmtCurrency(x)}`);
        const total = Number(data?.[`${d}__amt`]) || 0;
        if (lines.length === 0) return "Sin movimiento";
        lines.push(`= ${fmtCurrency(total)}`);
        return lines.join("\n");
      };

      // Resumen mode: single $ column per day
      if (tratoHEView === "resumen") {
        const dayCols = days.map((d) => {
          const cfg = getDaySingle(dayPrices, activeLabor.id, d, "normal");
          const red = isRedDay(d, cfg);
          const headerSuffix = cfg.mode === "overtimeOnly" ? " · solo HE" : "";
          const headerLabel = `${d}${cfg.isHoliday ? " 🎉" : ""}${headerSuffix}`;
          return {
            headerName: headerLabel,
            field: `${d}__amt`,
            editable: false,
            width: 110,
            ...dayCellHdr(d),
            headerClass: red ? "ag-header-red-day" : undefined,
            valueFormatter: (p) => p.value ? fmtCurrency(p.value) : "",
            cellRenderer: (p) => {
              const amt = Number(p.value) || 0;
              if (!amt) return "";
              return (
                <button
                  onClick={() => setBonusEdit({ laborId: activeLabor.id, date: d, workerRut: p.data.rut })}
                  disabled={readOnly}
                  title={buildBreakdown(p.data, d, cfg)}
                  className="h-full w-full text-right text-sm font-semibold tabular-nums hover:underline"
                >
                  {fmtCurrency(amt)}
                </button>
              );
            },
            cellStyle: { textAlign: "right" },
          };
        });
        return [...baseLeft, ...dayCols, totalCol, ...actionsCol];
      }

      const dayGroups = days.map((d) => {
        const cfg = getDaySingle(dayPrices, activeLabor.id, d, "normal");
        const red = isRedDay(d, cfg);
        const headerSuffix = cfg.mode === "overtimeOnly" ? " · solo HE" : "";
        const headerLabel = `${d}${cfg.isHoliday ? " 🎉" : ""}${headerSuffix}`;
        return {
          headerName: headerLabel,
          groupId: `g_${d}`,
          ...dayGroupHdr(d),
          headerClass: red ? "ag-header-red-day" : undefined,
          children: [
            {
              headerName: "Base",
              field: `${d}__qty`,
              // Empty cells stay non-editable so the click reaches the
              // "use suggested price" button rendered below; once they have
              // a value, normal editing kicks back in.
              editable: (p) => !readOnly && !photoMode && Number(p.data?.[`${d}__qty`] || 0) > 0,
              width: 110,
              type: "numericColumn",
              valueParser: (p) => parseAmount(p.newValue),
              valueFormatter: (p) => (p.value ? fmtCurrency(p.value) : ""),
              headerTooltip: `Base del día (monto). Sugerido: ${fmtCurrency(effectiveDayPrice(labor, cfg))}. Click para usar el sugerido si está vacío.`,
              cellStyle: { textAlign: "right" },
              cellRenderer: (p) => {
                const v = Number(p.value) || 0;
                if (v) return fmtCurrency(v);
                if (readOnly || photoMode || cfg.mode === "overtimeOnly") return "";
                const suggested = effectiveDayPrice(labor, cfg);
                return (
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      await upsertTratoHEWorkday(activeLabor.id, d, p.data.rut, { qty: suggested });
                    }}
                    className="h-full w-full text-right text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)]"
                    title={`Usar base sugerida: ${fmtCurrency(suggested)}`}
                  >
                    {fmtCurrency(suggested)}
                  </button>
                );
              },
            },
            {
              headerName: "HE",
              field: `${d}__he`,
              editable: !readOnly && !photoMode,
              width: 60,
              type: "numericColumn",
              valueParser: (p) => parseAmount(p.newValue),
              valueFormatter: (p) => (p.value ? `${p.value}h` : ""),
              headerTooltip: "Horas extras",
            },
            {
              headerName: "$",
              field: `${d}__b`,
              editable: false,
              width: 130,
              headerTooltip: "Bonos (M/S/+) y total del día",
              cellRenderer: (p) => {
                const m = p.data?.[`${d}__m`];
                const s = p.data?.[`${d}__s`];
                const x = Number(p.data?.[`${d}__x`]) || 0;
                const amt = Number(p.data?.[`${d}__amt`]) || 0;
                return (
                  <button
                    onClick={() => setBonusEdit({ laborId: activeLabor.id, date: d, workerRut: p.data.rut })}
                    disabled={readOnly}
                    title={buildBreakdown(p.data, d, cfg)}
                    className="flex h-full w-full items-center gap-1 rounded px-1 text-xs hover:bg-[var(--color-accent-soft)]"
                  >
                    <div className="flex gap-0.5">
                      {m && <span className="rounded bg-blue-100 px-1 text-[9px] font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">M</span>}
                      {s && <span className="rounded bg-purple-100 px-1 text-[9px] font-medium text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">S</span>}
                      {x !== 0 && <span className="rounded bg-amber-100 px-1 text-[9px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">+</span>}
                      {!m && !s && !x && <span className="text-[var(--color-muted)] opacity-40">···</span>}
                    </div>
                    {amt > 0 && (
                      <span className="ml-auto text-xs font-semibold tabular-nums text-[var(--color-accent)]">
                        {fmtCurrency(amt)}
                      </span>
                    )}
                  </button>
                );
              },
            },
          ],
        };
      });
      return [...baseLeft, ...dayGroups, totalCol, ...actionsCol];
    }

    const dayCols = days.map((d) => ({
      headerName: d, field: d,
      ...dayCellHdr(d),
      // Monthly workers don't edit a number per day — they only mark presence
      // via a click. Block the editor for those rows.
      editable: (p) => !readOnly && !photoMode && !p.data?._monthly,
      width: 110,
      type: "numericColumn",
      valueParser: (p) => parseAmount(p.newValue),
      valueFormatter: (p) => fmtCurrency(p.value),
      cellRenderer: (p) => {
        if (p.data?._monthly) {
          const present = !!p.data?.[`${d}__present`];
          if (readOnly || photoMode) {
            return (
              <span className={present ? "font-semibold text-emerald-600 dark:text-emerald-400" : "text-[var(--color-muted)]"}>
                {present ? "✓" : ""}
              </span>
            );
          }
          return (
            <div
              role="button"
              onClick={(e) => { e.stopPropagation(); toggleAttendance(p.data.rut, d, present); }}
              className={`flex h-full w-full cursor-pointer items-center justify-center text-base font-bold transition-colors ${
                present
                  ? "bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300"
                  : "text-transparent hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
              }`}
              title={present ? "Asistencia registrada (sin pago). Click para borrar." : "Marcar asistencia sin pago."}
            >
              {present ? "✓" : "+"}
            </div>
          );
        }
        const amt = Number(p.value) || 0;
        return amt ? fmtCurrency(amt) : "";
      },
      cellStyle: (p) => p.data?._monthly
        ? { textAlign: "center", padding: 0 }
        : { textAlign: "right" },
    }));
    return [...baseLeft, ...dayCols, totalCol, ...actionsCol];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, readOnly, photoMode, isCosechaLabor, isTratoLabor, isTratoHELabor, dayCombosByDate, dayTiersByDate, catalogs, dayPrices, activeLabor, tratoHEView, cosechaView, tratoView, dayNotes, daysWithPiso]);

  if (loading) return <div className="text-[var(--color-muted)]">Cargando...</div>;
  if (!cycle) return <div className="text-[var(--color-muted)]">Ciclo no encontrado.</div>;

  const grid = (
    <div className="ag-theme-quartz ag-theme-app h-full overflow-x-auto" style={{ minHeight: 400 }}>
      {workers.length === 0 ? (
        <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] text-[var(--color-muted)]">
          Agrega trabajadores para empezar.
        </div>
      ) : (
        <AgGridReact
          ref={gridRef}
          rowData={rowData}
          columnDefs={columnDefs}
          onCellValueChanged={onCellValueChanged}
          onCellKeyDown={onCellKeyDown}
          singleClickEdit={false}
          enterNavigatesVertically
          enterNavigatesVerticallyAfterEdit
          stopEditingWhenCellsLoseFocus
          getRowId={(p) => p.data.rut}
          rowSelection={photoMode ? undefined : "multiple"}
          suppressRowClickSelection
          enableCellTextSelection
          ensureDomOrder
          localeText={AG_GRID_LOCALE_ES}
          defaultColDef={{ resizable: true, sortable: true, filter: true }}
          rowHeight={isQtyLabor ? 44 : undefined}
          isFullWidthRow={(p) => !!p.rowNode.data?._isHeader}
          fullWidthCellRenderer={GroupHeaderRowRenderer}
          getRowClass={(p) => (p.data?._isHeader ? "ag-group-header-row" : "")}
        />
      )}
    </div>
  );

  if (photoMode) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-[var(--color-bg)] p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button onClick={copyImage} disabled={exporting} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60">
            {exporting ? "..." : "🖼 Copiar imagen"}
          </button>
          <button onClick={exportPng} disabled={exporting} className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60">
            {exporting ? "Generando..." : "📥 Descargar PNG"}
          </button>
          <button onClick={printPhoto} disabled={exporting} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60">
            🖨 Imprimir
          </button>
          <button onClick={() => setPhotoMode(false)} className="ml-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
            Salir modo foto
          </button>
        </div>
        <div ref={photoRef} className="flex flex-1 flex-col bg-[var(--color-bg)] p-4">
          <div className="mb-3">
            <h1 className="text-xl font-semibold tracking-tight">{cycle.label} · {activeLabor?.name}</h1>
            <p className="text-xs text-[var(--color-muted)]">
              {faena?.name || "—"}
              {subfaena && ` · ${subfaena.name}`}
              {` · ${workers.length} trabajadores · ${days.length} días`}
            </p>
          </div>
          <div className="flex-1">{grid}</div>
        </div>
        {copyToast && (
          <div className="pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] shadow-lg">
            {copyToast}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-2 text-sm text-[var(--color-muted)]">
        <Link to="/faenas" className="hover:text-[var(--color-accent)]">Faenas</Link>
        <span>/</span>
        {faena ? (
          <Link
            to={`/faenas?selected=${faena.id}`}
            className="hover:text-[var(--color-accent)]"
          >
            {faena.name}
          </Link>
        ) : (
          <span>—</span>
        )}
        {subfaena && (
          <>
            <span>/</span>
            <Link
              to={`/faenas?selected=${faena?.id || ""}&sub=${subfaena.id}`}
              className="hover:text-[var(--color-accent)]"
            >
              {subfaena.name}
            </Link>
          </>
        )}
        <span>/</span>
        <span className="text-[var(--color-text)]">{cycle.label}</span>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{cycle.label}</h1>
          <p className="text-sm text-[var(--color-muted)]">
            {cycle.labors.length} labor{cycle.labors.length === 1 ? "" : "es"} · {days.length} días
            {closed && (isAdmin ? " · ciclo cerrado · edición de admin" : " · ciclo cerrado (solo lectura)")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setCatalogsOpen(true)} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
            ⚙ Catálogos
          </button>
          <button onClick={() => setTransportsOpen(true)} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
            🚐 Transportes
          </button>
          <button onClick={() => setSummaryOpen(true)} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
            📊 Resumen
          </button>
          {!closed && (
            <button onClick={() => setCloseFlow(true)} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
              Cerrar ciclo
            </button>
          )}
          {closed && (
            <button onClick={handleReopenCycle} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
              Reabrir ciclo
            </button>
          )}
          <button onClick={() => setPhotoMode(true)} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
            📷 Modo foto
          </button>
          <span
            className="hidden sm:inline-flex items-center gap-1 rounded-md border border-dashed border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-muted)]"
            title={
              "Atajos en el grid:\n" +
              "  Esc → salir de edición\n" +
              "  Shift+Click en filas → seleccionar rango\n" +
              "  Ctrl+D → copiar valor de la celda focuseada a las filas seleccionadas\n" +
              "  Ctrl+V → pegar columna desde portapapeles (una línea por fila)\n" +
              "  Ctrl+Z → deshacer último cambio (Ctrl+D y Ctrl+V se deshacen como uno)"
            }
          >
            ⌨ Atajos
          </span>
        </div>
      </div>

      {/* Metrics */}
      <button
        type="button"
        onClick={() => setMetricsCollapsed((v) => !v)}
        className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-muted)] hover:text-[var(--color-accent)]"
        title={metricsCollapsed ? "Mostrar métricas" : "Ocultar métricas"}
      >
        <span>{metricsCollapsed ? "▶" : "▼"}</span>
        <span>Métricas</span>
      </button>
      {!metricsCollapsed && (
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cycle.labors.map((l) => {
          const isCo = l.type === "cosecha";
          const isTr = l.type === "trato";
          const isHE = l.type === "tratoHE";
          const totalAmt = totalsByLabor[l.id] || 0;
          const qtyByContainer = totalQtyByContainerByLabor[l.id] || {};
          const totalQty = totalQtyByLabor[l.id] || 0;
          const heMetrics = tratoHEMetricsByLabor[l.id];
          const pisoMetrics = pisoMetricsByLabor[l.id] || { count: 0, amount: 0 };
          const tag = isCo ? "cosecha" : isTr ? "trato" : isHE ? "jornadas+HE" : l.type === "main" ? "al día" : l.type;
          const tagClass = isCo
            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
            : isTr
              ? "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400"
              : isHE
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                : "bg-[var(--color-surface-2)]";
          return (
            <button
              type="button"
              key={l.id}
              onClick={() => setActiveLaborId(l.id)}
              className={`rounded-lg border bg-[var(--color-surface)] p-3 shadow-sm text-left transition-all hover:border-[var(--color-accent)] hover:shadow-md ${
                l.id === activeLabor?.id ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent-soft)]" : "border-[var(--color-border)]"
              }`}
            >
              <div className="flex items-center justify-between text-xs text-[var(--color-muted)]">
                <span>{l.name}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${tagClass}`}>{tag}</span>
              </div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{fmtCurrency(totalAmt)}</div>
              {isCo && Object.keys(qtyByContainer).length > 0 && (
                <div className="mt-0.5 text-[11px] text-[var(--color-muted)] tabular-nums">
                  {Object.entries(qtyByContainer)
                    .filter(([, qty]) => qty > 0)
                    .map(([y, qty]) => `${qty.toLocaleString("es-CL")} ${containerLabel(catalogs, Number(y))}`)
                    .join(" · ")}
                </div>
              )}
              {isTr && (
                <div className="mt-1 space-y-0.5 text-[11px] tabular-nums">
                  <div className="text-[var(--color-muted)]">
                    {tratoTypeLabel(catalogs, l.tratoType ?? 0)} · {totalQty.toLocaleString("es-CL")} unid.
                  </div>
                  {tratoTierMetricsByLabor[l.id] && Object.keys(tratoTierMetricsByLabor[l.id]).length > 1 && (
                    <div className="mt-0.5 space-y-0">
                      {Object.entries(tratoTierMetricsByLabor[l.id])
                        .sort(([a], [b]) => Number(a) - Number(b))
                        .map(([idx, tm]) => (
                          <div key={idx} className="flex justify-between gap-2 text-[var(--color-muted)]">
                            <span>Precio {Number(idx) + 1}:</span>
                            <span>
                              {tm.qty.toLocaleString("es-CL")} unid. · {fmtCurrency(tm.amount)}
                            </span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
              {(isCo || isTr) && pisoMetrics.count > 0 && (
                <div className="mt-1 flex justify-between gap-2 text-[11px] tabular-nums">
                  <span className="text-[var(--color-muted)]">🪙 Pisos:</span>
                  <span>
                    <span className="font-medium">{pisoMetrics.count}</span>
                    <span className="text-[var(--color-muted)]"> jorn. · </span>
                    <span className="font-medium">{fmtCurrency(pisoMetrics.amount)}</span>
                  </span>
                </div>
              )}
              {isHE && heMetrics && (
                <div className="mt-1 space-y-0.5 text-[11px] tabular-nums">
                  <div className="flex justify-between gap-2">
                    <span className="text-[var(--color-muted)]">Base:</span>
                    <span>
                      <span className="font-medium">{fmtCurrency(heMetrics.normalQty)}</span>
                      <span className="text-[var(--color-muted)]"> norm.</span>
                      {heMetrics.holidayQty > 0 && (
                        <span className="ml-1 text-[var(--color-danger)]">
                          + {fmtCurrency(heMetrics.holidayQty)} fer.
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-[var(--color-muted)]">Horas extras:</span>
                    <span>
                      <span className="font-medium">{heMetrics.normalHE.toLocaleString("es-CL")}h</span>
                      <span className="text-[var(--color-muted)]"> norm.</span>
                      {heMetrics.holidayHE > 0 && (
                        <span className="ml-1 text-[var(--color-danger)]">
                          + {heMetrics.holidayHE.toLocaleString("es-CL")}h fer.
                        </span>
                      )}
                    </span>
                  </div>
                  {heMetrics.workersWithBonus > 0 && (
                    <div className="flex justify-between gap-2 text-[var(--color-muted)]">
                      <span>Con bonos:</span>
                      <span>{heMetrics.workersWithBonus} trab.</span>
                    </div>
                  )}
                </div>
              )}
            </button>
          );
        })}
        {(transportTotal > 0 || cycleTrips.length > 0) && (
          <button
            type="button"
            onClick={() => setTransportsOpen(true)}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-sm text-left transition-all hover:border-[var(--color-accent)] hover:shadow-md"
          >
            <div className="flex items-center justify-between text-xs text-[var(--color-muted)]">
              <span>Transporte</span>
              <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">🚐 transp.</span>
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{fmtCurrency(transportTotal)}</div>
            <div className="mt-0.5 text-[11px] text-[var(--color-muted)] tabular-nums">
              {cycleTrips.length} vuelta{cycleTrips.length === 1 ? "" : "s"}
            </div>
          </button>
        )}
        <div className="rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-3 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wider text-[var(--color-accent)]">Total ciclo</div>
          <div className="mt-1 text-lg font-bold tabular-nums text-[var(--color-accent)]">{fmtCurrency(grandTotal)}</div>
        </div>
      </div>
      )}

      {/* Labor tabs */}
      <div className="mb-3 flex flex-wrap items-center gap-1 border-b border-[var(--color-border)]">
        {cycle.labors.map((l) => {
          const isActive = l.id === activeLabor?.id;
          const isCo = l.type === "cosecha";
          const isTr = l.type === "trato";
          const isHE = l.type === "tratoHE";
          const tagClass = isCo
            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
            : isTr
              ? "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400"
              : isHE
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                : "bg-[var(--color-surface-2)] text-[var(--color-muted)]";
          const tagIcon = isCo ? "🌾" : isTr ? "🛠" : isHE ? "⏱" : l.type === "main" ? "al día" : l.type;
          return (
            <button
              key={l.id}
              onClick={() => setActiveLaborId(l.id)}
              className={`relative px-4 py-2 text-sm transition-colors ${
                isActive ? "font-medium text-[var(--color-accent)]" : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              {l.name}
              <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] ${tagClass}`}>{tagIcon}</span>
              {isActive && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-[var(--color-accent)]" />}
            </button>
          );
        })}
        <button
          onClick={openCreateLabor}
          disabled={readOnly}
          className="ml-2 rounded-md border border-dashed border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
        >
          + Labor
        </button>
      </div>

      {activeLabor && (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-[var(--color-muted)]">
              {workers.length} trabajadores · {days.length} días
              {!isQtyLabor && (
                <span className="ml-3 text-[var(--color-muted)]/70">
                  Tip: usa <code className="rounded bg-[var(--color-surface-2)] px-1">=350*54</code> para fórmulas.
                </span>
              )}
              {isCosechaLabor && (
                <span className="ml-3 text-[var(--color-muted)]/70">
                  Cosecha · default {defaultMode === "flat" ? "día fijo" : "por unidad"} · agrega tipos por día abajo
                </span>
              )}
              {isTratoLabor && (
                <span className="ml-3 text-[var(--color-muted)]/70">
                  Trato · {tratoTypeLabel(catalogs, activeLabor.tratoType ?? 0)} · ingresa cantidad y precio del día
                </span>
              )}
              {isTratoHELabor && (
                <span className="ml-3 text-[var(--color-muted)]/70">
                  Trato + HE · base ${(activeLabor.baseDayDefault ?? DEFAULT_BASE_DAY).toLocaleString("es-CL")} · HE ${(activeLabor.overtimeRate ?? DEFAULT_OVERTIME_RATE).toLocaleString("es-CL")}/h · bonos M ${(activeLabor.bonusManejo ?? DEFAULT_BONUS_MANEJO).toLocaleString("es-CL")} / S ${(activeLabor.bonusSupervision ?? DEFAULT_BONUS_SUPERVISION).toLocaleString("es-CL")}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {isTratoHELabor && (
                <>
                  <div className="flex rounded-md overflow-hidden border border-[var(--color-border)] text-xs">
                    <button
                      onClick={() => setTratoHEView("detalle")}
                      className={`px-3 py-1.5 transition-colors ${
                        tratoHEView === "detalle"
                          ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-medium"
                          : "bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
                      }`}
                    >
                      Detalle
                    </button>
                    <button
                      onClick={() => setTratoHEView("resumen")}
                      className={`px-3 py-1.5 transition-colors ${
                        tratoHEView === "resumen"
                          ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-medium"
                          : "bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
                      }`}
                    >
                      Resumen
                    </button>
                  </div>
                  <button onClick={() => setDefaultLeadersOpen(true)} disabled={readOnly} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-40">
                    ⚑ Líderes / Manejo
                  </button>
                </>
              )}
              {isCosechaLabor && (
                <div className="flex rounded-md overflow-hidden border border-[var(--color-border)] text-xs">
                  <button
                    onClick={() => setCosechaView("detalle")}
                    className={`px-3 py-1.5 transition-colors ${
                      cosechaView === "detalle"
                        ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-medium"
                        : "bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
                    }`}
                  >
                    Detalle
                  </button>
                  <button
                    onClick={() => setCosechaView("resumen")}
                    className={`px-3 py-1.5 transition-colors ${
                      cosechaView === "resumen"
                        ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-medium"
                        : "bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
                    }`}
                  >
                    Resumen
                  </button>
                </div>
              )}
              {isTratoLabor && (
                <div className="flex rounded-md overflow-hidden border border-[var(--color-border)] text-xs">
                  <button
                    onClick={() => setTratoView("detalle")}
                    className={`px-3 py-1.5 transition-colors ${
                      tratoView === "detalle"
                        ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-medium"
                        : "bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
                    }`}
                  >
                    Detalle
                  </button>
                  <button
                    onClick={() => setTratoView("resumen")}
                    className={`px-3 py-1.5 transition-colors ${
                      tratoView === "resumen"
                        ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-medium"
                        : "bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
                    }`}
                  >
                    Resumen
                  </button>
                </div>
              )}
              <button onClick={openEditLabor} disabled={readOnly} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-40">
                Editar labor
              </button>
              <button onClick={askRemoveLabor} disabled={readOnly || cycle.labors.length === 1} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] disabled:opacity-40">
                Quitar labor
              </button>
              <button onClick={() => setAddDayOpen(true)} disabled={readOnly} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-50">
                + Día
              </button>
              <button onClick={() => setPickerOpen(true)} disabled={readOnly} className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] shadow-sm hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
                + Trabajador
              </button>
            </div>
          </div>

          {days.length > 0 && !readOnly && (
            <div className="mb-2 flex flex-wrap gap-1">
              {days.map((d) => (
                <button
                  key={d}
                  onClick={() => removeDay(d)}
                  className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-0.5 text-xs text-[var(--color-muted)] hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
                  title="Click para quitar columna (solo si ninguna labor tiene producción ese día)"
                >
                  {d} ✕
                </button>
              ))}
            </div>
          )}

          {/* Cosecha price bar */}
          {isCosechaLabor && days.length > 0 && (
            <div className={`mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] ${pricesCollapsed ? "px-3 py-1.5" : "p-3"}`}>
              <button
                type="button"
                onClick={() => setPricesCollapsed((v) => !v)}
                className="flex w-full items-center gap-2 text-left text-xs font-medium text-[var(--color-muted)] uppercase tracking-wider hover:text-[var(--color-accent)]"
                title={pricesCollapsed ? "Mostrar precios" : "Ocultar precios"}
              >
                <span>{pricesCollapsed ? "▶" : "▼"}</span>
                <span>🌾</span>
                <span>Precios por día y tipo</span>
                {readOnly && <span className="text-[var(--color-warning)]">solo lectura</span>}
              </button>
              {!pricesCollapsed && (
              <div className="mt-2 flex flex-wrap gap-2">
                {days.map((d) => {
                  const combos = dayCombosByDate[d] || [];
                  return (
                    <div key={d} className="flex flex-col gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 text-xs min-w-[200px]">
                      <div className="font-medium text-[var(--color-text)]">{d}</div>
                      {combos.map((c) => {
                        const totalQty = totalQtyByDayCombo[d]?.[c.key] || 0;
                        const workersWithQty = workers.filter(
                          (w) => (wdMap[workdayMapKey(w.rut, d, c.key)]?.qty || 0) > 0,
                        ).length;
                        const totalAmt = c.mode === "flat" ? c.price * workersWithQty : totalQty * c.price;
                        return (
                          <div
                            key={c.key}
                            className={`flex flex-col gap-1 rounded-md border px-2 py-1.5 ${
                              c.price > 0
                                ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                                : "border-[var(--color-border)] bg-[var(--color-surface)]"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="font-medium text-[var(--color-text)]">
                                {comboLabel(catalogs, c.x, c.y)}
                              </span>
                              {!readOnly && (
                                <button
                                  onClick={() =>
                                    setRemoveCombo({
                                      laborId: activeLabor.id, date: d, comboKey: c.key,
                                      label: comboLabel(catalogs, c.x, c.y),
                                    })
                                  }
                                  className="text-[10px] text-[var(--color-muted)] hover:text-[var(--color-danger)]"
                                  title="Quitar tipo"
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                            <div className="text-[10px] text-[var(--color-muted)]">
                              {totalQty.toLocaleString("es-CL")} {containerLabel(catalogs, c.y)}
                            </div>
                            <div className="flex rounded-md overflow-hidden border border-[var(--color-border)] text-[10px]">
                              <button
                                disabled={readOnly}
                                onClick={() => persistComboConfig(activeLabor.id, d, c.key, { mode: "unit" }, false)}
                                className={`flex-1 px-1 py-0.5 transition-colors ${
                                  c.mode === "unit"
                                    ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-medium"
                                    : "bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
                                } disabled:opacity-50`}
                              >
                                $/unidad
                              </button>
                              <button
                                disabled={readOnly}
                                onClick={() => persistComboConfig(activeLabor.id, d, c.key, { mode: "flat" }, false)}
                                className={`flex-1 px-1 py-0.5 transition-colors ${
                                  c.mode === "flat"
                                    ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-medium"
                                    : "bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
                                } disabled:opacity-50`}
                              >
                                $/día
                              </button>
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-[var(--color-muted)]">$</span>
                              <input
                                type="number" min="0" disabled={readOnly}
                                value={getPriceInputValue(activeLabor.id, d, c.key)}
                                onChange={(e) =>
                                  setLocalPriceInputs((prev) => ({
                                    ...prev,
                                    [inputKey(activeLabor.id, d, c.key)]: e.target.value,
                                  }))
                                }
                                onBlur={() => handlePriceBlur(activeLabor.id, d, c.key)}
                                placeholder={c.mode === "flat" ? "tarifa/trab." : `precio/${containerLabel(catalogs, c.y)}`}
                                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-right tabular-nums outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
                              />
                            </div>
                            {totalAmt > 0 && (
                              <div className="text-[var(--color-accent)] text-[10px] font-medium tabular-nums">
                                = {fmtCurrency(totalAmt)}
                                {c.mode === "flat" && workersWithQty > 0 && (
                                  <span className="ml-1 font-normal text-[var(--color-muted)]">({workersWithQty} trab.)</span>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      <button
                        onClick={() => setAddComboFor({ laborId: activeLabor.id, date: d })}
                        disabled={readOnly}
                        className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
                      >
                        + tipo
                      </button>
                      <PisoDayRow
                        labor={activeLabor}
                        dayPrices={dayPrices}
                        date={d}
                        readOnly={readOnly}
                        onPersist={(v) => persistDayPiso(activeLabor.id, d, v)}
                      />
                    </div>
                  );
                })}
              </div>
              )}
            </div>
          )}

          {/* TratoHE price bar */}
          {isTratoHELabor && days.length > 0 && (
            <div className={`mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] ${pricesCollapsed ? "px-3 py-1.5" : "p-3"}`}>
              <button
                type="button"
                onClick={() => setPricesCollapsed((v) => !v)}
                className="flex w-full items-center gap-2 text-left text-xs font-medium text-[var(--color-muted)] uppercase tracking-wider hover:text-[var(--color-accent)]"
                title={pricesCollapsed ? "Mostrar precios" : "Ocultar precios"}
              >
                <span>{pricesCollapsed ? "▶" : "▼"}</span>
                <span>🛠</span>
                <span>Configuración por día</span>
                {readOnly && <span className="text-[var(--color-warning)]">solo lectura</span>}
              </button>
              {!pricesCollapsed && (
              <div className="mt-2 flex flex-wrap gap-2">
                {days.map((d) => {
                  const cfg = getDaySingle(dayPrices, activeLabor.id, d, "normal");
                  const red = isRedDay(d, cfg);
                  const isWeekend = isWeekendDate(d);
                  return (
                    <div
                      key={d}
                      className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-xs min-w-[200px] ${
                        red ? "border-[var(--color-danger)] bg-[var(--color-danger-soft)]" : "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                      }`}
                    >
                      <button
                        onClick={() => !readOnly && setDayModeEdit({ laborId: activeLabor.id, date: d })}
                        disabled={readOnly}
                        className="flex items-center justify-between gap-2 text-left disabled:opacity-60"
                        title="Editar configuración del día"
                      >
                        <span className="font-medium text-[var(--color-text)]">
                          {d}
                          {cfg.isHoliday && <span className="ml-1">🎉</span>}
                          {!cfg.isHoliday && isWeekend && <span className="ml-1 text-[var(--color-danger)]">·</span>}
                        </span>
                        <span className="text-[10px] text-[var(--color-muted)] hover:text-[var(--color-accent)]">editar</span>
                      </button>
                      <div className="text-[10px] text-[var(--color-muted)]">
                        Base: ${(cfg.price || activeLabor.baseDayDefault || DEFAULT_BASE_DAY).toLocaleString("es-CL")}
                      </div>
                      <div className="text-[10px]">
                        {cfg.mode === "overtimeOnly" ? (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">solo HE</span>
                        ) : (
                          <span className="text-[var(--color-muted)]">jornada normal</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              )}
            </div>
          )}

          {/* Trato price bar */}
          {isTratoLabor && days.length > 0 && (
            <div className={`mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] ${pricesCollapsed ? "px-3 py-1.5" : "p-3"}`}>
              <button
                type="button"
                onClick={() => setPricesCollapsed((v) => !v)}
                className="flex w-full items-center gap-2 text-left text-xs font-medium text-[var(--color-muted)] uppercase tracking-wider hover:text-[var(--color-accent)]"
                title={pricesCollapsed ? "Mostrar precios" : "Ocultar precios"}
              >
                <span>{pricesCollapsed ? "▶" : "▼"}</span>
                <span>🛠</span>
                <span>Precios por día · {tratoTypeLabel(catalogs, activeLabor.tratoType ?? 0)}</span>
                {readOnly && <span className="text-[var(--color-warning)]">solo lectura</span>}
              </button>
              {!pricesCollapsed && (
              <div className="mt-2 flex flex-wrap gap-2">
                {days.map((d) => {
                  const tiers = dayTiersByDate[d] || [];
                  // Calculate total qty and amount from workday records
                  let totalQty = 0, totalAmt = 0;
                  for (const w of workers) {
                    for (const t of tiers) {
                      const wd = wdMap[workdayMapKey(w.rut, d, t.key)];
                      totalQty += Number(wd?.qty) || 0;
                      totalAmt += Number(wd?.amount) || 0;
                    }
                  }
                  return (
                    <div
                      key={d}
                      className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-xs ${
                        tiers.length > 0 && tiers.some((t) => t.price > 0)
                          ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                          : "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[var(--color-text)]">{d}</span>
                        {totalQty > 0 && <span className="text-[var(--color-muted)]">{totalQty.toLocaleString("es-CL")}</span>}
                      </div>
                      {tiers.map((t, i) => (
                        <div key={t.key} className="flex items-center gap-1 rounded-md bg-[var(--color-surface)] px-2 py-1">
                          <span className="text-[var(--color-muted)] text-[10px] w-12">P{i + 1}</span>
                          <span className="text-[var(--color-muted)]">$</span>
                          <input
                            type="number" min="0" disabled={readOnly}
                            value={getPriceInputValue(activeLabor.id, d, t.key, true)}
                            onChange={(e) =>
                              setLocalPriceInputs((prev) => ({
                                ...prev,
                                [inputKey(activeLabor.id, d, t.key)]: e.target.value,
                              }))
                            }
                            onBlur={() => handlePriceBlur(activeLabor.id, d, t.key, true)}
                            placeholder="precio"
                            className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-right text-[10px] tabular-nums outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
                          />
                          {/* Selector de unidad del trato — se guarda junto
                              al precio del tier. "—" = sin unidad (display
                              cae a vacío, compat con datos antes del feature). */}
                          <select
                            disabled={readOnly}
                            value={t.unit == null ? "" : String(t.unit)}
                            onChange={(e) => {
                              const v = e.target.value;
                              persistComboConfig(
                                activeLabor.id,
                                d,
                                t.key,
                                { unit: v === "" ? null : Number(v) },
                                true,
                              );
                            }}
                            title="Unidad de medida — qué representa cada qty (Metro, Polín, Planta, etc.)"
                            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[10px] outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
                          >
                            <option value="">—</option>
                            {(catalogs.tratoUnits || []).map((u) => (
                              <option key={u.value} value={u.value}>{u.label}</option>
                            ))}
                          </select>
                          <div className="flex overflow-hidden rounded border border-[var(--color-border)] text-[10px]">
                            <button
                              disabled={readOnly}
                              onClick={() => persistComboConfig(activeLabor.id, d, t.key, { mode: "unit" }, true)}
                              title="Por unidad (qty × precio)"
                              className={`px-1.5 py-0.5 transition-colors disabled:opacity-50 ${
                                t.mode === "unit"
                                  ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-medium"
                                  : "bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
                              }`}
                            >
                              /unid
                            </button>
                            <button
                              disabled={readOnly}
                              onClick={() => persistComboConfig(activeLabor.id, d, t.key, { mode: "flat" }, true)}
                              title="Pago al día (qty informativo)"
                              className={`px-1.5 py-0.5 transition-colors disabled:opacity-50 border-l border-[var(--color-border)] ${
                                t.mode === "flat"
                                  ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-medium"
                                  : "bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
                              }`}
                            >
                              /día
                            </button>
                          </div>
                          {tiers.length > 1 && (
                            <button
                              disabled={readOnly}
                              onClick={async () => {
                                const newEntry = { ...dayPrices };
                                const dayEntry = { ...(newEntry[activeLabor.id]?.[d] || {}) };
                                delete dayEntry[t.key];
                                newEntry[activeLabor.id] = { ...(newEntry[activeLabor.id] || {}), [d]: dayEntry };
                                setDayPrices(newEntry);
                                await cyclesService.update(id, { dayPrices: newEntry });
                              }}
                              className="ml-auto text-[var(--color-danger)] text-[10px] hover:underline disabled:opacity-40"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      ))}
                      {!readOnly && (
                        <button
                          onClick={() =>
                            setAddPriceModal({
                              laborId: activeLabor.id,
                              date: d,
                              nextKey: `t${tiers.length}`,
                              defaultMode,
                              value: "",
                            })
                          }
                          className="text-[var(--color-accent)] text-[10px] hover:underline"
                        >
                          + Agregar precio
                        </button>
                      )}
                      {totalAmt > 0 && (
                        <div className="text-[var(--color-accent)] font-medium tabular-nums text-[11px]">
                          = {fmtCurrency(totalAmt)}
                        </div>
                      )}
                      <PisoDayRow
                        labor={activeLabor}
                        dayPrices={dayPrices}
                        date={d}
                        readOnly={readOnly}
                        onPersist={(v) => persistDayPiso(activeLabor.id, d, v)}
                      />
                    </div>
                  );
                })}
              </div>
              )}
            </div>
          )}

          {!photoMode && workers.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-border)] text-xs">
                <button
                  onClick={() => setGroupView("all")}
                  className={`px-3 py-1.5 ${groupView === "all" ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "bg-[var(--color-surface)] hover:bg-[var(--color-accent-soft)]"}`}
                >
                  Todos
                </button>
                <button
                  onClick={() => setGroupView("group")}
                  className={`px-3 py-1.5 ${groupView === "group" ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "bg-[var(--color-surface)] hover:bg-[var(--color-accent-soft)]"}`}
                >
                  Por grupo
                </button>
              </div>
              {useGrouped && orderedGroups.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {orderedGroups.map((g) => {
                    const isNone = g.key === LEADER_NONE;
                    return (
                      <button
                        key={g.key}
                        type="button"
                        onClick={() => scrollToGroup(g.key)}
                        className={`rounded-full border px-2.5 py-1 text-xs ${
                          isNone
                            ? "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
                            : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"
                        }`}
                      >
                        {g.label} · {g.count}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <ResizeHandle
            onPointerDown={onGridResizeStart}
            onDoubleClick={resetGridHeight}
          />
          <div style={{ height: `${gridHeight}px` }} className="flex min-h-0 flex-col">
            {grid}
          </div>
        </>
      )}

      {/* Modals */}
      <Modal
        open={!!editingDayNote}
        onClose={closeDayNote}
        title={editingDayNote ? `Anotación del ${editingDayNote}` : "Anotación"}
        footer={(
          <>
            <button
              type="button"
              onClick={closeDayNote}
              disabled={dayNoteBusy}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={saveDayNote}
              disabled={dayNoteBusy || readOnly}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
            >
              {dayNoteBusy ? "..." : "Guardar"}
            </button>
          </>
        )}
      >
        <textarea
          value={editingDayNoteText}
          onChange={(e) => setEditingDayNoteText(e.target.value)}
          disabled={readOnly}
          autoFocus
          placeholder="Ej: día con lluvia leve, solo media jornada, etc."
          rows={5}
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] disabled:opacity-70"
        />
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          La anotación es compartida entre todas las labores de este día. Dejar el campo vacío y guardar la elimina.
        </p>
      </Modal>

      <Modal
        open={!!addPriceModal}
        onClose={() => !addPriceBusy && setAddPriceModal(null)}
        title={addPriceModal ? `Nuevo precio · ${addPriceModal.date}` : "Nuevo precio"}
        size="sm"
        footer={(
          <>
            <button
              type="button"
              onClick={() => setAddPriceModal(null)}
              disabled={addPriceBusy}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!addPriceModal) return;
                const price = parseAmount(addPriceModal.value) || 0;
                if (price === 0) return;
                setAddPriceBusy(true);
                try {
                  await persistComboConfig(
                    addPriceModal.laborId,
                    addPriceModal.date,
                    addPriceModal.nextKey,
                    { price, mode: addPriceModal.defaultMode },
                    true,
                  );
                  setAddPriceModal(null);
                } finally {
                  setAddPriceBusy(false);
                }
              }}
              disabled={addPriceBusy || !(parseAmount(addPriceModal?.value) > 0)}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
            >
              {addPriceBusy ? "..." : "Agregar"}
            </button>
          </>
        )}
      >
        {addPriceModal && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const price = parseAmount(addPriceModal.value) || 0;
              if (price === 0 || addPriceBusy) return;
              (async () => {
                setAddPriceBusy(true);
                try {
                  await persistComboConfig(
                    addPriceModal.laborId,
                    addPriceModal.date,
                    addPriceModal.nextKey,
                    { price, mode: addPriceModal.defaultMode },
                    true,
                  );
                  setAddPriceModal(null);
                } finally {
                  setAddPriceBusy(false);
                }
              })();
            }}
            className="space-y-2"
          >
            <TextField
              label="Precio"
              required
              autoFocus
              placeholder="Ej: 1500"
              value={addPriceModal.value}
              onChange={(v) => setAddPriceModal((s) => (s ? { ...s, value: v } : s))}
            />
            <p className="text-[11px] text-[var(--color-muted)]">
              Se agrega como un nuevo tramo de precio para este día. Modo por defecto: {addPriceModal.defaultMode === "flat" ? "pago al día" : "por unidad"}.
            </p>
          </form>
        )}
      </Modal>

      <LeaderPickerModal
        open={!!leaderPickerFor}
        onClose={() => setLeaderPickerFor(null)}
        leaders={enabledLeaders}
        workerName={leaderPickerFor ? (allWorkers.find((w) => w.id === leaderPickerFor)?.name || leaderPickerFor) : ""}
        busy={groupBusy}
        onPick={async (leader) => {
          const rut = leaderPickerFor;
          setLeaderPickerFor(null);
          if (rut && leader) await assignLeaderToWorker(rut, leader);
        }}
      />
      <Modal
        open={addDayOpen}
        onClose={() => { setAddDayOpen(false); setSelectedDays(new Set()); }}
        title="Agregar días"
        size="md"
        footer={
          <>
            <button onClick={() => { setAddDayOpen(false); setSelectedDays(new Set()); }} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
              Cancelar
            </button>
            <button
              onClick={addSelectedDays}
              disabled={selectedDays.size === 0}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
            >
              {selectedDays.size === 0 ? "Agregar" : `Agregar ${selectedDays.size} día${selectedDays.size > 1 ? "s" : ""}`}
            </button>
          </>
        }
      >
        <DayCalendarPicker
          viewMonth={viewMonth}
          setViewMonth={setViewMonth}
          selectedDays={selectedDays}
          toggleDay={toggleSelectedDay}
          existingDays={days}
        />
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          Click sobre los días para seleccionar varios a la vez. Los días ya agregados aparecen en gris.
        </p>
      </Modal>

      <Modal
        open={!!laborForm}
        onClose={() => setLaborForm(null)}
        title={laborForm?.mode === "edit" ? "Editar labor" : "Nueva labor"}
      >
        {laborForm && (
          <form onSubmit={submitLabor} className="space-y-4">
            <TextField
              label="Nombre" required autoFocus
              value={laborForm.data.name}
              onChange={(v) => setLaborForm((s) => ({ ...s, data: { ...s.data, name: v } }))}
            />
            <Select
              label="Tipo" required
              value={laborForm.data.type}
              onChange={(v) => setLaborForm((s) => ({ ...s, data: { ...s.data, type: v } }))}
              options={LABOR_TYPES}
            />
            {laborForm.data.type === "cosecha" && (
              <Select
                label="Modo por defecto al agregar tipos"
                value={laborForm.data.cosechaMode}
                onChange={(v) => setLaborForm((s) => ({ ...s, data: { ...s.data, cosechaMode: v } }))}
                options={COSECHA_MODES}
              />
            )}
            {laborForm.data.type === "trato" && (
              <>
                <Select
                  label="Tipo de trato"
                  value={laborForm.data.tratoType}
                  onChange={(v) => setLaborForm((s) => ({ ...s, data: { ...s.data, tratoType: Number(v) } }))}
                  options={(catalogs.tratoTypes || []).map((t) => ({ value: t.value, label: t.label }))}
                />
                <p className="text-xs text-[var(--color-muted)]">
                  ¿No está en la lista? Agrégalo desde el botón ⚙ Catálogos.
                </p>
                <Select
                  label="Modo por defecto"
                  value={laborForm.data.tratoMode}
                  onChange={(v) => setLaborForm((s) => ({ ...s, data: { ...s.data, tratoMode: v } }))}
                  options={COSECHA_MODES}
                />
              </>
            )}
            {laborForm.data.type === "tratoHE" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  label="Base diaria default ($)" type="number"
                  value={laborForm.data.baseDayDefault}
                  onChange={(v) => setLaborForm((s) => ({ ...s, data: { ...s.data, baseDayDefault: v } }))}
                />
                <TextField
                  label="Tarifa hora extra ($/h)" type="number"
                  value={laborForm.data.overtimeRate}
                  onChange={(v) => setLaborForm((s) => ({ ...s, data: { ...s.data, overtimeRate: v } }))}
                />
                <TextField
                  label="Bono manejo ($)" type="number"
                  value={laborForm.data.bonusManejo}
                  onChange={(v) => setLaborForm((s) => ({ ...s, data: { ...s.data, bonusManejo: v } }))}
                />
                <TextField
                  label="Bono supervisión/líder ($)" type="number"
                  value={laborForm.data.bonusSupervision}
                  onChange={(v) => setLaborForm((s) => ({ ...s, data: { ...s.data, bonusSupervision: v } }))}
                />
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setLaborForm(null)} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm hover:bg-[var(--color-accent-soft)]">
                Cancelar
              </button>
              <button type="submit" className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]">
                Guardar
              </button>
            </div>
          </form>
        )}
      </Modal>

      <WorkerPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={pickWorker}
        excludeRuts={workers.map((w) => w.rut)}
        allowTemp
        availableLeaders={enabledLeaders}
      />

      <WorkerPickerModal
        open={!!assignTempRut}
        onClose={() => !assignBusy && setAssignTempRut(null)}
        onPick={convertTempToReal}
        excludeRuts={workers.filter((w) => w.rut !== assignTempRut).map((w) => w.rut)}
        allowTemp={false}
        title="Asignar RUT al trabajador temporal"
        availableLeaders={enabledLeaders}
      />

      <ConfirmDialog
        open={!!removeWorker}
        title="Quitar trabajador"
        message={
          removeWorker
            ? removeWorker.isTemp
              ? `¿Eliminar al trabajador temporal "${removeWorker.name}"? Se borrará junto con toda la producción cargada en este ciclo.`
              : `¿Quitar a ${removeWorker.name} de "${activeLabor?.name}"?`
            : ""
        }
        confirmLabel="Quitar"
        danger busy={removeBusy}
        onCancel={() => !removeBusy && setRemoveWorker(null)}
        onConfirm={confirmRemoveWorker}
      />

      <ConfirmDialog
        open={!!removeLabor}
        title="Quitar labor"
        message={removeLabor ? `¿Quitar la labor "${removeLabor.name}"? Solo si no tiene producción.` : ""}
        confirmLabel="Quitar"
        danger
        onCancel={() => setRemoveLabor(null)}
        onConfirm={confirmRemoveLabor}
      />

      <ConfirmDialog
        open={closeFlow}
        title="Cerrar ciclo"
        message={`¿Cerrar "${cycle.label}"? No se podrá editar a menos que seas admin.`}
        confirmLabel="Cerrar ciclo"
        danger busy={closeBusy}
        onCancel={() => !closeBusy && setCloseFlow(false)}
        onConfirm={handleCloseCycle}
      />

      <ConfirmDialog
        open={!!removeCombo}
        title="Quitar tipo de cosecha"
        message={removeCombo ? `¿Quitar "${removeCombo.label}" del día ${removeCombo.date}?` : ""}
        confirmLabel="Quitar"
        danger
        onCancel={() => setRemoveCombo(null)}
        onConfirm={async () => {
          if (!removeCombo) return;
          await removeComboFromDay(removeCombo.laborId, removeCombo.date, removeCombo.comboKey);
          setRemoveCombo(null);
        }}
      />

      <AddComboModal
        open={!!addComboFor}
        onClose={() => setAddComboFor(null)}
        catalogs={catalogs}
        existingCombos={addComboFor ? (dayCombosByDate[addComboFor.date] || []) : []}
        date={addComboFor?.date}
        onAddCatalogEntry={addCatalogEntry}
        onAdd={async (x, y) => {
          if (!addComboFor) return;
          await addComboToDay(addComboFor.laborId, addComboFor.date, x, y);
          setAddComboFor(null);
        }}
      />

      <CatalogsModal
        open={catalogsOpen}
        onClose={() => setCatalogsOpen(false)}
        catalogs={catalogs}
        onAddEntry={addCatalogEntry}
        onRenameEntry={renameCatalogEntry}
      />

      <BonusEditModal
        open={!!bonusEdit}
        onClose={() => setBonusEdit(null)}
        labor={activeLabor}
        wd={bonusEdit ? (workdaysByLabor[bonusEdit.laborId] || {})[workdayMapKey(bonusEdit.workerRut, bonusEdit.date, SINGLE_COMBO)] : null}
        workerName={bonusEdit ? workers.find((w) => w.rut === bonusEdit.workerRut)?.name : ""}
        date={bonusEdit?.date}
        readOnly={readOnly}
        onSave={async (patch) => {
          if (!bonusEdit) return;
          await upsertTratoHEWorkday(bonusEdit.laborId, bonusEdit.date, bonusEdit.workerRut, patch);
          setBonusEdit(null);
        }}
      />

      <DayModeModal
        open={!!dayModeEdit}
        onClose={() => setDayModeEdit(null)}
        date={dayModeEdit?.date}
        labor={activeLabor}
        cfg={dayModeEdit ? getDaySingle(dayPrices, dayModeEdit.laborId, dayModeEdit.date, "normal") : null}
        readOnly={readOnly}
        onSave={async (patch) => {
          if (!dayModeEdit) return;
          await persistTratoHEDay(dayModeEdit.laborId, dayModeEdit.date, patch);
          setDayModeEdit(null);
        }}
      />

      <DefaultLeadersModal
        open={defaultLeadersOpen}
        onClose={() => setDefaultLeadersOpen(false)}
        labor={activeLabor}
        readOnly={readOnly}
        onSave={async (defaults) => {
          if (!activeLabor) return;
          await persistTratoHEBonusDefaults(activeLabor.id, defaults);
          setDefaultLeadersOpen(false);
        }}
      />

      <TransportsModal
        open={transportsOpen}
        onClose={async () => {
          setTransportsOpen(false);
          await reloadTransports();
        }}
        cycle={cycle}
        faena={faena}
        subfaena={subfaena}
        days={days}
        readOnly={readOnly}
      />

      <CycleSummaryModal
        open={summaryOpen}
        onClose={() => setSummaryOpen(false)}
        cycle={cycle}
        workdaysByLabor={workdaysByLabor}
        dayPrices={dayPrices}
        catalogs={catalogs}
        faena={faena}
        subfaena={subfaena}
      />

      <WorkerEditModal
        open={!!editingWorkerRut}
        mode="edit"
        worker={editingWorkerRut ? allWorkers.find((w) => w.id === editingWorkerRut) : null}
        allWorkers={allWorkers}
        onClose={() => setEditingWorkerRut(null)}
        onSaved={async () => {
          const rut = editingWorkerRut;
          setEditingWorkerRut(null);
          if (!rut) return;
          // Refetch para que el grid (vía rutToName + rutToLeader) vea los
          // cambios sin tener que recargar la pantalla. La caché aditiva
          // ya tiene el doc actualizado, pero el state local de CycleDetail
          // necesita el sync explícito.
          try {
            const updated = await workersService.getById(rut);
            if (updated) {
              setAllWorkers((prev) => {
                const idx = prev.findIndex((w) => w.id === rut);
                if (idx === -1) return [...prev, updated];
                const next = prev.slice();
                next[idx] = updated;
                return next;
              });
            }
          } catch {
            /* noop */
          }
        }}
      />

      {copyToast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] shadow-lg">
          {copyToast}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================

function AddComboModal({ open, onClose, catalogs, existingCombos, date, onAdd, onAddCatalogEntry }) {
  const qualities = catalogs.qualities || [];
  const containers = catalogs.containers || [];
  const [x, setX] = useState(qualities[0]?.value ?? 0);
  const [y, setY] = useState(containers[0]?.value ?? 0);
  const [newQuality, setNewQuality] = useState("");
  const [newContainer, setNewContainer] = useState("");
  const [showNewQ, setShowNewQ] = useState(false);
  const [showNewC, setShowNewC] = useState(false);

  useEffect(() => {
    if (open) {
      setX(qualities[0]?.value ?? 0);
      setY(containers[0]?.value ?? 0);
      setNewQuality(""); setNewContainer("");
      setShowNewQ(false); setShowNewC(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const existingKeys = new Set(existingCombos.map((c) => c.key));
  const targetKey = `${x}_${y}`;
  const duplicate = existingKeys.has(targetKey);

  const handleAddQuality = async () => {
    if (!newQuality.trim()) return;
    const newVal = await onAddCatalogEntry("qualities", newQuality);
    if (newVal != null) setX(newVal);
    setNewQuality(""); setShowNewQ(false);
  };

  const handleAddContainer = async () => {
    if (!newContainer.trim()) return;
    const newVal = await onAddCatalogEntry("containers", newContainer);
    if (newVal != null) setY(newVal);
    setNewContainer(""); setShowNewC(false);
  };

  return (
    <Modal open={open} onClose={onClose} title={`Agregar tipo de cosecha · ${date || ""}`}>
      <div className="space-y-4">
        <div>
          <Select
            label="Calidad" value={x} onChange={(v) => setX(Number(v))}
            options={qualities.map((q) => ({ value: q.value, label: q.label }))}
          />
          {!showNewQ ? (
            <button type="button" onClick={() => setShowNewQ(true)} className="mt-1 text-xs text-[var(--color-accent)] hover:underline">
              + Nueva calidad
            </button>
          ) : (
            <div className="mt-2 flex gap-2">
              <input
                value={newQuality} onChange={(e) => setNewQuality(e.target.value)}
                placeholder="Ej: Premium"
                className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
              />
              <button type="button" onClick={handleAddQuality} className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent-fg)]">
                Agregar
              </button>
              <button type="button" onClick={() => setShowNewQ(false)} className="text-xs text-[var(--color-muted)]">
                Cancelar
              </button>
            </div>
          )}
        </div>

        <div>
          <Select
            label="Envase / unidad" value={y} onChange={(v) => setY(Number(v))}
            options={containers.map((c) => ({ value: c.value, label: c.label }))}
          />
          {!showNewC ? (
            <button type="button" onClick={() => setShowNewC(true)} className="mt-1 text-xs text-[var(--color-accent)] hover:underline">
              + Nuevo envase
            </button>
          ) : (
            <div className="mt-2 flex gap-2">
              <input
                value={newContainer} onChange={(e) => setNewContainer(e.target.value)}
                placeholder="Ej: caja"
                className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
              />
              <button type="button" onClick={handleAddContainer} className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-accent-fg)]">
                Agregar
              </button>
              <button type="button" onClick={() => setShowNewC(false)} className="text-xs text-[var(--color-muted)]">
                Cancelar
              </button>
            </div>
          )}
        </div>

        {duplicate && (
          <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-2 py-1 text-xs text-[var(--color-warning)]">
            Este combo ya existe para este día.
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm hover:bg-[var(--color-accent-soft)]">
            Cancelar
          </button>
          <button
            onClick={() => onAdd(x, y)}
            disabled={duplicate}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            Agregar tipo
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CatalogsModal({ open, onClose, catalogs, onAddEntry, onRenameEntry }) {
  return (
    <Modal open={open} onClose={onClose} title="Catálogos globales" size="xl">
      <p className="mb-5 text-sm text-[var(--color-muted)]">
        Estos catálogos son compartidos por toda la aplicación. Cualquier supervisor puede
        agregar entradas; renombrar afecta los datos históricos (los workdays guardan el
        número de índice, no el label).
      </p>

      <CatalogGroup
        emoji="🫐"
        title="Cosecha"
        description="Definen cómo se clasifica cada kilo cosechado: a qué calidad y en qué envase se midió. Aparecen como selectores al cargar producción de una labor de tipo cosecha, y se muestran en los resúmenes y comprobantes."
      >
        <CatalogSection
          title="Calidades"
          subtitle="Categoría comercial de cada kilo (Exportación, IQF, Repaso, Consumo, Semilla…)"
          field="qualities" entries={catalogs.qualities || []}
          onAddEntry={onAddEntry} onRenameEntry={onRenameEntry}
        />
        <CatalogSection
          title="Envases"
          subtitle="Recipiente donde se midió (saco, capacho, bandeja, kilo). Define la unidad en los resúmenes."
          field="containers" entries={catalogs.containers || []}
          onAddEntry={onAddEntry} onRenameEntry={onRenameEntry}
        />
      </CatalogGroup>

      <CatalogGroup
        emoji="✂️"
        title="Trato"
        description="Definen qué se hace a trato (poda, amarre…) y cómo se cuenta el qty diario (por metro, por polín, por planta…). Aparecen en la configuración de la labor y, la unidad, junto al precio por día."
      >
        <CatalogSection
          title="Tipos de trato"
          subtitle="Etiqueta de la labor a trato (Poda, Amarre, Desmalezado, Carpas…). Se elige al crear/editar una labor de tipo trato."
          field="tratoTypes" entries={catalogs.tratoTypes || []}
          onAddEntry={onAddEntry} onRenameEntry={onRenameEntry}
        />
        <CatalogSection
          title="Unidades de trato"
          subtitle="Qué representa el qty cada día (Metro, Polín, Planta, Hilera…). Se elige junto al precio en el panel de Precios por día."
          field="tratoUnits" entries={catalogs.tratoUnits || []}
          onAddEntry={onAddEntry} onRenameEntry={onRenameEntry}
        />
      </CatalogGroup>

      <div className="mt-6 flex justify-end">
        <button onClick={onClose} className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]">
          Cerrar
        </button>
      </div>
    </Modal>
  );
}

function CatalogSection({ title, subtitle, field, entries, onAddEntry, onRenameEntry }) {
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState(null);

  return (
    <div>
      <h3 className="mb-1 text-base font-semibold">{title}</h3>
      <p className="mb-3 text-xs leading-snug text-[var(--color-muted)]">{subtitle}</p>
      <div className="space-y-1.5 max-h-80 overflow-auto pr-1">
        {entries.map((e) => (
          <div key={e.value} className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1.5 text-sm">
            <span className="text-[10px] text-[var(--color-muted)] w-7 tabular-nums">#{e.value}</span>
            {editing?.value === e.value ? (
              <>
                <input
                  value={editing.label}
                  onChange={(ev) => setEditing({ ...editing, label: ev.target.value })}
                  className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-sm outline-none focus:border-[var(--color-accent)]"
                  autoFocus
                />
                <button
                  onClick={async () => {
                    if (editing.label.trim()) await onRenameEntry(field, editing.value, editing.label);
                    setEditing(null);
                  }}
                  className="text-xs text-[var(--color-accent)] hover:underline"
                >
                  ✓
                </button>
                <button onClick={() => setEditing(null)} className="text-xs text-[var(--color-muted)]">✕</button>
              </>
            ) : (
              <>
                <span className="flex-1">{e.label}</span>
                <button
                  onClick={() => setEditing({ value: e.value, label: e.label })}
                  className="text-[10px] text-[var(--color-muted)] hover:text-[var(--color-accent)]"
                >
                  editar
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-1.5">
        <input
          value={adding} onChange={(e) => setAdding(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === "Enter" && adding.trim()) {
              e.preventDefault();
              await onAddEntry(field, adding);
              setAdding("");
            }
          }}
          placeholder="Agregar..."
          className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <button
          onClick={async () => {
            if (!adding.trim()) return;
            await onAddEntry(field, adding);
            setAdding("");
          }}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
        >
          + Agregar
        </button>
      </div>
    </div>
  );
}

// Wrapper visual para agrupar catálogos relacionados (Cosecha / Trato) dentro
// del modal de catálogos. Pone un header con emoji + título + descripción del
// dominio, y un fondo sutil para separar visualmente del bloque siguiente.
function CatalogGroup({ emoji, title, description, children }) {
  return (
    <section className="mb-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 p-4">
      <div className="mb-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <span aria-hidden>{emoji}</span>
          <span>{title}</span>
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted)]">{description}</p>
      </div>
      <div className="grid gap-5 md:grid-cols-2">{children}</div>
    </section>
  );
}

// ============================================================
// tratoHE modals
// ============================================================

function BonusEditModal({ open, onClose, labor, wd, workerName, date, readOnly, onSave }) {
  const [hasManejo, setHasManejo] = useState(false);
  const [hasSupervision, setHasSupervision] = useState(false);
  const [extras, setExtras] = useState("");

  useEffect(() => {
    if (open) {
      const defaults = labor?.bonusDefaults?.[wd?.workerRut] || {};
      setHasManejo(wd ? !!wd.hasManejo : !!defaults.manejo);
      setHasSupervision(wd ? !!wd.hasSupervision : !!defaults.supervision);
      setExtras(wd?.extras ? String(wd.extras) : "");
    }
  }, [open, wd, labor]);

  if (!labor) return null;
  const bonusManejo = labor.bonusManejo ?? DEFAULT_BONUS_MANEJO;
  const bonusSupervision = labor.bonusSupervision ?? DEFAULT_BONUS_SUPERVISION;

  return (
    <Modal open={open} onClose={onClose} title={`Bonos · ${date || ""}`}>
      <div className="space-y-3">
        {workerName && <div className="text-sm text-[var(--color-muted)]">{workerName}</div>}
        <label className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2">
          <div>
            <div className="text-sm font-medium">Bono manejo</div>
            <div className="text-xs text-[var(--color-muted)]">${bonusManejo.toLocaleString("es-CL")}</div>
          </div>
          <input type="checkbox" checked={hasManejo} disabled={readOnly}
            onChange={(e) => setHasManejo(e.target.checked)}
            className="h-5 w-5 accent-[var(--color-accent)]" />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2">
          <div>
            <div className="text-sm font-medium">Bono supervisión / líder</div>
            <div className="text-xs text-[var(--color-muted)]">${bonusSupervision.toLocaleString("es-CL")}</div>
          </div>
          <input type="checkbox" checked={hasSupervision} disabled={readOnly}
            onChange={(e) => setHasSupervision(e.target.checked)}
            className="h-5 w-5 accent-[var(--color-accent)]" />
        </label>
        <div>
          <label className="block text-sm font-medium">Bono extras (imprevistos)</label>
          <p className="mb-1 text-xs text-[var(--color-muted)]">
            Monto positivo (bono adicional) o negativo (descuento, ej: media jornada).
          </p>
          <input type="number" disabled={readOnly}
            value={extras} onChange={(e) => setExtras(e.target.value)} placeholder="0"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] disabled:opacity-50" />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm hover:bg-[var(--color-accent-soft)]">
            Cancelar
          </button>
          <button onClick={() => onSave({ hasManejo, hasSupervision, extras: Number(extras) || 0 })}
            disabled={readOnly}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            Guardar
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Piso opt-in por día. Mientras el día no tenga piso configurado, solo se
// muestra un botón "+ piso". Al click pasa a modo edición. Si ya hay un
// piso guardado, se muestra inline con su monto + acciones editar/quitar.
function PisoDayRow({ labor, dayPrices, date, readOnly, onPersist }) {
  const dayPiso = getDayPiso(dayPrices, labor.id, date);
  const hasPiso = dayPiso != null && dayPiso > 0;
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState("");
  useEffect(() => {
    if (!editing) setLocal(hasPiso ? String(dayPiso) : "");
  }, [editing, dayPiso, hasPiso]);

  if (!hasPiso && !editing) {
    if (readOnly) return null;
    return (
      <button
        onClick={() => { setLocal(""); setEditing(true); }}
        className="self-start text-[var(--color-muted)] text-[10px] hover:text-[var(--color-accent)] hover:underline"
        title="Agregar bono piso para este día"
      >
        + piso
      </button>
    );
  }

  if (editing) {
    const commit = () => {
      const next = local === "" ? 0 : Number(local) || 0;
      onPersist(next);
      setEditing(false);
    };
    return (
      <div className="mt-1 flex items-center gap-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-2 py-1 text-[10px]">
        <span className="font-medium text-[var(--color-muted)]">🪙 Piso $</span>
        <input
          type="number" min="0" autoFocus disabled={readOnly}
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
          className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-right tabular-nums outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
        />
      </div>
    );
  }

  return (
    <div className="mt-1 flex items-center gap-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-2 py-1 text-[10px]">
      <span className="font-medium text-[var(--color-text)]">🪙 Piso {fmtCurrency(dayPiso)}</span>
      {!readOnly && (
        <>
          <button
            onClick={() => { setLocal(String(dayPiso)); setEditing(true); }}
            className="ml-auto text-[var(--color-muted)] hover:text-[var(--color-accent)] hover:underline"
            title="Editar"
          >
            ✎
          </button>
          <button
            onClick={() => onPersist(0)}
            className="text-[var(--color-danger)] hover:underline"
            title="Quitar piso del día"
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}

function DayModeModal({ open, onClose, date, labor, cfg, readOnly, onSave }) {
  const [price, setPrice] = useState("");
  const [mode, setMode] = useState("normal");
  const [isHoliday, setIsHoliday] = useState(false);

  useEffect(() => {
    if (open && cfg) {
      setPrice(cfg.price ? String(cfg.price) : String(labor?.baseDayDefault ?? DEFAULT_BASE_DAY));
      setMode(cfg.mode || "normal");
      setIsHoliday(!!cfg.isHoliday);
    }
  }, [open, cfg, labor]);

  if (!labor) return null;
  const weekend = isWeekendDate(date);

  return (
    <Modal open={open} onClose={onClose} title={`Configurar día · ${date || ""}`}>
      <div className="space-y-4">
        {weekend && (
          <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
            ⚠ Es {date && new Date(date + "T00:00:00").getDay() === 0 ? "domingo" : "sábado"}. Probable jornada especial.
          </div>
        )}
        <div>
          <label className="block text-sm font-medium">Base diaria ($)</label>
          <input type="number" min="0" disabled={readOnly}
            value={price} onChange={(e) => setPrice(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Modo</label>
          <div className="space-y-2">
            {TRATO_HE_MODES.map((m) => (
              <label key={m.value} className="flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 cursor-pointer">
                <input type="radio" name="mode" value={m.value} checked={mode === m.value}
                  disabled={readOnly}
                  onChange={(e) => setMode(e.target.value)}
                  className="mt-0.5 accent-[var(--color-accent)]" />
                <span className="text-sm">{m.label}</span>
              </label>
            ))}
          </div>
        </div>
        <label className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 cursor-pointer">
          <div>
            <div className="text-sm font-medium">Marcar como feriado</div>
            <div className="text-xs text-[var(--color-muted)]">Resalta el día en rojo (Chile).</div>
          </div>
          <input type="checkbox" checked={isHoliday} disabled={readOnly}
            onChange={(e) => setIsHoliday(e.target.checked)}
            className="h-5 w-5 accent-[var(--color-accent)]" />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm hover:bg-[var(--color-accent-soft)]">
            Cancelar
          </button>
          <button onClick={() => onSave({ price: Number(price) || 0, mode, isHoliday })}
            disabled={readOnly}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            Guardar
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DefaultLeadersModal({ open, onClose, labor, readOnly, onSave }) {
  const [draft, setDraft] = useState({});
  useEffect(() => {
    if (open && labor) setDraft({ ...(labor.bonusDefaults || {}) });
  }, [open, labor]);
  if (!labor) return null;

  const toggle = (rut, key) => {
    setDraft((d) => {
      const next = { ...d };
      const cur = next[rut] || {};
      const updated = { ...cur, [key]: !cur[key] };
      if (!updated.manejo && !updated.supervision) delete next[rut];
      else next[rut] = updated;
      return next;
    });
  };

  return (
    <Modal open={open} onClose={onClose} title="Líderes y manejo (defaults)" size="lg">
      <p className="mb-3 text-sm text-[var(--color-muted)]">
        Los trabajadores marcados reciben automáticamente el bono cuando se ingrese una jornada nueva.
        Para una excepción puntual, abre el bono de esa celda y desmárcalo manualmente.
        Cambiar este default no actualiza días ya guardados.
      </p>
      <div className="max-h-96 overflow-auto rounded-md border border-[var(--color-border)]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-[var(--color-surface-2)]">
            <tr className="text-left text-[var(--color-muted)]">
              <th className="px-3 py-2 font-medium">Trabajador</th>
              <th className="px-3 py-2 font-medium text-center">Manejo</th>
              <th className="px-3 py-2 font-medium text-center">Supervisión / Líder</th>
            </tr>
          </thead>
          <tbody>
            {(labor.workers || []).map((w) => {
              const e = draft[w.rut] || {};
              return (
                <tr key={w.rut} className="border-t border-[var(--color-border)]">
                  <td className="px-3 py-2">{w.name}</td>
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" checked={!!e.manejo} disabled={readOnly}
                      onChange={() => toggle(w.rut, "manejo")}
                      className="h-4 w-4 accent-[var(--color-accent)]" />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" checked={!!e.supervision} disabled={readOnly}
                      onChange={() => toggle(w.rut, "supervision")}
                      className="h-4 w-4 accent-[var(--color-accent)]" />
                  </td>
                </tr>
              );
            })}
            {(labor.workers || []).length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-[var(--color-muted)]">
                  Aún no hay trabajadores en esta labor.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm hover:bg-[var(--color-accent-soft)]">
          Cancelar
        </button>
        <button onClick={() => onSave(draft)} disabled={readOnly}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
          Guardar
        </button>
      </div>
    </Modal>
  );
}

// ============================================================
// Day calendar picker — multi-select
// ============================================================
const MONTHS_ES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const WEEKDAYS_ES = ["Lu", "Ma", "Mi", "Ju", "Vi", "Sá", "Do"];

function pad2(n) { return String(n).padStart(2, "0"); }
function isoDate(y, m, d) { return `${y}-${pad2(m + 1)}-${pad2(d)}`; }

function DayCalendarPicker({ viewMonth, setViewMonth, selectedDays, toggleDay, existingDays }) {
  const { year, month } = viewMonth;
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // ISO week: Monday = 0, Sunday = 6
  const firstWeekday = (firstDay.getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const existingSet = new Set(existingDays);
  const todayIso = new Date().toISOString().slice(0, 10);

  const prevMonth = () =>
    setViewMonth(({ year, month }) =>
      month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 },
    );
  const nextMonth = () =>
    setViewMonth(({ year, month }) =>
      month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 },
    );

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <button onClick={prevMonth} className="rounded px-2 py-1 text-sm hover:bg-[var(--color-accent-soft)]">‹</button>
        <div className="text-sm font-semibold">{MONTHS_ES[month]} {year}</div>
        <button onClick={nextMonth} className="rounded px-2 py-1 text-sm hover:bg-[var(--color-accent-soft)]">›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium text-[var(--color-muted)]">
        {WEEKDAYS_ES.map((w) => <div key={w} className="py-1">{w}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (d == null) return <div key={i} className="aspect-square" />;
          const iso = isoDate(year, month, d);
          const isExisting = existingSet.has(iso);
          const isSelected = selectedDays.has(iso);
          const isToday = iso === todayIso;
          let cls = "aspect-square rounded text-sm transition-colors flex items-center justify-center cursor-pointer ";
          if (isExisting) {
            cls += "bg-[var(--color-surface-2)] text-[var(--color-muted)] cursor-not-allowed line-through";
          } else if (isSelected) {
            cls += "bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-semibold";
          } else {
            cls += "hover:bg-[var(--color-accent-soft)] " + (isToday ? "ring-1 ring-[var(--color-accent)]" : "");
          }
          return (
            <button
              key={i}
              type="button"
              disabled={isExisting}
              onClick={() => toggleDay(iso)}
              className={cls}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}
