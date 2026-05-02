import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { AgGridReact } from "ag-grid-react";
import { ModuleRegistry, AllCommunityModule } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import { toPng } from "html-to-image";
import { cyclesService, faenasService, subfaenasService, workdaysService } from "../services";
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
import WorkerPickerModal from "../components/WorkerPickerModal";

ModuleRegistry.registerModules([AllCommunityModule]);

const todayStr = () => new Date().toISOString().slice(0, 10);
const newId = () => (crypto?.randomUUID?.() || `id_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);

const fmtCurrency = (value) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 }).format(
    Number(value) || 0,
  );

const LABOR_TYPES = [
  { value: "main", label: "Principal (a trato)" },
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

function buildRowsCosecha(workers, days, wdMap, dayCombosByDate) {
  return workers.map((w) => {
    const row = { rut: w.rut, name: w.name };
    let total = 0;
    for (const d of days) {
      const combos = dayCombosByDate[d] || [];
      for (const c of combos) {
        const wd = wdMap[workdayMapKey(w.rut, d, c.key)];
        const qty = Number(wd?.qty) || 0;
        const amt = Number(wd?.amount) || 0;
        row[`${d}__${c.key}`] = qty;
        row[`${d}__${c.key}__amt`] = amt;
        total += amt;
      }
    }
    row.total = total;
    return row;
  });
}

function buildRowsTratoHE(workers, days, wdMap) {
  return workers.map((w) => {
    const row = { rut: w.rut, name: w.name };
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

function buildRowsTrato(workers, days, wdMap) {
  return workers.map((w) => {
    const row = { rut: w.rut, name: w.name };
    let total = 0;
    for (const d of days) {
      const wd = wdMap[workdayMapKey(w.rut, d, SINGLE_COMBO)];
      const qty = Number(wd?.qty) || 0;
      const amt = Number(wd?.amount) || 0;
      row[d] = qty;
      row[`${d}__amt`] = amt;
      total += amt;
    }
    row.total = total;
    return row;
  });
}

function buildRowsNormal(workers, days, wdMap) {
  return workers.map((w) => {
    const row = { rut: w.rut, name: w.name };
    let total = 0;
    for (const d of days) {
      const wd = wdMap[workdayMapKey(w.rut, d, SINGLE_COMBO)];
      const amount = Number(wd?.amount) || 0;
      row[d] = amount;
      total += amount;
    }
    row.total = total;
    return row;
  });
}

function rowsToTSV(nodes, fields, formatters = {}) {
  const headers = fields.map((f) => f.headerName).join("\t");
  const lines = nodes.map((n) =>
    fields.map((f) => {
      const raw = n.data?.[f.field];
      const fmt = formatters[f.field];
      return fmt ? fmt(raw) : raw == null ? "" : String(raw);
    }).join("\t"),
  );
  return [headers, ...lines].join("\n");
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
  const [pickerOpen, setPickerOpen] = useState(false);

  const [removeWorker, setRemoveWorker] = useState(null);
  const [removeBusy, setRemoveBusy] = useState(false);

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

  const gridRef = useRef(null);
  const photoRef = useRef(null);

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
        for (const date of Object.keys(rawDP[lid])) {
          const before = rawDP[lid][date];
          const after = normalizeDayPricesEntry(before);
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
      for (const w of wds) {
        const lid = w.laborId || normalized.labors[0]?.id;
        const x = Number(w.qualityX) || 0;
        const y = Number(w.containerY) || 0;
        const ck = makeComboKey(x, y);
        if (!byLabor[lid]) byLabor[lid] = {};
        byLabor[lid][workdayMapKey(w.workerRut, w.date, ck)] = w;
      }
      setWorkdaysByLabor(byLabor);
      setLoading(false);
    })();
  }, [id]);

  const closed = cycle?.status === "closed";
  const readOnly = closed && !isAdmin;

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

  const tratoDayPrice = useMemo(() => {
    if (!isTratoLabor || !activeLabor) return {};
    const out = {};
    for (const d of days) out[d] = getDaySingle(dayPrices, activeLabor.id, d, defaultMode);
    return out;
  }, [isTratoLabor, activeLabor, days, dayPrices, defaultMode]);

  const rowData = useMemo(() => {
    if (isCosechaLabor) return buildRowsCosecha(workers, days, wdMap, dayCombosByDate);
    if (isTratoLabor) return buildRowsTrato(workers, days, wdMap);
    if (isTratoHELabor) return buildRowsTratoHE(workers, days, wdMap);
    return buildRowsNormal(workers, days, wdMap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workers, days, wdMap, isCosechaLabor, isTratoLabor, isTratoHELabor, dayCombosByDate]);

  const totalsByLabor = useMemo(() => {
    const out = {};
    if (!cycle?.labors) return out;
    for (const l of cycle.labors) {
      const m = workdaysByLabor[l.id] || {};
      let sum = 0;
      for (const k in m) sum += Number(m[k].amount) || 0;
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
      for (const k in m) sum += Number(m[k].qty) || 0;
      out[l.id] = sum;
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

  const totalQtyByDayTrato = useMemo(() => {
    if (!isTratoLabor || !activeLabor) return {};
    const m = workdaysByLabor[activeLabor.id] || {};
    const out = {};
    for (const d of days) {
      let sum = 0;
      for (const w of workers) sum += Number(m[workdayMapKey(w.rut, d, SINGLE_COMBO)]?.qty) || 0;
      out[d] = sum;
    }
    return out;
  }, [isTratoLabor, activeLabor, workdaysByLabor, days, workers]);

  const grandTotal = useMemo(
    () => Object.values(totalsByLabor).reduce((a, b) => a + b, 0),
    [totalsByLabor],
  );

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

  const computeTratoHEAmount = (labor, dayCfg, wd) =>
    calcTratoHEAmount({
      qty: wd.qty,
      overtimeHours: wd.overtimeHours,
      hasManejo: wd.hasManejo,
      hasSupervision: wd.hasSupervision,
      extras: wd.extras,
      dayPrice: dayCfg?.price ?? labor?.baseDayDefault ?? DEFAULT_BASE_DAY,
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
    const cur = isTrato
      ? getDaySingle(dayPrices, laborId, date, defaultMode)
      : getCombo(laborId, date, ck);
    return cur.price || "";
  };

  // ============================================================
  // Cell value changed
  // ============================================================

  const onCellValueChanged = async (params) => {
    const field = params.colDef.field;
    if (!field || field === "total" || field === "rut" || field === "name" || field.endsWith("__amt")) return;

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
      const date = field;
      const workerRut = params.data.rut;
      const docId = workdayDocId(id, activeLabor.id, workerRut, date, SINGLE_COMBO);
      const mapKey = workdayMapKey(workerRut, date, SINGLE_COMBO);
      const qty = parseAmount(params.newValue) || 0;
      const cfg = getDaySingle(dayPrices, activeLabor.id, date, defaultMode);
      const amount = cfg.mode === "flat" ? cfg.price : qty * cfg.price;

      if (qty === 0) {
        if (wdMap[mapKey]) {
          await workdaysService.remove(docId);
          setWorkdaysByLabor((prev) => {
            const lab = { ...(prev[activeLabor.id] || {}) };
            delete lab[mapKey];
            return { ...prev, [activeLabor.id]: lab };
          });
        }
        params.node.setDataValue(date, 0);
        params.node.setDataValue(`${date}__amt`, 0);
      } else {
        await workdaysService.upsert(docId, {
          cycleId: id, laborId: activeLabor.id, workerRut, date, qty, amount,
        });
        setWorkdaysByLabor((prev) => {
          const lab = { ...(prev[activeLabor.id] || {}) };
          lab[mapKey] = { ...lab[mapKey], cycleId: id, laborId: activeLabor.id, workerRut, date, qty, amount };
          return { ...prev, [activeLabor.id]: lab };
        });
        params.node.setDataValue(date, qty);
        params.node.setDataValue(`${date}__amt`, amount);
      }
      const newTotal = days.reduce(
        (acc, d) => acc + (d === date ? amount : Number(params.data[`${d}__amt`]) || 0),
        0,
      );
      params.node.setDataValue("total", newTotal);
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
    await persistLabor({ ...activeLabor, workers: [...workers, { rut: worker.rut, name: worker.name }] });
    setPickerOpen(false);
  };

  const askRemoveWorker = (rut) => {
    const w = workers.find((x) => x.rut === rut);
    if (w) setRemoveWorker(w);
  };

  const confirmRemoveWorker = async () => {
    if (!removeWorker) return;
    setRemoveBusy(true);
    try {
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
    if (!isAdmin) return;
    if (!confirm("¿Reabrir el ciclo? Solo admin puede hacerlo.")) return;
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

  const buildCopyFields = () => {
    const base = [{ headerName: "RUT", field: "rut" }, { headerName: "Nombre", field: "name" }];
    if (isCosechaLabor) {
      for (const d of days) {
        for (const c of (dayCombosByDate[d] || [])) {
          base.push({ headerName: `${d} ${comboLabel(catalogs, c.x, c.y)}`, field: `${d}__${c.key}` });
        }
      }
    } else {
      for (const d of days) base.push({ headerName: d, field: d });
    }
    base.push({ headerName: "TOTAL", field: "total" });
    return base;
  };

  const copyAll = async () => {
    const api = gridRef.current?.api;
    if (!api) return;
    const nodes = [];
    api.forEachNodeAfterFilterAndSort((n) => nodes.push(n));
    const fields = buildCopyFields();
    const formatters = { rut: (v) => formatRutForDisplay(v) };
    const tsv = rowsToTSV(nodes, fields, formatters);
    try {
      await navigator.clipboard.writeText(tsv);
      showToast(`Copiados ${nodes.length} trabajadores`);
    } catch { showToast("No se pudo copiar"); }
  };

  const copySelected = async () => {
    const api = gridRef.current?.api;
    if (!api) return;
    const selected = api.getSelectedNodes();
    if (!selected.length) return showToast("No hay filas seleccionadas");
    const fields = buildCopyFields();
    const formatters = { rut: (v) => formatRutForDisplay(v) };
    const tsv = rowsToTSV(selected, fields, formatters);
    try {
      await navigator.clipboard.writeText(tsv);
      showToast(`Copiados ${selected.length} seleccionados`);
    } catch { showToast("No se pudo copiar"); }
  };

  // ============================================================
  // Column defs
  // ============================================================

  const columnDefs = useMemo(() => {
    const baseLeft = [
      {
        headerName: "RUT", field: "rut", editable: false, width: 130, pinned: "left",
        valueFormatter: (p) => formatRutForDisplay(p.value),
        checkboxSelection: !photoMode, headerCheckboxSelection: !photoMode,
      },
      { headerName: "Nombre", field: "name", editable: false, width: 200, pinned: "left" },
    ];
    const totalCol = {
      headerName: isQtyLabor ? "TOTAL ($)" : "TOTAL",
      field: "total", editable: false, width: 150, pinned: "right",
      valueFormatter: (p) => fmtCurrency(p.value),
      cellStyle: { fontWeight: 600, color: "var(--color-accent)" },
    };
    const actionsCol = photoMode ? [] : [{
      headerName: "", field: "_actions", editable: false, width: 90, pinned: "right",
      cellRenderer: (p) => (
        <button
          onClick={() => askRemoveWorker(p.data.rut)}
          disabled={readOnly}
          className="text-xs text-[var(--color-danger)] hover:underline disabled:opacity-40"
        >
          Quitar
        </button>
      ),
    }];

    if (isCosechaLabor) {
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
        return {
          headerName: d, groupId: `g_${d}`,
          children: children.length ? children : [{
            headerName: "—", field: `${d}__placeholder`, editable: false, width: 80, valueGetter: () => "",
          }],
        };
      });
      return [...baseLeft, ...dayGroups, totalCol, ...actionsCol];
    }

    if (isTratoLabor) {
      const dayCols = days.map((d) => ({
        headerName: d, field: d,
        editable: !readOnly && !photoMode,
        width: 120,
        type: "numericColumn",
        valueParser: (p) => parseAmount(p.newValue),
        cellRenderer: (p) => {
          const qty = Number(p.value) || 0;
          const amt = Number(p.data?.[`${d}__amt`]) || 0;
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
      return [...baseLeft, ...dayCols, totalCol, ...actionsCol];
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
        const base = cfg.mode === "overtimeOnly" ? 0 : (Number(cfg.price) || 0) * qty;
        if (cfg.mode === "overtimeOnly") {
          lines.push(`Solo HE (sin base)`);
        } else if (qty > 0) {
          lines.push(`Base: ${fmtCurrency(cfg.price)} × ${qty} = ${fmtCurrency(base)}`);
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
          headerClass: red ? "ag-header-red-day" : undefined,
          children: [
            {
              headerName: "D",
              field: `${d}__qty`,
              editable: !readOnly && !photoMode,
              width: 60,
              type: "numericColumn",
              valueParser: (p) => parseAmount(p.newValue),
              valueFormatter: (p) => (p.value ? String(p.value) : ""),
              headerTooltip: "Día (1=jornada completa, 0.5=media jornada)",
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
      editable: !readOnly && !photoMode,
      width: 110,
      type: "numericColumn",
      valueParser: (p) => parseAmount(p.newValue),
      valueFormatter: (p) => fmtCurrency(p.value),
    }));
    return [...baseLeft, ...dayCols, totalCol, ...actionsCol];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, readOnly, photoMode, isCosechaLabor, isTratoLabor, isTratoHELabor, dayCombosByDate, catalogs, dayPrices, activeLabor, tratoHEView]);

  if (loading) return <div className="text-[var(--color-muted)]">Cargando...</div>;
  if (!cycle) return <div className="text-[var(--color-muted)]">Ciclo no encontrado.</div>;

  const grid = (
    <div className="ag-theme-quartz ag-theme-app h-full" style={{ minHeight: 400 }}>
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
          singleClickEdit={!photoMode}
          stopEditingWhenCellsLoseFocus
          getRowId={(p) => p.data.rut}
          rowSelection={photoMode ? undefined : "multiple"}
          suppressRowClickSelection
          enableCellTextSelection
          ensureDomOrder
          localeText={AG_GRID_LOCALE_ES}
          defaultColDef={{ resizable: true, sortable: true, filter: true }}
          rowHeight={isQtyLabor ? 44 : undefined}
        />
      )}
    </div>
  );

  if (photoMode) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-[var(--color-bg)] p-6">
        <div className="mb-3 flex items-center gap-2">
          <button onClick={copyAll} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
            Copiar todo
          </button>
          <button onClick={exportPng} disabled={exporting} className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60">
            {exporting ? "Generando..." : "Descargar PNG"}
          </button>
          <button onClick={() => setPhotoMode(false)} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
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
          {!closed && (
            <button onClick={() => setCloseFlow(true)} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
              Cerrar ciclo
            </button>
          )}
          {closed && isAdmin && (
            <button onClick={handleReopenCycle} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
              Reabrir ciclo
            </button>
          )}
          <button onClick={copySelected} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
            Copiar selección
          </button>
          <button onClick={copyAll} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
            Copiar todo
          </button>
          <button onClick={() => setPhotoMode(true)} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
            📷 Modo foto
          </button>
        </div>
      </div>

      {/* Metrics */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cycle.labors.map((l) => {
          const isCo = l.type === "cosecha";
          const isTr = l.type === "trato";
          const isHE = l.type === "tratoHE";
          const totalAmt = totalsByLabor[l.id] || 0;
          const qtyByContainer = totalQtyByContainerByLabor[l.id] || {};
          const totalQty = totalQtyByLabor[l.id] || 0;
          const heMetrics = tratoHEMetricsByLabor[l.id];
          const tag = isCo ? "cosecha" : isTr ? "trato" : isHE ? "jornadas+HE" : l.type;
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
                <div className="mt-0.5 text-[11px] text-[var(--color-muted)]">
                  {tratoTypeLabel(catalogs, l.tratoType ?? 0)} · {totalQty.toLocaleString("es-CL")} unid.
                </div>
              )}
              {isHE && heMetrics && (
                <div className="mt-1 space-y-0.5 text-[11px] tabular-nums">
                  <div className="flex justify-between gap-2">
                    <span className="text-[var(--color-muted)]">Jornadas:</span>
                    <span>
                      <span className="font-medium">{heMetrics.normalQty.toLocaleString("es-CL")}</span>
                      <span className="text-[var(--color-muted)]"> norm.</span>
                      {heMetrics.holidayQty > 0 && (
                        <span className="ml-1 text-[var(--color-danger)]">
                          + {heMetrics.holidayQty.toLocaleString("es-CL")} fer.
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
        <div className="rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-3 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wider text-[var(--color-accent)]">Total ciclo</div>
          <div className="mt-1 text-lg font-bold tabular-nums text-[var(--color-accent)]">{fmtCurrency(grandTotal)}</div>
        </div>
      </div>

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
          const tagIcon = isCo ? "🌾" : isTr ? "🛠" : isHE ? "⏱" : l.type;
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
            <div className="mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--color-muted)] uppercase tracking-wider">
                <span>🌾</span>
                <span>Precios por día y tipo</span>
                {readOnly && <span className="text-[var(--color-warning)]">solo lectura</span>}
              </div>
              <div className="flex flex-wrap gap-2">
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
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TratoHE price bar */}
          {isTratoHELabor && days.length > 0 && (
            <div className="mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--color-muted)] uppercase tracking-wider">
                <span>🛠</span>
                <span>Configuración por día</span>
                {readOnly && <span className="text-[var(--color-warning)]">solo lectura</span>}
              </div>
              <div className="flex flex-wrap gap-2">
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
            </div>
          )}

          {/* Trato price bar */}
          {isTratoLabor && days.length > 0 && (
            <div className="mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--color-muted)] uppercase tracking-wider">
                <span>🛠</span>
                <span>Precios por día · {tratoTypeLabel(catalogs, activeLabor.tratoType ?? 0)}</span>
                {readOnly && <span className="text-[var(--color-warning)]">solo lectura</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                {days.map((d) => {
                  const cfg = tratoDayPrice[d] || { price: 0, mode: defaultMode };
                  const totalQty = totalQtyByDayTrato[d] || 0;
                  const workersWithQty = workers.filter(
                    (w) => (wdMap[workdayMapKey(w.rut, d, SINGLE_COMBO)]?.qty || 0) > 0,
                  ).length;
                  const totalAmt = cfg.mode === "flat" ? cfg.price * workersWithQty : totalQty * cfg.price;
                  return (
                    <div
                      key={d}
                      className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-xs ${
                        cfg.price > 0 ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-[var(--color-text)]">{d}</span>
                        <span className="text-[var(--color-muted)]">·</span>
                        <span className="text-[var(--color-muted)]">{totalQty.toLocaleString("es-CL")}</span>
                      </div>
                      <div className="flex rounded-md overflow-hidden border border-[var(--color-border)] text-[10px]">
                        <button
                          disabled={readOnly}
                          onClick={() => persistComboConfig(activeLabor.id, d, SINGLE_COMBO, { mode: "unit" }, true)}
                          className={`flex-1 px-2 py-0.5 transition-colors ${
                            cfg.mode === "unit"
                              ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-medium"
                              : "bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
                          } disabled:opacity-50`}
                        >
                          $/unidad
                        </button>
                        <button
                          disabled={readOnly}
                          onClick={() => persistComboConfig(activeLabor.id, d, SINGLE_COMBO, { mode: "flat" }, true)}
                          className={`flex-1 px-2 py-0.5 transition-colors ${
                            cfg.mode === "flat"
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
                          value={getPriceInputValue(activeLabor.id, d, SINGLE_COMBO, true)}
                          onChange={(e) =>
                            setLocalPriceInputs((prev) => ({
                              ...prev,
                              [inputKey(activeLabor.id, d, SINGLE_COMBO)]: e.target.value,
                            }))
                          }
                          onBlur={() => handlePriceBlur(activeLabor.id, d, SINGLE_COMBO, true)}
                          placeholder={cfg.mode === "flat" ? "tarifa/trab." : "precio/unidad"}
                          className="w-28 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-right tabular-nums outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
                        />
                      </div>
                      {totalAmt > 0 && (
                        <div className="text-[var(--color-accent)] font-medium tabular-nums">
                          = {fmtCurrency(totalAmt)}
                          {cfg.mode === "flat" && workersWithQty > 0 && (
                            <span className="ml-1 font-normal text-[var(--color-muted)]">({workersWithQty} trab.)</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex-1">{grid}</div>
        </>
      )}

      {/* Modals */}
      <Modal
        open={addDayOpen}
        onClose={() => setAddDayOpen(false)}
        title="Agregar día"
        footer={
          <>
            <button onClick={() => setAddDayOpen(false)} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]">
              Cancelar
            </button>
            <button onClick={addDay} className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]">
              Agregar
            </button>
          </>
        }
      >
        <TextField label="Fecha" type="date" value={newDay} onChange={setNewDay} autoFocus />
        <p className="mt-2 text-xs text-[var(--color-muted)]">El día se aplica a todas las labores del ciclo.</p>
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
      />

      <ConfirmDialog
        open={!!removeWorker}
        title="Quitar trabajador"
        message={removeWorker ? `¿Quitar a ${removeWorker.name} de "${activeLabor?.name}"?` : ""}
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
          // Recalc: defaults only seed new workdays, but if user wants existing to update,
          // they must edit per workday. Just close.
          setDefaultLeadersOpen(false);
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
      <p className="mb-4 text-sm text-[var(--color-muted)]">
        Estos catálogos son compartidos por toda la aplicación. Cualquier supervisor puede agregar entradas; renombrar afecta los datos históricos.
      </p>
      <div className="grid gap-6 md:grid-cols-3">
        <CatalogSection
          title="Calidades" subtitle="Cosechas"
          field="qualities" entries={catalogs.qualities || []}
          onAddEntry={onAddEntry} onRenameEntry={onRenameEntry}
        />
        <CatalogSection
          title="Envases" subtitle="Cosechas"
          field="containers" entries={catalogs.containers || []}
          onAddEntry={onAddEntry} onRenameEntry={onRenameEntry}
        />
        <CatalogSection
          title="Tipos de trato" subtitle="Labores a trato"
          field="tratoTypes" entries={catalogs.tratoTypes || []}
          onAddEntry={onAddEntry} onRenameEntry={onRenameEntry}
        />
      </div>
      <div className="mt-4 flex justify-end">
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
      <p className="mb-3 text-xs text-[var(--color-muted)]">{subtitle}</p>
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
