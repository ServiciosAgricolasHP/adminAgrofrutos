import { useEffect, useMemo, useRef, useState } from "react";
import { toBlob } from "html-to-image";
import {
  faenasService,
  subfaenasService,
  cyclesService,
  workersService,
  workdaysService,
  payrollSnapshotsService,
} from "../services";
import {
  payrollsService,
  markPaid as markPayrollPaid,
  markPending as markPayrollPending,
  tagWorkdaysWithPayroll,
  untagWorkdaysFromPayroll,
  removeWorkerFromPayroll,
  removeCycleFromPayroll,
} from "../services/payrollsService";
import {
  listPendingForWorkers,
  applyAdvancesToPayroll,
  restoreAdvancesFromPayroll,
  advanceRemaining,
  advanceSign,
} from "../services/advancesService";
import { formatRutForDisplay } from "../utils/rutUtils";
import { bankName, ACCOUNT_TYPES, isCashBank, CASH_BANK_CODE } from "../utils/banks";
import { getTratoTierTotals, getDayCombos, getDaySingle, getTratoTiers, tratoTypeLabel, tratoUnitLabel, cosechaUnit, comboLabel, containerLabel, formatLaborDayPrice } from "../utils/cosechaCombos";
import { useCatalogs } from "../contexts/CatalogsContext";
import { useToast } from "../contexts/ToastContext";
import {
  aggregateWorkerAmounts,
  downloadBchileXlsx,
  downloadNominaOnlyXlsx,
  payrollSuggestedName,
  groupCashByLeader,
  splitBankAndCash,
  validateAccountNumber,
  normalizeLeader,
} from "../utils/payroll";
import ConfirmDialog from "../components/ConfirmDialog";
import Modal from "../components/Modal";
import ResizableArea from "../components/ResizableArea";
import WorkerSummaryModal from "../components/WorkerSummaryModal";
import { useIsMobile } from "../hooks/useIsMobile";

const fmtCurrency = (v) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 }).format(
    Number(v) || 0,
  );

// Denominaciones CLP que el usuario tiene disponibles para pagar efectivo.
// Orden descendente porque la descomposición es greedy (toma el billete más
// grande que entra y baja). $100 es la unidad más chica → cualquier monto
// redondeado a múltiplo de $100 es descomponible exactamente.
const CASH_DENOMINATIONS = [10000, 5000, 1000, 500, 100];

// Para cada item de efectivo: redondea el monto hacia arriba al múltiplo de
// $100 más cercano y descompone en cuántos billetes/monedas de cada
// denominación se necesitan. Devuelve `{ totalNeeded, counts, perWorker }`
// donde counts es un Map(denominacion → cantidad necesaria total).
function estimateCashBreakdown(cashItems) {
  const counts = new Map(CASH_DENOMINATIONS.map((d) => [d, 0]));
  const perWorker = [];
  let totalNeeded = 0;
  let totalOriginal = 0;
  for (const it of cashItems) {
    const original = Number(it.amount) || 0;
    const rounded = Math.ceil(original / 100) * 100;
    const delta = rounded - original;
    let remaining = rounded;
    const breakdown = {};
    for (const d of CASH_DENOMINATIONS) {
      const n = Math.floor(remaining / d);
      if (n > 0) {
        counts.set(d, counts.get(d) + n);
        breakdown[d] = n;
        remaining -= n * d;
      }
    }
    perWorker.push({ rut: it.rut, name: it.name, leader: it.groupLeader, original, rounded, delta, breakdown });
    totalNeeded += rounded;
    totalOriginal += original;
  }
  return { totalNeeded, totalOriginal, counts, perWorker };
}

const fmtDate = (v) => {
  if (!v) return "—";
  const d = v?.toDate ? v.toDate() : new Date(v);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("es-CL");
};

const accountTypeShort = (v) => ACCOUNT_TYPES.find((t) => t.value === Number(v))?.code || "JUV";

const SELECTION_KEY = "payroll_cycle_selection";
const loadSelection = () => {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
};
const saveSelection = (set) => {
  try { localStorage.setItem(SELECTION_KEY, JSON.stringify([...set])); } catch {}
};

// Trigger a browser download of the snapshot object as a JSON file. The name
// is sanitized for filesystems (any non-alphanumeric run becomes "_").
function downloadSnapshotJson(payrollName, snapshot) {
  try {
    const json = JSON.stringify(snapshot, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeName = String(payrollName || "Nomina").replace(/[^a-z0-9_-]+/gi, "_");
    a.href = url;
    a.download = `${safeName}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (err) {
    console.warn("No se pudo descargar el JSON del snapshot:", err);
  }
}

export default function Payroll() {
  const toast = useToast();
  const [tab, setTab] = useState("create"); // create | history | workers
  const [loading, setLoading] = useState(true);
  const [faenas, setFaenas] = useState([]);
  const [subfaenas, setSubfaenas] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [payrolls, setPayrolls] = useState([]);

  const [selectedCycleIds, setSelectedCycleIds] = useState(loadSelection);
  // Por cada ciclo seleccionado guardamos qué labores entran a la nómina.
  // No persistido (a diferencia de selectedCycleIds): la elección es local
  // a la sesión de generación. Default al chequear un ciclo: todas sus labores.
  const [selectedLaborsByCycle, setSelectedLaborsByCycle] = useState(() => new Map());
  const [step, setStep] = useState(1); // 1 = pick cycles, 2 = preview
  const [previewItems, setPreviewItems] = useState([]); // [{rut, name, accountNumber, bankCode, accountType, email, amount, include, _missing}]
  // Cached source data from buildPreview, used to assemble the static snapshot
  // when generateAndSave fires. Avoids re-querying workdays and advances.
  const previewWorkdaysRef = useRef([]);
  const previewAdvancesRef = useRef([]);
  const [busy, setBusy] = useState(false);
  // Progress overlay state. `step` es el mensaje principal (ej. "Etiquetando
  // jornadas"), `detail` un complemento opcional (ej. "340 / 500"), `percent`
  // 0-100. Si es `null`, no se muestra overlay.
  const [progress, setProgress] = useState(null);
  const [payrollName, setPayrollName] = useState("");
  // Clasificación de la nómina: "nomina" (default) o "diferencia". Las
  // diferencias suelen ser nóminas chicas (ajustes / pagos puntuales) y se
  // muestran en una pestaña aparte del historial para no alargar la lista
  // principal de nóminas.
  const [payrollClassification, setPayrollClassification] = useState("nomina");

  const [confirmDelete, setConfirmDelete] = useState(null);
  const [detailPayroll, setDetailPayroll] = useState(null);

  // Per-cycle aggregates: { [cycleId]: { unpaid, paid, total } }
  const [cycleStats, setCycleStats] = useState({});
  // Estado independiente del loading inicial: cuando el usuario pide refrescar
  // mostramos un spinner en el botón sin tapar toda la pantalla con "Cargando…".
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [f, s, c, w, p] = await Promise.all([
        faenasService.list({ order: ["name", "asc"], cache: true, persist: true, ttl: 10 * 60 * 1000 }),
        subfaenasService.list({ order: ["name", "asc"], cache: true, persist: true, ttl: 10 * 60 * 1000 }),
        cyclesService.list({ order: ["createdAt", "desc"], cache: true, persist: true, ttl: 5 * 60 * 1000 }),
        workersService.list({ order: ["name", "asc"], cache: true, persist: true, ttl: 2 * 60 * 60 * 1000 }),
        payrollsService.list({ order: ["createdAt", "desc"], take: 50, cache: true, persist: true, ttl: 5 * 60 * 1000 }),
      ]);
      setFaenas(f);
      setSubfaenas(s);
      setCycles(c);
      setWorkers(w);
      setPayrolls(p);

      // Compute per-cycle paid/unpaid totals + date range (for active cycles
      // only). firstDay/lastDay alimentan el CycleSelector para mostrar el
      // período de cada subfaena en pantalla cuando se arma una nómina.
      const activeIds = c.filter((x) => x.status !== "closed").map((x) => x.id);
      const stats = {};
      for (const id of activeIds) stats[id] = { unpaid: 0, paid: 0, total: 0, firstDay: "", lastDay: "" };
      for (let i = 0; i < activeIds.length; i += 10) {
        const chunk = activeIds.slice(i, i + 10);
        const wds = await workdaysService.list({ wheres: [["cycleId", "in", chunk]] });
        const laborTypeMap = new Map();
        for (const cy of c) {
          if (chunk.includes(cy.id)) {
            for (const labor of cy.labors || []) laborTypeMap.set(labor.id, labor.type);
          }
        }
        for (const wd of wds) {
          const cid = wd.cycleId;
          if (!stats[cid]) continue;
          const type = laborTypeMap.get(wd.laborId);
          let amount = 0;
          if (type === "trato") {
            amount = getTratoTierTotals(wd).amount;
          } else {
            amount = Number(wd.amount) || 0;
          }
          stats[cid].total += amount;
          if (wd.payrollId) stats[cid].paid += amount;
          else stats[cid].unpaid += amount;
          if (wd.date) {
            if (!stats[cid].firstDay || wd.date < stats[cid].firstDay) stats[cid].firstDay = wd.date;
            if (!stats[cid].lastDay || wd.date > stats[cid].lastDay) stats[cid].lastDay = wd.date;
          }
        }
      }
      setCycleStats(stats);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Forzar lectura desde Firestore ignorando la cache local (mem + localStorage).
  // Útil cuando otro usuario agregó workers/labores/workdays justo antes de
  // generar una nómina y la TTL no caducó todavía. Invalida los scopes que
  // alimentan el armado de la nómina y recarga.
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      faenasService.invalidate();
      subfaenasService.invalidate();
      cyclesService.invalidate();
      workersService.invalidate();
      payrollsService.invalidate();
      await load();
      toast.success("Datos actualizados");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo recargar.");
    } finally {
      setRefreshing(false);
    }
  };

  // Group active cycles by faena (and subfaena).
  const activeByFaena = useMemo(() => {
    const groups = new Map();
    for (const f of faenas) groups.set(f.id, { faena: f, cycles: [] });
    for (const c of cycles) {
      if (c.status === "closed") continue;
      const g = groups.get(c.faenaId);
      if (g) g.cycles.push(c);
    }
    return [...groups.values()].filter((g) => g.cycles.length > 0);
  }, [faenas, cycles]);

  const subfaenaName = (id) => subfaenas.find((s) => s.id === id)?.name || "";
  const workerById = (rut) => workers.find((w) => w.id === rut);

  const toggleCycle = (id) => {
    setSelectedCycleIds((prev) => {
      const next = new Set(prev);
      const wasSelected = next.has(id);
      if (wasSelected) next.delete(id);
      else next.add(id);
      saveSelection(next);
      return next;
    });
    setSelectedLaborsByCycle((prev) => {
      const next = new Map(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        const cycle = cycles.find((c) => c.id === id);
        next.set(id, new Set((cycle?.labors || []).map((l) => l.id)));
      }
      return next;
    });
  };

  const toggleLaborInCycle = (cycleId, laborId) => {
    setSelectedLaborsByCycle((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(cycleId) || []);
      if (set.has(laborId)) set.delete(laborId);
      else set.add(laborId);
      next.set(cycleId, set);
      return next;
    });
  };

  const buildPreview = async () => {
    if (selectedCycleIds.size === 0) return;
    setBusy(true);
    try {
      const cycleIds = [...selectedCycleIds];
      const selectedCycles = cycles.filter((c) => cycleIds.includes(c.id));

      // Build labor type map
      const laborTypeById = new Map();
      for (const cycle of selectedCycles) {
        for (const labor of cycle.labors || []) {
          laborTypeById.set(labor.id, labor.type);
        }
      }

      // Load workdays for each cycle, excluding ones already tagged in another
      // payroll y ones belonging to TEMP-* (temporary) workers, which never
      // make it into a payroll until their RUT is assigned in CycleDetail.
      // También filtramos por la selección de labores por ciclo: workdays de
      // labores no marcadas quedan disponibles para una próxima nómina.
      const allWorkdays = [];
      const chunkSize = 10;
      for (let i = 0; i < cycleIds.length; i += chunkSize) {
        const chunk = cycleIds.slice(i, i + chunkSize);
        const wds = await workdaysService.list({ wheres: [["cycleId", "in", chunk]] });
        for (const wd of wds) {
          if (wd.payrollId) continue;
          if (String(wd.workerRut || "").startsWith("TEMP-")) continue;
          const allowedLabors = selectedLaborsByCycle.get(wd.cycleId);
          if (allowedLabors && !allowedLabors.has(wd.laborId)) continue;
          allWorkdays.push(wd);
        }
      }

      const aggregates = aggregateWorkerAmounts(allWorkdays, laborTypeById);

      // Pull pending advances for everyone in this preview.
      const candidateRuts = aggregates.filter((a) => a.total > 0).map((a) => a.rut);
      const pendingAdvances = await listPendingForWorkers(candidateRuts);
      previewWorkdaysRef.current = allWorkdays;
      previewAdvancesRef.current = pendingAdvances;
      const advancesByRut = new Map();
      for (const adv of pendingAdvances) {
        const e = advancesByRut.get(adv.workerRut) || { anticipos: [], bonos: [] };
        if (advanceSign(adv) > 0) e.bonos.push(adv);
        else e.anticipos.push(adv);
        advancesByRut.set(adv.workerRut, e);
      }

      const items = aggregates
        .filter((a) => a.total > 0)
        .map((a) => {
          const w = workerById(a.rut);
          const bd = w?.bankDetails || [];
          const bankCode = bd[3] || "";
          const cash = isCashBank(bankCode);
          const byCycle = {};
          for (const cid of cycleIds) {
            byCycle[cid] = Math.round(a.byCycle[cid] || 0);
          }
          const accountIssue = validateAccountNumber(bd[1] || "", bankCode);
          const adv = advancesByRut.get(a.rut) || { anticipos: [], bonos: [] };

          // Anticipos: oldest-first, descuentan, capados por el bruto.
          const sortedAnticipos = [...adv.anticipos].sort((x, y) => {
            const da = (x.date || ""), dbb = (y.date || "");
            return da < dbb ? -1 : da > dbb ? 1 : 0;
          });
          const grossInt = Math.round(a.total);
          let remainingGross = grossInt;
          const anticipoApplications = [];
          for (const advItem of sortedAnticipos) {
            if (remainingGross <= 0) break;
            const advRem = Math.round(advanceRemaining(advItem));
            if (advRem <= 0) continue;
            const apply = Math.min(remainingGross, advRem);
            if (apply <= 0) continue;
            anticipoApplications.push({ advanceId: advItem.id, amount: apply });
            remainingGross -= apply;
          }

          // Bonos: se aplican completos (suman, sin tope contra el bruto).
          const sortedBonos = [...adv.bonos].sort((x, y) => {
            const da = (x.date || ""), dbb = (y.date || "");
            return da < dbb ? -1 : da > dbb ? 1 : 0;
          });
          const bonoApplications = [];
          for (const advItem of sortedBonos) {
            const advRem = Math.round(advanceRemaining(advItem));
            if (advRem <= 0) continue;
            bonoApplications.push({ advanceId: advItem.id, amount: advRem });
          }

          const anticiposTotal = anticipoApplications.reduce((s, x) => s + x.amount, 0);
          const bonosTotal = bonoApplications.reduce((s, x) => s + x.amount, 0);
          const advanceNoteParts = [];
          if (anticiposTotal) advanceNoteParts.push(`Anticipos ${anticipoApplications.length}`);
          if (bonosTotal) advanceNoteParts.push(`Bonos ${bonoApplications.length}`);
          return {
            rut: a.rut,
            name: w?.name || "(sin nombre)",
            paymentRut: bd[0] || a.rut,
            accountNumber: bd[1] || "",
            accountType: bd[2] != null ? Number(bd[2]) : 3,
            bankCode,
            email: w?.email || "",
            groupLeader: normalizeLeader(w?.groupLeader?.[0]),
            grossAmount: grossInt,
            advance: anticiposTotal,
            bonus: bonosTotal,
            advanceNote: advanceNoteParts.join(" · "),
            anticipoApplications,
            bonoApplications,
            anticiposTotal,
            bonosTotal,
            // adelantosTotal kept for legacy snapshot read-back; always 0 going forward.
            adelantosTotal: 0,
            amount: Math.max(0, grossInt - anticiposTotal + bonosTotal),
            byCycle,
            workdayIds: a.workdayIds || [],
            include: true,
            _missing: !cash && (!w || !bd[1] || !bd[3]),
            _accountIssue: cash ? null : accountIssue,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      setPreviewItems(items);
      setPayrollName(payrollSuggestedName());
      setStep(2);
    } finally {
      setBusy(false);
    }
  };

  const totalSelected = useMemo(
    () => previewItems.filter((p) => p.include).reduce((s, p) => s + (Number(p.amount) || 0), 0),
    [previewItems],
  );
  const countSelected = useMemo(() => previewItems.filter((p) => p.include).length, [previewItems]);
  const bankSelected = useMemo(
    () => previewItems.filter((p) => p.include && !isCashBank(p.bankCode)),
    [previewItems],
  );
  const cashSelected = useMemo(
    () => previewItems.filter((p) => p.include && isCashBank(p.bankCode)),
    [previewItems],
  );
  const cashGroups = useMemo(() => groupCashByLeader(cashSelected), [cashSelected]);

  const updatePreview = (rut, patch) => {
    setPreviewItems((prev) =>
      prev.map((p) => {
        if (p.rut !== rut) return p;
        const next = { ...p, ...patch };
        const touchesAdvance = Object.prototype.hasOwnProperty.call(patch, "advance");
        const touchesBonus = Object.prototype.hasOwnProperty.call(patch, "bonus");
        if (touchesAdvance || touchesBonus) {
          const adv = Math.max(0, Number(next.advance) || 0);
          const bon = Math.max(0, Number(next.bonus) || 0);
          next.advance = adv;
          next.bonus = bon;
          next.amount = Math.max(0, Math.round((p.grossAmount || 0) - adv + bon));
          if (touchesAdvance) {
            // Re-clip anticipoApplications oldest-first so per-advance
            // breakdown stays consistent with the (possibly reduced) total.
            const apps = (p.anticipoApplications || []).map((x) => ({ ...x }));
            let remaining = adv;
            const out = [];
            for (const ap of apps) {
              if (remaining <= 0) break;
              const take = Math.min(ap.amount, remaining);
              if (take > 0) out.push({ advanceId: ap.advanceId, amount: take });
              remaining -= take;
            }
            next.anticipoApplications = out;
            next.anticiposTotal = out.reduce((s, x) => s + x.amount, 0);
          }
          if (touchesBonus) {
            // Bonos: re-clip oldest-first too. User can lower the bono total if desired.
            const apps = (p.bonoApplications || []).map((x) => ({ ...x }));
            let remaining = bon;
            const out = [];
            for (const ap of apps) {
              if (remaining <= 0) break;
              const take = Math.min(ap.amount, remaining);
              if (take > 0) out.push({ advanceId: ap.advanceId, amount: take });
              remaining -= take;
            }
            next.bonoApplications = out;
            next.bonosTotal = out.reduce((s, x) => s + x.amount, 0);
          }
        }
        return next;
      }),
    );
  };

  const bulkUpdate = (predicate, patch) => {
    setPreviewItems((prev) => prev.map((p) => (predicate(p) ? { ...p, ...patch } : p)));
  };

  const generateAndSave = async () => {
    // Incluimos también items con amount === 0 cuando hubo anticipo aplicado
    // (caso: el anticipo cubrió todo el bruto). Si no, sus workdays no se
    // taggean ni los anticipos se marcan como aplicados — quedan huérfanos.
    // El XLSX del banco los filtra después (no se hacen transferencias de $0).
    const items = previewItems.filter(
      (p) => p.include && (Number(p.amount) > 0 || Number(p.advance) > 0),
    );
    if (items.length === 0) {
      toast.warning("No hay trabajadores seleccionados con monto > 0 ni anticipos por aplicar.");
      return;
    }
    // Para validaciones de cuenta solo consideramos los que realmente reciben
    // pago (amount > 0). Los cero-neto no van al banco.
    const payableItems = items.filter((p) => Number(p.amount) > 0);
    const missing = payableItems.filter((p) => !isCashBank(p.bankCode) && (!p.accountNumber || !p.bankCode));
    if (missing.length > 0) {
      const proceed = confirm(
        `${missing.length} trabajador(es) bancarizados tienen datos incompletos. ¿Generar de todos modos?`,
      );
      if (!proceed) return;
    }
    const suspicious = payableItems
      .map((p) => ({ p, issue: validateAccountNumber(p.accountNumber, p.bankCode) }))
      .filter((x) => x.issue);
    if (suspicious.length > 0) {
      const sample = suspicious.slice(0, 5).map((x) => `• ${x.p.name}: ${x.issue}`).join("\n");
      const proceed = confirm(
        `${suspicious.length} cuenta(s) sospechosa(s):\n${sample}${suspicious.length > 5 ? "\n…" : ""}\n\n¿Generar de todos modos?`,
      );
      if (!proceed) return;
    }
    setBusy(true);
    setProgress({ step: "Armando datos de la nómina...", detail: "", percent: 2 });
    try {
      const cycleIds = [...selectedCycleIds];
      const selectedCycles = cycles.filter((c) => cycleIds.includes(c.id));
      const cycleLabels = selectedCycles.map((c) => c.label || c.id);
      const cycleDetails = selectedCycles.map((c) => {
        const f = faenas.find((x) => x.id === c.faenaId);
        const s = subfaenas.find((x) => x.id === c.subfaenaId);
        // Período del ciclo (primer y último día). Lo tomamos de cycle.days
        // — son los días que el usuario marcó en el ciclo. Ordenamos por las
        // dudas (en general ya vienen ordenados pero no es invariante).
        const days = Array.isArray(c.days) ? [...c.days].sort() : [];
        return {
          id: c.id,
          label: c.label || c.id,
          faenaId: c.faenaId || "",
          faenaName: f?.name || "",
          subfaenaId: c.subfaenaId || "",
          subfaenaName: s?.name || "",
          firstDay: days[0] || "",
          lastDay: days[days.length - 1] || "",
        };
      });

      const cleanItems = items.map((p) => {
        const anticipoApps = (p.anticipoApplications || []).map((x) => ({
          advanceId: x.advanceId,
          amount: Math.round(Number(x.amount) || 0),
        }));
        const bonoApps = (p.bonoApplications || []).map((x) => ({
          advanceId: x.advanceId,
          amount: Math.round(Number(x.amount) || 0),
        }));
        const advanceApplications = [...anticipoApps, ...bonoApps];
        return {
          rut: p.rut,
          paymentRut: p.paymentRut || p.rut,
          name: p.name,
          accountNumber: p.accountNumber,
          bankCode: p.bankCode,
          accountType: p.accountType,
          email: p.email || "",
          groupLeader: p.groupLeader || "",
          grossAmount: Math.round(Number(p.grossAmount) || Number(p.amount) || 0),
          advance: Math.round(Number(p.advance) || 0),
          bonus: Math.round(Number(p.bonus) || 0),
          advanceNote: p.advanceNote || "",
          advanceIds: advanceApplications.map((x) => x.advanceId),
          advanceApplications,
          anticipoApplications: anticipoApps,
          bonoApplications: bonoApps,
          anticiposTotal: Math.round(Number(p.anticiposTotal) || 0),
          bonosTotal: Math.round(Number(p.bonosTotal) || 0),
          adelantosTotal: Math.round(Number(p.adelantosTotal) || 0),
          amount: Math.round(Number(p.amount) || 0),
          byCycle: p.byCycle || {},
          workdayIds: p.workdayIds || [],
        };
      });

      const allWorkdayIds = cleanItems.flatMap((p) => p.workdayIds);
      const allAdvanceIds = cleanItems.flatMap((p) => p.advanceIds || []);
      const allApplications = cleanItems.flatMap((p) => p.advanceApplications || []);
      const { bank: bankItems, cash: cashItems } = splitBankAndCash(cleanItems);

      const total = cleanItems.reduce((s, x) => s + x.amount, 0);
      const bankTotal = bankItems.reduce((s, x) => s + x.amount, 0);
      const cashTotal = cashItems.reduce((s, x) => s + x.amount, 0);
      const advanceTotalSum = cleanItems.reduce((s, x) => s + (Number(x.advance) || 0), 0);
      const bonusTotalSum = cleanItems.reduce((s, x) => s + (Number(x.bonus) || 0), 0);
      const finalName = payrollName || payrollSuggestedName();

      // Static snapshot: stores everything needed to re-render this payroll
      // without further Firestore reads (workday detail + advance origins +
      // labor configuration are embedded). Renders a static viewer page in
      // the future without depending on live data that may have changed.
      const wdIdSet = new Set(allWorkdayIds);
      const advIdSet = new Set(allAdvanceIds);
      const snapshot = {
        version: 1,
        generatedAt: new Date().toISOString(),
        payroll: {
          name: finalName,
          format: "bchile",
          classification: payrollClassification || "nomina",
          status: "pending",
          total, bankTotal, cashTotal,
          workerCount: cleanItems.length,
          bankCount: bankItems.length,
          cashCount: cashItems.length,
          advanceTotal: advanceTotalSum,
          bonusTotal: bonusTotalSum,
        },
        cycles: cycleDetails.map((cd) => {
          const cycle = cycles.find((c) => c.id === cd.id);
          return {
            ...cd,
            dayPrices: cycle?.dayPrices || {},
            labors: (cycle?.labors || []).map((l) => ({
              id: l.id, name: l.name, type: l.type,
              cosechaMode: l.cosechaMode || null,
              cosechaPrices: l.cosechaPrices || null,
              tratoMode: l.tratoMode || null,
              tratoTiers: l.tratoTiers || null,
              tratoHEDailyAmount: l.tratoHEDailyAmount ?? null,
              tratoHEOvertimeRate: l.tratoHEOvertimeRate ?? null,
              tratoHEManejoAmount: l.tratoHEManejoAmount ?? null,
              tratoHESupervisionAmount: l.tratoHESupervisionAmount ?? null,
              normalDailyAmount: l.normalDailyAmount ?? null,
            })),
          };
        }),
        workers: cleanItems,
        workdays: (previewWorkdaysRef.current || [])
          .filter((wd) => wdIdSet.has(wd.id))
          .map((wd) => ({
            id: wd.id,
            cycleId: wd.cycleId, laborId: wd.laborId,
            workerRut: wd.workerRut, date: wd.date,
            qty: wd.qty ?? null, amount: wd.amount ?? 0,
            qualityX: wd.qualityX ?? null, containerY: wd.containerY ?? null,
            tierKey: wd.tierKey ?? null, tiers: wd.tiers ?? null,
            overtimeHours: wd.overtimeHours ?? null,
            hasManejo: !!wd.hasManejo, hasSupervision: !!wd.hasSupervision,
            extras: wd.extras ?? null, isHoliday: !!wd.isHoliday,
          })),
        advances: (previewAdvancesRef.current || [])
          .filter((adv) => advIdSet.has(adv.id))
          .map((adv) => ({
            id: adv.id, workerRut: adv.workerRut,
            type: adv.type, amount: Number(adv.amount) || 0,
            amountPaid: Number(adv.amountPaid) || 0,
            date: adv.date || null, note: adv.note || "",
            status: adv.status || null,
          })),
      };

      setProgress({ step: "Creando registro de la nómina...", detail: "", percent: 5 });
      const created = await payrollsService.create({
        name: finalName,
        format: "bchile",
        classification: payrollClassification || "nomina",
        status: "pending",
        cycleIds,
        cycleLabels,
        cycleDetails,
        items: cleanItems,
        total,
        bankTotal,
        cashTotal,
        workerCount: cleanItems.length,
        bankCount: bankItems.length,
        cashCount: cashItems.length,
        workdayIds: allWorkdayIds,
        advanceIds: allAdvanceIds,
        advanceTotal: advanceTotalSum,
        hasSnapshot: true,
      });

      // Snapshot completo para guardar en `payrollSnapshots` (1:1 con payroll)
      // y para auto-bajada como JSON local.
      const fullSnapshot = { ...snapshot, payrollId: created.id };
      // Bajada local inmediata del JSON (no toca red).
      downloadSnapshotJson(finalName, fullSnapshot);

      // Los siguientes 3 pasos son independientes (solo necesitan `created.id`)
      // y antes corrían secuenciales. En paralelo:
      //   • snapshot upload (1 escritura, hasta 1MB)          ~15% del progreso
      //   • tagWorkdays (N updates, progreso real por chunk)  ~65%
      //   • applyAdvances (get M + batch update)              ~10%
      // El % es una mezcla: el de workdays viene del callback real, los demás
      // son toggles "iniciado / terminado". El XLSX ya NO se descarga
      // automáticamente — queda como acción manual desde el historial.
      const W_SNAPSHOT = 15, W_TAG = 65, W_ADV = 10;
      let snapshotDone = false, advancesDone = false;
      let tagDone = 0, tagTotal = Math.max(1, allWorkdayIds.length);
      const recompute = () => {
        const pct =
          10 + // base por crear doc
          (snapshotDone ? W_SNAPSHOT : 0) +
          W_TAG * (tagDone / tagTotal) +
          (advancesDone ? W_ADV : 0);
        const detailParts = [];
        if (allWorkdayIds.length > 0) detailParts.push(`Jornadas ${tagDone}/${tagTotal}`);
        if (allApplications.length > 0) detailParts.push(`Anticipos ${advancesDone ? "✓" : "…"}`);
        detailParts.push(`Snapshot ${snapshotDone ? "✓" : "…"}`);
        setProgress({
          step: "Guardando y aplicando descuentos en paralelo...",
          detail: detailParts.join(" · "),
          percent: pct,
        });
      };
      recompute();

      const pSnapshot = (async () => {
        try {
          await payrollSnapshotsService.upsert(created.id, fullSnapshot);
        } catch (err) {
          console.warn("No se pudo guardar el snapshot en payrollSnapshots:", err);
        }
        snapshotDone = true;
        recompute();
      })();

      const pTag = (async () => {
        await tagWorkdaysWithPayroll(allWorkdayIds, created.id, (done, total) => {
          tagDone = done;
          tagTotal = Math.max(1, total);
          recompute();
        });
      })();

      const pAdv = (async () => {
        await applyAdvancesToPayroll(allApplications, created.id);
        advancesDone = true;
        recompute();
      })();

      await Promise.all([pSnapshot, pTag, pAdv]);

      setProgress({ step: "Actualizando lista...", detail: "", percent: 95 });
      // Reset
      setSelectedCycleIds(new Set());
      saveSelection(new Set());
      setPreviewItems([]);
      setPayrollName("");
      setStep(1);
      setTab("history");
      await load();
      setProgress({ step: "Listo ✓", detail: "", percent: 100 });
    } finally {
      setBusy(false);
      // Pequeño delay para que el "Listo ✓" sea visible un instante.
      setTimeout(() => setProgress(null), 400);
    }
  };

  const onMarkPaid = async (p) => {
    await markPayrollPaid(p.id, p.workdayIds || []);
    await load();
  };
  const onMarkPending = async (p) => {
    await markPayrollPending(p.id, p.workdayIds || []);
    await load();
  };
  const onChangeClassification = async (p) => {
    const current = p.classification || "nomina";
    const next = current === "diferencia" ? "nomina" : "diferencia";
    await payrollsService.update(p.id, { classification: next });
    await load();
  };
  const [payConfirm, setPayConfirm] = useState(null); // { payroll, mode: "pay" | "revert" }
  const onAskMarkPaid = (p) => setPayConfirm({ payroll: p, mode: "pay" });
  const onAskRevert = (p) => setPayConfirm({ payroll: p, mode: "revert" });
  const onConfirmPay = async () => {
    if (!payConfirm) return;
    const { payroll: p, mode } = payConfirm;
    if (mode === "pay") {
      await markPayrollPaid(p.id, p.workdayIds || []);
    } else if (mode === "revert") {
      await markPayrollPending(p.id, p.workdayIds || []);
    }
    setPayConfirm(null);
    await load();
  };
  const onDelete = async () => {
    if (!confirmDelete) return;
    const id = confirmDelete.id;
    const workdayIds = confirmDelete.workdayIds || [];
    const advanceIds = confirmDelete.advanceIds || [];
    setConfirmDelete(null);
    setProgress({ step: "Iniciando eliminación...", detail: "", percent: 2 });
    try {
      // Las tres operaciones de cleanup (untag workdays, restore advances,
      // remove snapshot) son independientes — corren en paralelo. Solo
      // necesitamos esperarlas antes de borrar el doc principal para no
      // dejar referencias colgando.
      const W_UNTAG = 70, W_ADV = 15, W_SNAP = 10;
      let untagDone = 0, untagTotal = Math.max(1, workdayIds.length);
      let advancesDone = false, snapDone = false;
      const recompute = () => {
        const pct =
          W_UNTAG * (untagDone / untagTotal) +
          (advancesDone ? W_ADV : 0) +
          (snapDone ? W_SNAP : 0);
        const detailParts = [];
        if (workdayIds.length > 0) detailParts.push(`Jornadas ${untagDone}/${untagTotal}`);
        if (advanceIds.length > 0) detailParts.push(`Anticipos ${advancesDone ? "✓" : "…"}`);
        detailParts.push(`Snapshot ${snapDone ? "✓" : "…"}`);
        setProgress({
          step: "Liberando jornadas y anticipos...",
          detail: detailParts.join(" · "),
          percent: pct,
        });
      };
      recompute();

      const pUntag = untagWorkdaysFromPayroll(workdayIds, (done, total) => {
        untagDone = done;
        untagTotal = Math.max(1, total);
        recompute();
      });
      const pAdv = (async () => {
        await restoreAdvancesFromPayroll(advanceIds, id);
        advancesDone = true;
        recompute();
      })();
      const pSnap = (async () => {
        try { await payrollSnapshotsService.remove(id); } catch { /* noop */ }
        snapDone = true;
        recompute();
      })();

      await Promise.all([pUntag, pAdv, pSnap]);

      setProgress({ step: "Eliminando nómina...", detail: "", percent: 95 });
      await payrollsService.remove(id);
    } catch (err) {
      console.error("Error al eliminar nómina:", err);
      toast.error(`Error al eliminar la nómina: ${err?.message || err}`);
      setProgress(null);
      return;
    }
    setProgress({ step: "Actualizando lista...", detail: "", percent: 98 });
    await load();
    setProgress({ step: "Listo ✓", detail: "", percent: 100 });
    setTimeout(() => setProgress(null), 400);
  };
  const onRedownload = async (p) => {
    // Aplicar overrides persistidos en el doc (lo que el usuario editó vía
    // "📝 Editar encabezados") para que el XLSX use los nombres cortos.
    const overrides = p.cycleLabelOverrides || {};
    const cyclesForExport = (p.cycleDetails || []).map((c) => {
      // Fallback para nóminas viejas (sin firstDay/lastDay persistido):
      // miramos el cycle vivo en memoria. Si tampoco está disponible
      // (cycle borrado), queda vacío y la fila Período no se incluye.
      let firstDay = c.firstDay || "";
      let lastDay = c.lastDay || "";
      if (!firstDay && !lastDay) {
        const live = cycles.find((x) => x.id === c.id);
        if (live && Array.isArray(live.days) && live.days.length) {
          const sorted = [...live.days].sort();
          firstDay = sorted[0];
          lastDay = sorted[sorted.length - 1];
        }
      }
      return {
        id: c.id,
        label: overrides[c.id] || c.label,
        faenaId: c.faenaId,
        faenaName: c.faenaName,
        subfaenaId: c.subfaenaId,
        subfaenaName: c.subfaenaName,
        firstDay,
        lastDay,
      };
    });
    if (cyclesForExport.length === 0 && p.cycleIds) {
      for (const id of p.cycleIds) cyclesForExport.push({ id, label: overrides[id] || id });
    }
    await downloadBchileXlsx(p.items || [], p.name || "Nomina", cyclesForExport);
  };
  const onDownloadNominaOnly = async (p) => {
    const filename = `${p.name || "Nomina"}_BChile`;
    await downloadNominaOnlyXlsx(p.items || [], filename);
  };
  // Re-download the static snapshot JSON for an existing payroll. Reads it
  // from the payrollSnapshots collection; falls back to a legacy embedded
  // `p.snapshot` field if the payroll was created before the split.
  const onDownloadSnapshot = async (p) => {
    try {
      let snap = null;
      try {
        const doc = await payrollSnapshotsService.getById(p.id);
        if (doc) {
          // Strip the firestore-injected `id` field from the snapshot payload.
          const { id: _omit, ...rest } = doc;
          snap = rest;
        }
      } catch { /* noop */ }
      if (!snap && p.snapshot) snap = { ...p.snapshot, payrollId: p.id };
      if (!snap) {
        toast.warning("Esta nómina no tiene snapshot guardado (creada antes de la feature).");
        return;
      }
      downloadSnapshotJson(p.name || "Nomina", snap);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo descargar el JSON.");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Nómina</h1>
          <p className="text-sm text-[var(--color-muted)]">Generar nóminas Banco de Chile a partir de ciclos activos</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={refreshing || loading}
            title="Forzar recarga desde el servidor (ignora la cache local). Útil si otro usuario agregó workers, labores o jornadas recién."
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-3)] disabled:opacity-50"
          >
            <span className={refreshing ? "inline-block animate-spin" : "inline-block"}>↻</span>
            <span>{refreshing ? "Recargando…" : "Recargar datos"}</span>
          </button>
          <div className="flex gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1 text-sm">
            <button
              onClick={() => setTab("create")}
              className={`rounded px-3 py-1 ${
                tab === "create" ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "text-[var(--color-muted)]"
              }`}
            >
              Generar
            </button>
            <button
              onClick={() => setTab("history")}
              className={`rounded px-3 py-1 ${
                tab === "history" ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "text-[var(--color-muted)]"
              }`}
            >
              Historial Nómina ({payrolls.length})
            </button>
            <button
              onClick={() => setTab("workers")}
              className={`rounded px-3 py-1 ${
                tab === "workers" ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "text-[var(--color-muted)]"
              }`}
            >
              💰 Pagos anteriores
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-[var(--color-muted)]">Cargando...</div>
      ) : tab === "create" ? (
        step === 1 ? (
          <CycleSelector
            groups={activeByFaena}
            selected={selectedCycleIds}
            toggle={toggleCycle}
            selectedLaborsByCycle={selectedLaborsByCycle}
            toggleLaborInCycle={toggleLaborInCycle}
            subfaenaName={subfaenaName}
            cycleStats={cycleStats}
            onNext={buildPreview}
            busy={busy}
          />
        ) : (
          <PreviewTable
            items={previewItems}
            bankItems={bankSelected}
            cashGroups={cashGroups}
            updatePreview={updatePreview}
            bulkUpdate={bulkUpdate}
            payrollName={payrollName}
            setPayrollName={setPayrollName}
            payrollClassification={payrollClassification}
            setPayrollClassification={setPayrollClassification}
            totalSelected={totalSelected}
            countSelected={countSelected}
            cycleOptions={cycles
              .filter((c) => selectedCycleIds.has(c.id))
              .map((c) => ({ id: c.id, label: c.label || c.id }))}
            onBack={() => setStep(1)}
            onGenerate={generateAndSave}
            busy={busy}
          />
        )
      ) : tab === "history" ? (
        <HistoryList
          payrolls={payrolls}
          onMarkPaid={onAskMarkPaid}
          onMarkPending={onAskRevert}
          onAskDelete={setConfirmDelete}
          onRedownload={onRedownload}
          onDownloadNominaOnly={onDownloadNominaOnly}
          onDownloadSnapshot={onDownloadSnapshot}
          onChangeClassification={onChangeClassification}
          onOpen={setDetailPayroll}
        />
      ) : (
        <WorkersHistory
          faenas={faenas}
          onOpenPayroll={setDetailPayroll}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Eliminar nómina"
        message={confirmDelete ? `¿Eliminar la nómina "${confirmDelete.name}"? Esta acción no se puede deshacer.` : ""}
        confirmLabel="Eliminar"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={onDelete}
      />

      <PayConfirmModal
        info={payConfirm}
        onCancel={() => setPayConfirm(null)}
        onConfirm={onConfirmPay}
      />

      {detailPayroll && (
        <PayrollDetailModal
          payroll={detailPayroll}
          onClose={() => setDetailPayroll(null)}
          onRedownload={onRedownload}
          onDownloadNominaOnly={onDownloadNominaOnly}
          onDownloadSnapshot={onDownloadSnapshot}
          onChanged={async () => {
            // Re-fetch single payroll para refrescar el modal y la lista.
            try {
              const fresh = await payrollsService.getById(detailPayroll.id);
              if (fresh) setDetailPayroll(fresh);
              else setDetailPayroll(null);
            } catch (err) {
              console.warn("No se pudo refrescar nómina:", err);
            }
            await load();
          }}
        />
      )}

      <ProgressOverlay info={progress} />
    </div>
  );
}

// Overlay modal de progreso. Se monta solo cuando hay `info`. Muestra el paso
// actual, un detalle opcional (ej. "340 / 500") y una barra. No es cancelable
// porque la mayoría de los pasos ya están corriendo en paralelo.
function ProgressOverlay({ info }) {
  if (!info) return null;
  const pct = Math.max(0, Math.min(100, Math.round(Number(info.percent) || 0)));
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-[420px] max-w-[90vw] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-2xl">
        <div className="mb-3 flex items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
          <div className="text-sm font-medium">{info.step || "Procesando..."}</div>
        </div>
        {info.detail && (
          <div className="mb-2 text-xs text-[var(--color-muted)]">{info.detail}</div>
        )}
        <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]">
          <div
            className="h-full bg-[var(--color-accent)] transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1 text-right text-xs text-[var(--color-muted)]">{pct}%</div>
      </div>
    </div>
  );
}

function CycleSelector({ groups, selected, toggle, selectedLaborsByCycle, toggleLaborInCycle, subfaenaName, cycleStats, onNext, busy }) {
  if (groups.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] text-[var(--color-muted)]">
        No hay ciclos activos.
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col gap-4 overflow-auto">
      <div className="space-y-3">
        {groups.map(({ faena, cycles }) => (
          <div key={faena.id} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
            <div className="border-b border-[var(--color-border)] px-4 py-2 text-sm font-semibold">
              {faena.name}
            </div>
            <div className="divide-y divide-[var(--color-border)]">
              {cycles.map((c) => {
                const sub = subfaenaName(c.subfaenaId);
                const isSelected = selected.has(c.id);
                const stat = cycleStats?.[c.id] || { unpaid: 0, paid: 0, total: 0, firstDay: "", lastDay: "" };
                const periodLabel = (stat.firstDay || stat.lastDay)
                  ? (stat.firstDay === stat.lastDay
                      ? stat.firstDay
                      : `${stat.firstDay || "?"} → ${stat.lastDay || "?"}`)
                  : "";
                const noUnpaid = stat.unpaid <= 0;
                const labors = c.labors || [];
                const selectedLabors = selectedLaborsByCycle?.get(c.id) || new Set();
                const allLaborsOn = labors.length > 0 && labors.every((l) => selectedLabors.has(l.id));
                const noneOn = isSelected && labors.length > 0 && selectedLabors.size === 0;
                return (
                  <div key={c.id} className={noUnpaid ? "opacity-60" : ""}>
                    <label className="flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-[var(--color-accent-soft)]">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggle(c.id)}
                        disabled={noUnpaid && !isSelected}
                        className="h-4 w-4"
                      />
                      <div className="flex-1 text-sm">
                        <div className="font-medium">{c.label || c.id}</div>
                        {(sub || periodLabel) && (
                          <div className="flex flex-wrap items-center gap-x-2 text-xs text-[var(--color-muted)]">
                            {sub && <span>{sub}</span>}
                            {periodLabel && (
                              <span className="tabular-nums" title="Primer y último día con producción del ciclo">
                                📅 {periodLabel}
                              </span>
                            )}
                          </div>
                        )}
                        {isSelected && labors.length > 0 && !allLaborsOn && (
                          <div className="text-xs text-amber-700 dark:text-amber-400">
                            {noneOn
                              ? "⚠ Sin labores seleccionadas — no entra al preview"
                              : `Pagar ${selectedLabors.size} de ${labors.length} labores`}
                          </div>
                        )}
                      </div>
                      <div className="text-right text-xs">
                        <div className={noUnpaid ? "text-[var(--color-muted)]" : "font-semibold text-[var(--color-accent)]"}>
                          Pendiente: {fmtCurrency(stat.unpaid)}
                        </div>
                        {stat.paid > 0 && (
                          <div className="text-[var(--color-muted)]">Pagado: {fmtCurrency(stat.paid)}</div>
                        )}
                      </div>
                    </label>
                    {isSelected && labors.length > 1 && (
                      <div className="flex flex-wrap gap-1.5 border-t border-[var(--color-border)] bg-[var(--color-surface-2)]/40 px-4 py-2">
                        {labors.map((l) => {
                          const on = selectedLabors.has(l.id);
                          return (
                            <button
                              type="button"
                              key={l.id}
                              onClick={() => toggleLaborInCycle(c.id, l.id)}
                              className={`rounded-full border px-2 py-0.5 text-[11px] transition-opacity ${
                                on
                                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                                  : "border-dashed border-[var(--color-border)] bg-transparent text-[var(--color-muted)] opacity-60"
                              }`}
                              title={on ? "Excluir esta labor de la nómina" : "Incluir esta labor"}
                            >
                              {on ? "✓" : "○"} {l.name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="sticky bottom-0 mt-auto flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <div className="text-sm text-[var(--color-muted)]">
          {selected.size} ciclo(s) seleccionado(s)
        </div>
        <button
          onClick={onNext}
          disabled={selected.size === 0 || busy}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
        >
          {busy ? "Calculando..." : "Continuar →"}
        </button>
      </div>
    </div>
  );
}

function PreviewTable({
  items,
  bankItems,
  cashGroups,
  updatePreview,
  bulkUpdate,
  payrollName,
  setPayrollName,
  payrollClassification,
  setPayrollClassification,
  totalSelected,
  countSelected,
  cycleOptions = [],
  onBack,
  onGenerate,
  busy,
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all"); // all | bank | cash | missing | leader:<name>
  const [cycleFilter, setCycleFilter] = useState("all");

  const bankTotal = bankItems.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const cashTotal = cashGroups.reduce((s, g) => s + g.total, 0);
  const totalAdvance = items.reduce((s, p) => s + (p.include ? Number(p.advance) || 0 : 0), 0);

  const leaders = useMemo(() => {
    const set = new Set();
    for (const p of items) {
      const l = normalizeLeader(p.groupLeader);
      if (l) set.add(l);
    }
    return [...set].sort();
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((p) => {
      if (filter === "bank" && isCashBank(p.bankCode)) return false;
      if (filter === "cash" && !isCashBank(p.bankCode)) return false;
      if (filter === "missing" && !p._missing) return false;
      if (filter === "suspicious" && !p._accountIssue) return false;
      if (filter.startsWith("leader:") && normalizeLeader(p.groupLeader) !== filter.slice(7)) return false;
      if (cycleFilter !== "all" && !((p.byCycle?.[cycleFilter] || 0) > 0)) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.rut.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, search, filter, cycleFilter]);

  const toggleCash = (p) => {
    const newCode = isCashBank(p.bankCode) ? (p._origBank || "") : CASH_BANK_CODE;
    updatePreview(p.rut, {
      bankCode: newCode,
      _origBank: isCashBank(p.bankCode) ? p._origBank : p.bankCode,
    });
  };

  const matchPredicate = () => (p) => filteredItems.includes(p);
  const setIncludeAllVisible = (val) => bulkUpdate(matchPredicate(), { include: val });
  const setBankAllVisible = (cash) => {
    bulkUpdate(matchPredicate(), {});
    setPreviewItemsBulkBank(filteredItems, cash);
  };
  // Inline helper that uses updatePreview for safety with _origBank tracking.
  const setPreviewItemsBulkBank = (list, cash) => {
    for (const p of list) {
      if (cash && !isCashBank(p.bankCode)) toggleCash(p);
      else if (!cash && isCashBank(p.bankCode)) toggleCash(p);
    }
  };
  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <button
          onClick={onBack}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
        >
          ← Volver
        </button>
        <div className="flex flex-1 items-center gap-2">
          <label className="text-sm text-[var(--color-muted)]">Nombre:</label>
          <input
            value={payrollName}
            onChange={(e) => setPayrollName(e.target.value)}
            className="w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <label className="ml-2 text-sm text-[var(--color-muted)]">Tipo:</label>
          <select
            value={payrollClassification || "nomina"}
            onChange={(e) => setPayrollClassification(e.target.value)}
            title="Las diferencias son nóminas chicas de ajuste y se listan aparte"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          >
            <option value="nomina">Nómina</option>
            <option value="diferencia">Diferencia</option>
          </select>
        </div>
        <div className="text-sm">
          <div className="text-right">
            <span className="text-[var(--color-muted)]">{countSelected} trab.</span>
            <span className="mx-2">·</span>
            <span className="font-semibold">{fmtCurrency(totalSelected)}</span>
          </div>
          <div className="text-right text-xs text-[var(--color-muted)]">
            🏦 {fmtCurrency(bankTotal)} · 💵 {fmtCurrency(cashTotal)}
            {totalAdvance > 0 && <span> · ↩ Anticipos {fmtCurrency(totalAdvance)}</span>}
          </div>
        </div>
        <button
          onClick={onGenerate}
          disabled={busy || countSelected === 0}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
        >
          {busy ? "Generando..." : "Guardar nómina"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre o RUT..."
          className="w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        >
          <option value="all">Todos ({items.length})</option>
          <option value="bank">🏦 Banco</option>
          <option value="cash">💵 Efectivo</option>
          <option value="missing">⚠ Datos faltantes</option>
          <option value="suspicious">⚠ Cuenta sospechosa</option>
          {leaders.map((l) => (
            <option key={l} value={`leader:${l}`}>👥 {l}</option>
          ))}
        </select>
        {cycleOptions.length > 1 && (
          <select
            value={cycleFilter}
            onChange={(e) => setCycleFilter(e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            title="Filtra trabajadores que tienen producción en un ciclo específico"
          >
            <option value="all">📅 Todos los ciclos</option>
            {cycleOptions.map((c) => (
              <option key={c.id} value={c.id}>📅 {c.label}</option>
            ))}
          </select>
        )}
        <div className="ml-auto flex flex-wrap gap-1 text-xs">
          <span className="text-[var(--color-muted)]">{filteredItems.length} visibles:</span>
          <button
            onClick={() => setIncludeAllVisible(true)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
          >
            ✓ Incluir
          </button>
          <button
            onClick={() => setIncludeAllVisible(false)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
          >
            ✗ Excluir
          </button>
          <button
            onClick={() => setBankAllVisible(true)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
          >
            💵 → Efectivo
          </button>
          <button
            onClick={() => setBankAllVisible(false)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
          >
            🏦 → Banco
          </button>
        </div>
      </div>

      <ResizableArea storageKey="payroll-preview" defaultHeight={420} minHeight={240}>
      <div className="h-full overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-[var(--color-surface-2)] text-left">
            <tr>
              <th className="w-10 px-3 py-2"></th>
              <th className="px-3 py-2">RUT</th>
              <th className="px-3 py-2">Nombre</th>
              <th className="px-3 py-2">Líder</th>
              <th className="px-3 py-2">Banco / Cuenta</th>
              <th className="px-3 py-2">Tipo</th>
              <th className="px-3 py-2 text-right">Bruto</th>
              <th className="px-3 py-2 text-right">Anticipo</th>
              <th className="px-3 py-2 text-right">Bono</th>
              <th className="px-3 py-2 text-right">A pagar</th>
              <th className="px-3 py-2 text-center">Pago</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((p) => {
              const cash = isCashBank(p.bankCode);
              return (
                <tr
                  key={p.rut}
                  className={`border-t border-[var(--color-border)] ${
                    p._missing ? "bg-[var(--color-danger-soft)]" : cash ? "bg-[var(--color-accent-soft)]" : ""
                  }`}
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={p.include}
                      onChange={(e) => updatePreview(p.rut, { include: e.target.checked })}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{formatRutForDisplay(p.rut)}</td>
                  <td className="px-3 py-2">{p.name}</td>
                  <td className="px-3 py-2 text-xs text-[var(--color-muted)]">
                    {p.groupLeader || "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {cash ? (
                      <span className="font-medium">Efectivo</span>
                    ) : p.bankCode ? (
                      <>
                        {bankName(p.bankCode)}
                        <span className={`ml-1 ${p._accountIssue ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"}`}>
                          · {p.accountNumber || "—"}
                        </span>
                        {p._accountIssue && (
                          <span title={p._accountIssue} className="ml-1 cursor-help text-[var(--color-danger)]">
                            ⚠
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-[var(--color-danger)]">— faltante</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{cash ? "—" : accountTypeShort(p.accountType)}</td>
                  <td className="px-3 py-2 text-right text-xs text-[var(--color-muted)] tabular-nums">
                    {fmtCurrency(p.grossAmount || 0)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      value={p.advance || ""}
                      placeholder="0"
                      title="Anticipo a descontar"
                      onChange={(e) => updatePreview(p.rut, { advance: Number(e.target.value) || 0 })}
                      className="w-24 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-[var(--color-accent)]"
                    />
                    {Number(p.advance) > 0 && (
                      <input
                        value={p.advanceNote || ""}
                        onChange={(e) => updatePreview(p.rut, { advanceNote: e.target.value })}
                        placeholder="motivo..."
                        className="mt-1 block w-24 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-right text-[10px] text-[var(--color-muted)] outline-none focus:border-[var(--color-accent)]"
                      />
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      value={p.bonus || ""}
                      placeholder="0"
                      title="Bono a sumar"
                      onChange={(e) => updatePreview(p.rut, { bonus: Number(e.target.value) || 0 })}
                      className={`w-24 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-[var(--color-accent)] ${Number(p.bonus) > 0 ? "text-[var(--color-success)]" : ""}`}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      value={p.amount || ""}
                      placeholder="0"
                      onChange={(e) => updatePreview(p.rut, { amount: Number(e.target.value) || 0 })}
                      className="w-28 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-right text-sm font-medium tabular-nums outline-none focus:border-[var(--color-accent)]"
                    />
                    {Number(p.amount) === 0 && Number(p.advance) > 0 && (
                      <div className="mt-0.5 text-[10px] font-normal text-[var(--color-warning)]" title="El anticipo cubrió todo el bruto. Igual se incluye en la nómina para marcar workdays y anticipo como aplicados, pero no se transfiere.">
                        ↩ liquidado por anticipo
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => toggleCash(p)}
                      title={cash ? "Cambiar a banco" : "Pagar en efectivo"}
                      className={`rounded-md border px-2 py-1 text-xs ${
                        cash
                          ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                          : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"
                      }`}
                    >
                      {cash ? "💵 Efec." : "🏦 Banco"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {filteredItems.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-6 text-center text-[var(--color-muted)]">
                  {items.length === 0
                    ? "No hay trabajadores con monto en los ciclos seleccionados."
                    : "Ningún trabajador coincide con el filtro."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      </ResizableArea>

      {cashGroups.length > 0 && (
        <div className="max-h-[32vh] shrink-0 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div className="mb-2 text-sm font-semibold">💵 Efectivo agrupado por líder ({cashGroups.length})</div>
          <div className="space-y-2 text-sm">
            {cashGroups.map((g) => (
              <div key={g.leader} className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2">
                <div className="mb-1 flex items-center justify-between text-xs font-medium">
                  <span>{g.leader}</span>
                  <span>{fmtCurrency(g.total)} · {g.items.length} trab.</span>
                </div>
                <div className="text-xs text-[var(--color-muted)]">
                  {g.items.map((it) => `${it.name} (${fmtCurrency(it.amount)})`).join(" · ")}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PayConfirmModal({ info, onCancel, onConfirm }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (info) { setText(""); setBusy(false); } }, [info]);
  if (!info) return null;
  const { payroll: p, mode } = info;
  const isRevert = mode === "revert";
  const keyword = isRevert ? "No pagado" : "Pagado";
  const ok = text.trim().toLowerCase() === keyword.toLowerCase();
  const title = isRevert ? "Marcar como NO pagada" : "Marcar como pagada";
  const intro = isRevert
    ? "Vas a revertir esta nómina: el estado vuelve a pendiente y se liberan los días asociados (quedan disponibles para una nueva nómina)."
    : "Vas a marcar esta nómina como pagada. Los días asociados quedan sellados con la fecha de pago.";
  return (
    <Modal
      open
      onClose={() => !busy && onCancel()}
      title={title}
      size="md"
      footer={
        <>
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={async () => {
              if (!ok) return;
              setBusy(true);
              try { await onConfirm(); } finally { setBusy(false); }
            }}
            disabled={!ok || busy}
            className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
              isRevert
                ? "border border-[var(--color-danger)] bg-[var(--color-danger-soft)] text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white"
                : "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
            }`}
          >
            {busy ? "Procesando..." : isRevert ? "Revertir" : "Confirmar"}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
          <div className="font-medium">{p.name}</div>
          <div className="text-xs text-[var(--color-muted)] mt-1">
            {p.workerCount || 0} trab. · {fmtCurrency(p.total || 0)}
          </div>
        </div>
        <p className="text-[var(--color-muted)]">{intro}</p>
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">
            Para confirmar, escribe <code className="rounded bg-[var(--color-surface-2)] px-1 font-semibold">{keyword}</code>:
          </label>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            placeholder={keyword}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:border-[var(--color-accent)] outline-none"
          />
        </div>
      </div>
    </Modal>
  );
}

function HistoryList({ payrolls, onMarkPaid, onMarkPending, onAskDelete, onRedownload, onDownloadNominaOnly, onDownloadSnapshot, onChangeClassification, onOpen }) {
  const isMobile = useIsMobile();
  const [statusFilter, setStatusFilter] = useState("all"); // all | pending | paid
  const [monthFilter, setMonthFilter] = useState("all"); // all | YYYY-MM
  const [search, setSearch] = useState("");
  // "nomina" (default) | "diferencia". Las diferencias son nóminas chicas de
  // ajuste; viven en una pestaña aparte para no alargar la lista principal.
  // Nóminas viejas sin `classification` cuentan como "nomina".
  const [classificationTab, setClassificationTab] = useState("nomina");
  const classify = (p) => p.classification || "nomina";
  const classificationCounts = useMemo(() => {
    let nomina = 0, diferencia = 0;
    for (const p of payrolls) {
      if (classify(p) === "diferencia") diferencia += 1;
      else nomina += 1;
    }
    return { nomina, diferencia };
  }, [payrolls]);

  const monthKey = (v) => {
    const d = v?.toDate ? v.toDate() : v ? new Date(v) : null;
    if (!d || isNaN(d.getTime())) return "";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  const months = useMemo(() => {
    const set = new Set();
    for (const p of payrolls) {
      const k = monthKey(p.createdAt);
      if (k) set.add(k);
    }
    return [...set].sort().reverse();
  }, [payrolls]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return payrolls.filter((p) => {
      if (classify(p) !== classificationTab) return false;
      if (statusFilter !== "all" && (p.status || "pending") !== statusFilter) return false;
      if (monthFilter !== "all" && monthKey(p.createdAt) !== monthFilter) return false;
      if (q && !(p.name || "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [payrolls, classificationTab, statusFilter, monthFilter, search]);

  const totals = useMemo(() => {
    let pending = 0, paid = 0;
    for (const p of filtered) {
      if ((p.status || "pending") === "paid") paid += Number(p.total) || 0;
      else pending += Number(p.total) || 0;
    }
    return { pending, paid, total: pending + paid };
  }, [filtered]);

  if (payrolls.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] text-[var(--color-muted)]">
        No hay nóminas generadas todavía.
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden">
      <div className="flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1 w-fit">
        {[
          { key: "nomina", label: "Nóminas", count: classificationCounts.nomina },
          { key: "diferencia", label: "Diferencias", count: classificationCounts.diferencia },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setClassificationTab(t.key)}
            className={`rounded-md px-3 py-1.5 text-sm ${
              classificationTab === t.key
                ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                : "text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
            }`}
          >
            {t.label} <span className="ml-1 text-xs opacity-75">({t.count})</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre..."
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)] sm:w-56"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        >
          <option value="all">Todos</option>
          <option value="pending">Pendientes</option>
          <option value="paid">Pagadas</option>
        </select>
        <select
          value={monthFilter}
          onChange={(e) => setMonthFilter(e.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        >
          <option value="all">Todos los meses</option>
          {months.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <div className="ml-auto flex gap-3 text-xs">
          <span><span className="text-[var(--color-muted)]">Pendiente:</span> <span className="font-semibold text-[var(--color-warning)]">{fmtCurrency(totals.pending)}</span></span>
          <span><span className="text-[var(--color-muted)]">Pagado:</span> <span className="font-semibold text-[var(--color-success)]">{fmtCurrency(totals.paid)}</span></span>
          <span><span className="text-[var(--color-muted)]">Total:</span> <span className="font-semibold">{fmtCurrency(totals.total)}</span></span>
        </div>
      </div>

    {isMobile ? (
      <div className="flex-1 space-y-2 overflow-auto">
        {filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--color-border)] py-8 text-center text-sm text-[var(--color-muted)]">
            Ninguna nómina coincide con el filtro.
          </div>
        ) : (
          filtered.map((p) => (
            <div
              key={p.id}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <button
                    onClick={() => onOpen(p)}
                    className="text-left text-base font-medium text-[var(--color-accent)] hover:underline"
                  >
                    {p.name}
                  </button>
                  <div className="text-xs text-[var(--color-muted)]">{fmtDate(p.createdAt)}</div>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                    p.status === "paid"
                      ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                      : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
                  }`}
                >
                  {p.status === "paid" ? "Pagada" : "Pendiente"}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div className="text-[var(--color-muted)]">Trabajadores</div>
                  <div className="font-medium tabular-nums">
                    {p.workerCount || (p.items?.length ?? 0)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[var(--color-muted)]">Total</div>
                  <div className="font-semibold tabular-nums">{fmtCurrency(p.total || 0)}</div>
                </div>
                <div>
                  <div className="text-[var(--color-muted)]">🏦 Banco ({p.bankCount || 0})</div>
                  <div className="tabular-nums">{fmtCurrency(p.bankTotal || 0)}</div>
                </div>
                <div className="text-right">
                  <div className="text-[var(--color-muted)]">💵 Efectivo ({p.cashCount || 0})</div>
                  <div className="tabular-nums">{fmtCurrency(p.cashTotal || 0)}</div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1 pt-1">
                <button
                  onClick={() => onDownloadNominaOnly(p)}
                  title="Solo la hoja de Nómina BChile"
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                >
                  🏦 Nómina
                </button>
                <button
                  onClick={() => onRedownload(p)}
                  title="XLSX completo (Nómina + Resumen + Transferencias + Efectivo)"
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                >
                  📥 Completo
                </button>
                <button
                  onClick={() => onDownloadSnapshot(p)}
                  title="Descargar el JSON estático con toda la info para reconstruir esta nómina"
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                >
                  📄 JSON
                </button>
                {p.status === "paid" ? (
                  <button
                    onClick={() => onMarkPending(p)}
                    title="Revertir: marcar como No pagado"
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                  >
                    ↩ No pagado
                  </button>
                ) : (
                  <button
                    onClick={() => onMarkPaid(p)}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                  >
                    ✓ Pagada
                  </button>
                )}
                <button
                  onClick={() => onChangeClassification(p)}
                  title={classify(p) === "diferencia" ? "Mover a Nóminas" : "Mover a Diferencias"}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 py-0.5 text-[10px] leading-none hover:bg-[var(--color-accent-soft)]"
                >
                  🏷️
                </button>
                <button
                  onClick={() => onAskDelete(p)}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
                >
                  Eliminar
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    ) : (
    <ResizableArea storageKey="payroll-history" defaultHeight={440} minHeight={240}>
    <div className="h-full overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-[var(--color-surface-2)] text-left">
          <tr>
            <th className="px-3 py-2">Nombre</th>
            <th className="px-3 py-2">Estado</th>
            <th className="px-3 py-2 text-right">Trab.</th>
            <th className="px-3 py-2 text-right">🏦 Banco</th>
            <th className="px-3 py-2 text-right">💵 Efectivo</th>
            <th className="px-3 py-2 text-right">Total</th>
            <th className="px-3 py-2">Creada</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 && (
            <tr>
              <td colSpan={8} className="px-3 py-6 text-center text-[var(--color-muted)]">
                Ninguna nómina coincide con el filtro.
              </td>
            </tr>
          )}
          {filtered.map((p) => (
            <tr key={p.id} className="border-t border-[var(--color-border)]">
              <td className="px-3 py-2">
                <button onClick={() => onOpen(p)} className="text-[var(--color-accent)] hover:underline">
                  {p.name}
                </button>
              </td>
              <td className="px-3 py-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    p.status === "paid"
                      ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                      : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
                  }`}
                >
                  {p.status === "paid" ? "Pagada" : "Pendiente"}
                </span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{p.workerCount || (p.items?.length ?? 0)}</td>
              <td className="px-3 py-2 text-right text-xs tabular-nums">
                {fmtCurrency(p.bankTotal || 0)}
                <div className="text-[10px] text-[var(--color-muted)]">{p.bankCount || 0}</div>
              </td>
              <td className="px-3 py-2 text-right text-xs tabular-nums">
                {fmtCurrency(p.cashTotal || 0)}
                <div className="text-[10px] text-[var(--color-muted)]">{p.cashCount || 0}</div>
              </td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtCurrency(p.total || 0)}</td>
              <td className="px-3 py-2 text-xs text-[var(--color-muted)]">{fmtDate(p.createdAt)}</td>
              <td className="px-3 py-2">
                <div className="flex justify-end gap-1">
                  <button
                    onClick={() => onDownloadNominaOnly(p)}
                    title="Solo la hoja de Nómina BChile"
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                  >
                    🏦 Nómina
                  </button>
                  <button
                    onClick={() => onRedownload(p)}
                    title="XLSX completo (Nómina + Resumen + Transferencias + Efectivo)"
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                  >
                    📥 Completo
                  </button>
                  <button
                    onClick={() => onDownloadSnapshot(p)}
                    title="Descargar el JSON estático con toda la info para reconstruir esta nómina"
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                  >
                    📄 JSON
                  </button>
                  {p.status === "paid" ? (
                    <button
                      onClick={() => onMarkPending(p)}
                      title="Revertir: marcar como No pagado (libera los días asociados)"
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                    >
                      ↩ No pagado
                    </button>
                  ) : (
                    <button
                      onClick={() => onMarkPaid(p)}
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                    >
                      ✓ Pagada
                    </button>
                  )}
                  <button
                    onClick={() => onChangeClassification(p)}
                    title={classify(p) === "diferencia" ? "Mover a Nóminas" : "Mover a Diferencias"}
                    className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 py-0.5 text-[10px] leading-none hover:bg-[var(--color-accent-soft)]"
                  >
                    🏷️
                  </button>
                  <button
                    onClick={() => onAskDelete(p)}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
                  >
                    Eliminar
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </ResizableArea>
    )}
    </div>
  );
}

// Build a "grid snapshot" for a group of workers in a cycle: one labor table
// per labor that had production, with rows = workers and columns = days.
// Each cell content depends on labor type — mirrors the CycleDetail grid.
function buildGroupCycleSnapshot(groupRuts, cycle, workdays, nameByRut, catalogs = {}) {
  const rutSet = new Set(groupRuts);
  const wdsCycle = workdays.filter((w) => w.cycleId === cycle.id && rutSet.has(w.workerRut));
  if (wdsCycle.length === 0) return [];

  const dayPrices = cycle.dayPrices || {};
  const labors = cycle.labors || [];
  const out = [];

  for (const labor of labors) {
    const wdsLabor = wdsCycle.filter((w) => w.laborId === labor.id);
    if (wdsLabor.length === 0) continue;

    // Aggregate per (worker, date) into a cell payload.
    // Multiple workdays for same (worker, date) are summed (e.g. trato tiers
    // already handled via getTratoTierTotals; cosecha quality×container etc).
    const cellByWorkerDay = new Map(); // key: rut + "|" + date
    const dates = new Set();
    const workersInLabor = new Set();
    const containers = new Set(); // envases vistos en cosecha — define la unidad
    const tratoUnits = new Set(); // unidades del tier-day para trato (Árbol, Metro…)
    let anyPiso = false;
    for (const wd of wdsLabor) {
      const key = `${wd.workerRut}|${wd.date}`;
      dates.add(wd.date);
      workersInLabor.add(wd.workerRut);
      if (!cellByWorkerDay.has(key)) {
        cellByWorkerDay.set(key, {
          amount: 0,
          kilos: 0,
          jornadas: 0,
          overtimeHours: 0,
          extras: 0,
          piso: 0,
          hasManejo: false,
          hasSupervision: false,
          isHoliday: false,
          byCombo: {},
          byTier: {},
        });
      }
      const c = cellByWorkerDay.get(key);
      if (wd.pisoOnly) {
        const pa = Number(wd.amount) || 0;
        c.piso += pa;
        c.amount += pa;
        anyPiso = true;
        continue;
      }
      if (labor.type === "cosecha") {
        const x = Number(wd.qualityX) || 0;
        const y = Number(wd.containerY) || 0;
        // Clave estructural por combo (calidad_envase). El label visible se
        // computa al render con `comboLabel(catalogs, x, y)`.
        const ck = `${x}_${y}`;
        const kg = Number(wd.qty) || 0;
        const amt = Number(wd.amount) || 0;
        c.kilos += kg;
        c.amount += amt;
        containers.add(y);
        if (!c.byCombo[ck]) c.byCombo[ck] = { x, y, kilos: 0, amount: 0 };
        c.byCombo[ck].kilos += kg;
        c.byCombo[ck].amount += amt;
      } else if (labor.type === "trato") {
        const t = getTratoTierTotals(wd);
        c.jornadas += t.qty;
        c.amount += t.amount;
        // Recolectar las unidades configuradas en los tiers del día — se
        // denormalizan al snapshot para que el render del comprobante use
        // la unidad (Árbol, Metro, …) en vez del tipo (Poda) cuando haya.
        const tiersForDay = getTratoTiers(dayPrices, labor.id, wd.date);
        for (const tier of tiersForDay) {
          if (tier.unit != null) tratoUnits.add(tier.unit);
        }
        // Desglose por tramo del comprobante. Cada doc de trato es single-tier
        // (clave "0") y `t` ya viene reconciliado (top-level por sobre el espejo
        // `tiers`), así que lo usamos para que el desglose cuadre con el total.
        if (t.qty || t.amount) {
          const idx = "0";
          if (!c.byTier[idx]) c.byTier[idx] = { index: 0, jornadas: 0, amount: 0 };
          c.byTier[idx].jornadas += t.qty;
          c.byTier[idx].amount += t.amount;
        }
      } else if (labor.type === "tratoHE") {
        c.jornadas += Number(wd.qty) || 0;
        c.amount += Number(wd.amount) || 0;
        c.overtimeHours += Number(wd.overtimeHours) || 0;
        c.extras += Number(wd.extras) || 0;
        c.hasManejo = c.hasManejo || !!wd.hasManejo;
        c.hasSupervision = c.hasSupervision || !!wd.hasSupervision;
      } else {
        c.amount += Number(wd.amount) || 0;
        c.jornadas += 1;
      }
    }

    const sortedDates = [...dates].sort();
    const sortedRuts = [...workersInLabor].sort((a, b) =>
      (nameByRut.get(a) || a).localeCompare(nameByRut.get(b) || b),
    );

    // Build rows
    const rows = sortedRuts.map((rut) => {
      let totalAmount = 0;
      let totalKilos = 0;
      let totalJornadas = 0;
      let totalPiso = 0;
      const cells = {};
      for (const d of sortedDates) {
        const c = cellByWorkerDay.get(`${rut}|${d}`);
        if (c) {
          cells[d] = c;
          totalAmount += c.amount;
          totalKilos += c.kilos;
          totalJornadas += c.jornadas;
          totalPiso += c.piso || 0;
        }
      }
      return {
        rut,
        name: nameByRut.get(rut) || "",
        cells,
        totalAmount,
        totalKilos,
        totalJornadas,
        totalPiso,
      };
    });

    // Per-day totals — break out kilos/jornadas/etc. instead of just summing $.
    const dayTotals = {};
    let grandAmount = 0;
    let grandKilos = 0;
    let grandJornadas = 0;
    let grandOvertimeHours = 0;
    let grandExtras = 0;
    let grandPiso = 0;
    for (const d of sortedDates) {
      const agg = { amount: 0, kilos: 0, jornadas: 0, overtimeHours: 0, extras: 0, piso: 0, byCombo: {}, byTier: {} };
      for (const r of rows) {
        const c = r.cells[d];
        if (!c) continue;
        agg.amount += c.amount || 0;
        agg.kilos += c.kilos || 0;
        agg.jornadas += c.jornadas || 0;
        agg.overtimeHours += c.overtimeHours || 0;
        agg.extras += c.extras || 0;
        agg.piso += c.piso || 0;
        for (const [ck, b] of Object.entries(c.byCombo || {})) {
          if (!agg.byCombo[ck]) agg.byCombo[ck] = { x: b.x, y: b.y, kilos: 0, amount: 0 };
          agg.byCombo[ck].kilos += b.kilos;
          agg.byCombo[ck].amount += b.amount;
        }
        for (const [tk, b] of Object.entries(c.byTier || {})) {
          if (!agg.byTier[tk]) agg.byTier[tk] = { index: b.index, jornadas: 0, amount: 0 };
          agg.byTier[tk].jornadas += b.jornadas;
          agg.byTier[tk].amount += b.amount;
        }
      }
      dayTotals[d] = agg;
      grandAmount += agg.amount;
      grandKilos += agg.kilos;
      grandJornadas += agg.jornadas;
      grandOvertimeHours += agg.overtimeHours;
      grandExtras += agg.extras;
      grandPiso += agg.piso;
    }

    const priceByDate = {};
    for (const d of sortedDates) {
      priceByDate[d] = formatLaborDayPrice(labor, d, dayPrices, catalogs);
    }

    out.push({
      laborId: labor.id,
      laborName: labor.name,
      laborType: labor.type,
      tratoType: labor.tratoType ?? 0,
      cosechaContainers: [...containers],
      tratoUnits: [...tratoUnits],
      anyPiso,
      dates: sortedDates,
      rows,
      dayTotals,
      grandAmount,
      grandKilos,
      grandJornadas,
      grandOvertimeHours,
      grandExtras,
      grandPiso,
      priceByDate,
    });
  }

  return out;
}

function fmtMoneyShort(v) {
  return "$" + (Number(v) || 0).toLocaleString("es-CL");
}

// `formatLaborDayPrice` se exporta desde `utils/cosechaCombos` para que
// CycleSummaryModal lo comparta con el comprobante de pago.

function fmtDateShort(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return dateStr;
  const m = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"][d.getMonth()];
  return `${String(d.getDate()).padStart(2, "0")}-${m}`;
}

function renderProductionCell(cell, laborType, tratoLabel, kilosUnit, catalogs = {}) {
  if (!cell) return "";
  const fmtMoney = (v) => "$" + (Number(v) || 0).toLocaleString("es-CL");
  const num = (v) => (Number(v) || 0).toLocaleString("es-CL", { maximumFractionDigits: 2 });
  const pisoTag = (cell.piso || 0) > 0
    ? `<div class="muted" style="color:#b45309">🪙 Piso ${fmtMoney(cell.piso)}</div>`
    : "";
  if (laborType === "cosecha") {
    const unit = (kilosUnit || "kg").toLowerCase();
    const combos = Object.entries(cell.byCombo || {})
      .filter(([, b]) => b.kilos || b.amount)
      .sort(([, a], [, b]) => a.x - b.x || a.y - b.y);
    if (combos.length > 1) {
      // Cada combo se muestra con su label del catálogo (ej. "Premium / Saco")
      // en vez del antiguo "Q1/E2".
      const lines = combos
        .map(([, b]) => {
          const lbl = comboLabel(catalogs, b.x, b.y);
          return `<div class="muted prod-breakdown">${lbl}: ${num(b.kilos)}</div>`;
        })
        .join("");
      return `${lines}<div>${num(cell.kilos)} ${unit}</div>${pisoTag}<div class="muted">${fmtMoney(cell.amount)}</div>`;
    }
    return `<div>${num(cell.kilos)} ${unit}</div>${pisoTag}<div class="muted">${fmtMoney(cell.amount)}</div>`;
  }
  if (laborType === "trato") {
    const unit = tratoLabel || "";
    const tiers = Object.entries(cell.byTier || {})
      .filter(([, b]) => b.jornadas || b.amount)
      .sort(([, a], [, b]) => a.index - b.index);
    if (tiers.length > 1) {
      const lines = tiers
        .map(([, b]) => `<div class="muted prod-breakdown">T${b.index + 1}: ${num(b.jornadas)}</div>`)
        .join("");
      return `${lines}<div>${num(cell.jornadas)}${unit ? ` ${unit}` : ""}</div>${pisoTag}<div class="muted">${fmtMoney(cell.amount)}</div>`;
    }
    return `<div>${num(cell.jornadas)}${unit ? ` ${unit}` : ""}</div>${pisoTag}<div class="muted">${fmtMoney(cell.amount)}</div>`;
  }
  if (laborType === "tratoHE") {
    const flags = [];
    if (cell.overtimeHours) flags.push(`HE:${num(cell.overtimeHours)}h`);
    if (cell.hasManejo) flags.push("M");
    if (cell.hasSupervision) flags.push("S");
    if (cell.extras) flags.push(`X:${fmtMoney(cell.extras)}`);
    const flagsHtml = flags.length ? `<div class="muted">${flags.join(" · ")}</div>` : "";
    // jornadas now holds base $ (was a multiplier before).
    const baseHtml = cell.jornadas ? `<div>Base ${fmtMoney(cell.jornadas)}</div>` : "";
    return `${baseHtml}${flagsHtml}<div class="muted">${fmtMoney(cell.amount)}</div>`;
  }
  // main / supervision / extra
  return `<div>${fmtMoney(cell.amount)}</div>`;
}

// Like renderProductionCell, but for total rows/cells: keeps kg/jornadas
// counts visible alongside the $ instead of letting them collapse into one number.
function renderProductionTotal(totals, laborType, tratoLabel, kilosUnit, catalogs = {}) {
  if (!totals) return "";
  const fmtMoney = (v) => "$" + (Number(v) || 0).toLocaleString("es-CL");
  const num = (v) => (Number(v) || 0).toLocaleString("es-CL", { maximumFractionDigits: 2 });
  const amount = totals.amount || 0;
  const piso = totals.piso || 0;
  const pisoTag = piso > 0
    ? `<div class="muted" style="color:#b45309">🪙 ${fmtMoney(piso)}</div>`
    : "";
  if (laborType === "cosecha") {
    const kilos = totals.kilos || 0;
    const unit = (kilosUnit || "kg").toLowerCase();
    const combos = Object.entries(totals.byCombo || {})
      .filter(([, b]) => b.kilos || b.amount)
      .sort(([, a], [, b]) => a.x - b.x || a.y - b.y);
    const breakdown = combos.length > 1
      ? combos.map(([, b]) => {
          const lbl = comboLabel(catalogs, b.x, b.y);
          return `<div class="muted prod-breakdown">${lbl}: ${num(b.kilos)}</div>`;
        }).join("")
      : "";
    const kHtml = kilos ? `<div>${num(kilos)} ${unit}</div>` : "";
    return `${breakdown}${kHtml}${pisoTag}<div><b>${fmtMoney(amount)}</b></div>`;
  }
  if (laborType === "trato") {
    const j = totals.jornadas || 0;
    const unit = tratoLabel || "jorn.";
    const tiers = Object.entries(totals.byTier || {})
      .filter(([, b]) => b.jornadas || b.amount)
      .sort(([, a], [, b]) => a.index - b.index);
    const breakdown = tiers.length > 1
      ? tiers.map(([, b]) => `<div class="muted prod-breakdown">T${b.index + 1}: ${num(b.jornadas)}</div>`).join("")
      : "";
    const jHtml = j ? `<div>${num(j)} ${unit}</div>` : "";
    return `${breakdown}${jHtml}${pisoTag}<div><b>${fmtMoney(amount)}</b></div>`;
  }
  if (laborType === "tratoHE") {
    const parts = [];
    if (totals.overtimeHours) parts.push(`HE:${num(totals.overtimeHours)}h`);
    if (totals.extras) parts.push(`X:${fmtMoney(totals.extras)}`);
    const sub = parts.length ? `<div class="muted">${parts.join(" · ")}</div>` : "";
    return `${sub}<div><b>${fmtMoney(amount)}</b></div>`;
  }
  return `<div><b>${fmtMoney(amount)}</b></div>`;
}

const LABOR_TYPE_LABEL = {
  main: "Pago al día",
  supervision: "Supervisión",
  extra: "Adicional",
  cosecha: "Cosecha",
  trato: "A trato",
  tratoHE: "Jornadas con HE",
};

function buildCashReceiptHtml(payroll, cashGroups, options = {}) {
  const cycleDetails = payroll.cycleDetails || [];
  const titleOverrides = options.titleOverrides || {};
  const workdaysByGroup = options.workdaysByGroup || {}; // { leader: { cycleId: rows[] } }
  const cyclesById = options.cyclesById || {};
  const catalogs = options.catalogs || {};
  const mode = options.mode || "cash"; // "cash" | "detail"
  const isDetail = mode === "detail";
  const summaries = options.summaries || [];
  const subfaenaSummary = options.subfaenaSummary || null;
  const overviewTitle = isDetail ? "Detalle de pago" : "Comprobante de pago en efectivo";
  const docTitle = isDetail ? `${payroll.name} — Detalle pago` : `${payroll.name} — Efectivo`;
  const cycleLabel = (cycleId) => titleOverrides[cycleId] || cyclesById[cycleId]?.label || cycleDetails.find((c) => c.id === cycleId)?.label || cycleId;
  // Período del ciclo en formato dd/mm → dd/mm. Prioridad: cycleDetails
  // persistido (firstDay/lastDay), luego cyclesById (cycle.days vivo) como
  // fallback para nóminas viejas que no tienen el período guardado.
  const fmtDayShort = (d) => {
    if (!d || typeof d !== "string") return "";
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}` : d;
  };
  const cyclePeriod = (cycleId) => {
    const cd = cycleDetails.find((c) => c.id === cycleId);
    let first = cd?.firstDay || "";
    let last = cd?.lastDay || "";
    if (!first && !last) {
      const days = cyclesById[cycleId]?.days;
      if (Array.isArray(days) && days.length) {
        const sorted = [...days].sort();
        first = sorted[0]; last = sorted[sorted.length - 1];
      }
    }
    const a = fmtDayShort(first);
    const b = fmtDayShort(last);
    if (a && b && a !== b) return `${a} → ${b}`;
    return a || b || "";
  };
  // El subtítulo solo muestra los nombres de ciclo — el período va en una
  // columna propia de la tabla, no acá.
  const cyclesLine = cycleDetails.map((c) => cycleLabel(c.id)).join(" · ");
  const fmt = (v) =>
    new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 }).format(
      Number(v) || 0,
    );
  const fmtRut = (r) => {
    const m = String(r || "").match(/^(\d+)-([0-9KBH])$/i);
    if (!m) return r || "";
    return m[1].replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "-" + m[2];
  };
  const today = new Date().toLocaleDateString("es-CL");

  // Per-group leader palettes (same as Excel sheet).
  const LEADER_FILLS = ["#FFE699", "#C6E0B4", "#F8CBAD", "#B4C7E7", "#E2C2F0", "#FFC9C9", "#CFE7F5", "#D9D2E9"];
  const ITEM_FILLS   = ["#FFF2CC", "#E2EFDA", "#FCE4D6", "#D9E1F2", "#EAD8F2", "#FCE0E0", "#E7F2F8", "#EEE7F4"];

  const groupsHtml = cashGroups
    .map((g, idx) => {
      const itemFill = ITEM_FILLS[idx % ITEM_FILLS.length];
      const leaderFill = LEADER_FILLS[idx % LEADER_FILLS.length];

      // Only render cycle columns where ANY member of this group had production.
      const activeCycleIds = new Set();
      for (const it of g.items) {
        for (const cid of Object.keys(it.byCycle || {})) {
          if ((it.byCycle[cid] || 0) > 0) activeCycleIds.add(cid);
        }
      }
      const cycleCols = cycleDetails.filter((c) => activeCycleIds.has(c.id));
      const showCycleCols = cycleCols.length > 1;

      const cycleHeaders = showCycleCols
        ? cycleCols.map((c) => `<th style="text-align:right">${cycleLabel(c.id)}</th>`).join("")
        : "";

      // Show the Anticipo column whenever ANY worker in this group has an
      // advance deduction. Otherwise hide it to keep the layout clean.
      const groupHasAdvance = g.items.some((it) => (Number(it.advance) || 0) > 0);
      const groupHasBonus = g.items.some((it) => (Number(it.bonus) || 0) > 0);
      const advanceHeader = groupHasAdvance
        ? `<th style="width:110px;text-align:right">Anticipo</th>`
        : "";
      const bonusHeader = groupHasBonus
        ? `<th style="width:110px;text-align:right">Bono</th>`
        : "";

      // Desglose por subfaena/labor del trabajador. Sumamos lo que ganó por
      // cada (subfaena, labor) atravesando todos los ciclos del grupo. Se
      // muestra solo en el comprobante de efectivo (no detail), porque ahí
      // no hay columnas por ciclo y el operador necesita ver de un vistazo
      // por qué se le paga ese monto antes de firmar.
      const workerBreakdown = (it) => {
        const acc = new Map();
        const groupSnapshots = workdaysByGroup[g.leader] || {};
        for (const cid of Object.keys(groupSnapshots)) {
          const cd = cycleDetails.find((c) => c.id === cid);
          const subName = cd?.subfaenaName || cd?.label || cycleLabel(cid);
          const snapshots = groupSnapshots[cid] || [];
          for (const snap of snapshots) {
            const row = snap.rows.find((r) => r.rut === it.rut);
            if (!row || !(row.totalAmount > 0)) continue;
            const key = `${subName}||${snap.laborName}`;
            const cur = acc.get(key) || { subfaena: subName, labor: snap.laborName, amount: 0 };
            cur.amount += row.totalAmount;
            acc.set(key, cur);
          }
        }
        return [...acc.values()].sort((a, b) => {
          const s = a.subfaena.localeCompare(b.subfaena, "es");
          return s !== 0 ? s : a.labor.localeCompare(b.labor, "es");
        });
      };
      const renderDetalle = (it) => {
        const list = workerBreakdown(it);
        if (list.length === 0) return "—";
        return list.map((b) =>
          `<div style="font-size:10px;line-height:1.35"><span style="color:#666">${b.subfaena} · ${b.labor}:</span> <b>${fmt(b.amount)}</b></div>`
        ).join("");
      };

      const rows = g.items
        .map((it, i, arr) => {
          // Las últimas 3 filas se marcan para que el navegador trate de no
          // cortar la página entre ellas y la firma. Junto con
          // `break-after:avoid` en tfoot y `break-inside:avoid` en
          // .signs-block, si la firma no entra en la página actual, el
          // navegador empuja también estas filas a la página siguiente —
          // así la firma nunca queda sola.
          const keepWithSign = i >= arr.length - 3;
          const cellsByCycle = showCycleCols
            ? cycleCols
                .map(
                  (c) =>
                    `<td style="text-align:right">${
                      it.byCycle && it.byCycle[c.id] ? fmt(it.byCycle[c.id]) : ""
                    }</td>`,
                )
                .join("")
            : "";
          const advanceCell = groupHasAdvance
            ? `<td style="text-align:right;color:#b45309">${
                Number(it.advance) > 0 ? `− ${fmt(it.advance)}` : "—"
              }</td>`
            : "";
          const bonusCell = groupHasBonus
            ? `<td style="text-align:right;color:#166534">${
                Number(it.bonus) > 0 ? `+ ${fmt(it.bonus)}` : "—"
              }</td>`
            : "";
          return `
            <tr class="${keepWithSign ? "keep-with-sign" : ""}" style="background:${itemFill}">
              <td>${i + 1}</td>
              <td>${it.name}</td>
              <td class="mono">${fmtRut(it.rut)}</td>
              <td style="vertical-align:top">${renderDetalle(it)}</td>
              ${cellsByCycle}
              ${advanceCell}
              ${bonusCell}
              <td style="text-align:right"><b>${fmt(it.amount)}</b></td>
              <td></td>
            </tr>`;
        })
        .join("");

      const subtotalCells = showCycleCols
        ? cycleCols
            .map((c) => {
              const sum = g.items.reduce((s, it) => s + (it.byCycle?.[c.id] || 0), 0);
              return `<td style="text-align:right;background:${leaderFill}"><b>${fmt(sum)}</b></td>`;
            })
            .join("")
        : "";
      const advanceSubtotalCell = groupHasAdvance
        ? `<td style="text-align:right;background:${leaderFill};color:#b45309"><b>${
            (() => {
              const sum = g.items.reduce((s, it) => s + (Number(it.advance) || 0), 0);
              return sum > 0 ? `− ${fmt(sum)}` : "—";
            })()
          }</b></td>`
        : "";
      const bonusSubtotalCell = groupHasBonus
        ? `<td style="text-align:right;background:${leaderFill};color:#166534"><b>${
            (() => {
              const sum = g.items.reduce((s, it) => s + (Number(it.bonus) || 0), 0);
              return sum > 0 ? `+ ${fmt(sum)}` : "—";
            })()
          }</b></td>`
        : "";

      const totalColSpan = 3; // # + Nombre + RUT

      // Per-cycle production snapshot for THIS group — mirrors the CycleDetail
      // grid: one table per labor, rows = workers, columns = days.
      const detailHtml = cycleCols
        .map((c) => {
          const laborSnapshots = workdaysByGroup[g.leader]?.[c.id] || [];
          if (laborSnapshots.length === 0) return "";
          const laborTables = laborSnapshots
            .map((ls) => {
              // Para trato priorizamos la unidad de medida del tier-day
              // (Árbol, Metro, Polín…) cuando esté configurada. Si no, o si
              // el ciclo tiene mezcla de unidades, caemos al tipo de trato
              // (Poda, Amarre…). Para cosecha la unidad sale del envase.
              let tratoLabel = "";
              if (ls.laborType === "trato") {
                const units = ls.tratoUnits || [];
                if (units.length === 1) {
                  tratoLabel = tratoUnitLabel(catalogs, units[0]) || tratoTypeLabel(catalogs, ls.tratoType ?? 0);
                } else {
                  tratoLabel = tratoTypeLabel(catalogs, ls.tratoType ?? 0);
                }
              }
              const kilosUnit = ls.laborType === "cosecha"
                ? cosechaUnit(catalogs, new Set(ls.cosechaContainers || []))
                : "";
              const typeLabel = ls.laborType === "trato" && tratoLabel
                ? tratoLabel
                : ls.laborType === "cosecha" && kilosUnit
                  ? kilosUnit
                  : (LABOR_TYPE_LABEL[ls.laborType] || ls.laborType);
              const dayHeaders = ls.dates
                .map((d) => {
                  const price = ls.priceByDate?.[d];
                  const priceLine = price ? `<div class="muted prod-price">${price}</div>` : "";
                  return `<th class="prod-day">${fmtDateShort(d)}${priceLine}</th>`;
                })
                .join("");
              const rows = ls.rows
                .map((row) => {
                  const dayCells = ls.dates
                    .map(
                      (d) => `<td class="prod-cell">${renderProductionCell(row.cells[d], ls.laborType, tratoLabel, kilosUnit, catalogs)}</td>`,
                    )
                    .join("");
                  const rowTotalAgg = {
                    amount: row.totalAmount,
                    kilos: row.totalKilos,
                    jornadas: row.totalJornadas,
                    piso: row.totalPiso || 0,
                  };
                  return `
                    <tr>
                      <td class="prod-name">${row.name || row.rut}</td>
                      ${dayCells}
                      <td class="prod-total">${renderProductionTotal(rowTotalAgg, ls.laborType, tratoLabel, kilosUnit, catalogs)}</td>
                    </tr>`;
                })
                .join("");
              const dayTotals = ls.dates
                .map((d) => `<td class="prod-total">${renderProductionTotal(ls.dayTotals[d], ls.laborType, tratoLabel, kilosUnit, catalogs)}</td>`)
                .join("");
              const grandTotalAgg = {
                amount: ls.grandAmount,
                kilos: ls.grandKilos,
                jornadas: ls.grandJornadas,
                overtimeHours: ls.grandOvertimeHours,
                extras: ls.grandExtras,
                piso: ls.grandPiso || 0,
              };
              return `
                <div class="prod-table">
                  <h4 style="background:${itemFill}">${ls.laborName} <span class="muted">(${typeLabel})</span></h4>
                  <table class="prod">
                    <thead>
                      <tr>
                        <th class="prod-name">Trabajador</th>
                        ${dayHeaders}
                        <th class="prod-total">Total</th>
                      </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                    <tfoot>
                      <tr style="background:${leaderFill}">
                        <td class="prod-name"><b>Total día</b></td>
                        ${dayTotals}
                        <td class="prod-total">${renderProductionTotal(grandTotalAgg, ls.laborType, tratoLabel, kilosUnit, catalogs)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>`;
            })
            .join("");

          return `
            <div class="detail">
              <h3 style="background:${leaderFill}">${cycleLabel(c.id)}</h3>
              ${laborTables}
            </div>`;
        })
        .join("");

      const rowsNoSign = isDetail
        ? g.items
            .map((it, i) => {
              const cellsByCycle = showCycleCols
                ? cycleCols
                    .map(
                      (c) =>
                        `<td style="text-align:right">${
                          it.byCycle && it.byCycle[c.id] ? fmt(it.byCycle[c.id]) : ""
                        }</td>`,
                    )
                    .join("")
                : "";
              const bankTag = isCashBank(it.bankCode) ? "Efectivo" : "Transferencia";
              const advanceCell = groupHasAdvance
                ? `<td style="text-align:right;color:#b45309">${
                    Number(it.advance) > 0 ? `− ${fmt(it.advance)}` : "—"
                  }</td>`
                : "";
              const bonusCell = groupHasBonus
                ? `<td style="text-align:right;color:#166534">${
                    Number(it.bonus) > 0 ? `+ ${fmt(it.bonus)}` : "—"
                  }</td>`
                : "";
              return `
                <tr style="background:${itemFill}">
                  <td>${i + 1}</td>
                  <td>${it.name}</td>
                  <td class="mono">${fmtRut(it.rut)}</td>
                  <td style="font-size:10px;color:#555">${bankTag}</td>
                  ${cellsByCycle}
                  ${advanceCell}
                  ${bonusCell}
                  <td style="text-align:right"><b>${fmt(it.amount)}</b></td>
                </tr>`;
            })
            .join("")
        : rows;

      const overviewPage = (copyLabel) => `
    <section class="receipt">
      <header>
        <div class="hd">
          <div>
            <h1 class="group-h1">${overviewTitle} <span class="group-leader-name">— ${g.leader}</span>${copyLabel ? `<span class="copy-tag">${copyLabel}</span>` : ""}</h1>
            <div class="sub">${payroll.name} · ${cyclesLine}</div>
          </div>
          <div class="meta">
            <div><b>Fecha:</b> ${today}</div>
            <div><b>Líder:</b> ${g.leader}</div>
            <div><b>Personas:</b> ${g.items.length}</div>
          </div>
        </div>
      </header>
      <table>
        <thead>
          <tr>
            <th style="width:30px">#</th>
            <th>Nombre</th>
            <th style="width:110px">RUT</th>
            ${isDetail ? '<th style="width:90px">Forma pago</th>' : '<th style="width:240px">Detalle</th>'}
            ${cycleHeaders}
            ${advanceHeader}
            ${bonusHeader}
            <th style="width:120px;text-align:right">TOTAL</th>
            ${isDetail ? "" : '<th style="width:200px">Firma</th>'}
          </tr>
        </thead>
        <tbody>
          ${isDetail ? rowsNoSign : rows}
        </tbody>
        <tfoot>
          <tr style="background:${leaderFill}">
            <td colspan="${totalColSpan + 1}" style="text-align:right"><b>Subtotal ${g.leader}</b></td>
            ${subtotalCells}
            ${advanceSubtotalCell}
            ${bonusSubtotalCell}
            <td style="text-align:right"><b>${fmt(g.total)}</b></td>
            ${isDetail ? "" : "<td></td>"}
          </tr>
        </tfoot>
      </table>
      ${isDetail ? "" : `
      <div class="signs-block">
        <div class="signs-recap">
          Subtotal ${g.leader} · ${g.items.length} persona${g.items.length === 1 ? "" : "s"}:
          <b>${fmt(g.total)}</b>
        </div>
        <div class="signs">
          <div class="sign sign-right">
            <div class="line"></div>
            <div>Firma líder (${g.leader})</div>
          </div>
        </div>
      </div>`}
    </section>`;

      return `
    ${isDetail ? overviewPage("") : overviewPage("ORIGINAL — Líder")}
    ${isDetail ? "" : overviewPage("COPIA — Empresa")}
    ${
      detailHtml
        ? `<section class="receipt detail-page">
            <div class="hd">
              <div>
                <h1 class="group-h1">Detalle de producción <span class="group-leader-name">— ${g.leader}</span></h1>
                <div class="sub">${payroll.name}</div>
              </div>
              <div class="meta"><div><b>Fecha:</b> ${today}</div></div>
            </div>
            ${detailHtml}
          </section>`
        : ""
    }`;
    })
    .join("");

  // Resumen ejecutivo por subfaena (primera hoja del detalle imprimible).
  // Filas: subfaena (faena se imprime sólo en la 1ra fila del bloque), cols:
  // Con cuenta RUT vs Efectivo + TOTAL. Se rinde solo en mode "detail".
  const subfaenaSummaryHtml = (isDetail && subfaenaSummary && subfaenaSummary.rows.length > 0)
    ? (() => {
        // Período por subfaena: el span total que cubren los ciclos de esa
        // subfaena (primer día más temprano → último día más tardío). Si hay
        // un solo ciclo, queda el rango del ciclo tal cual.
        const subfaenaPeriod = (cycleIds) => {
          let minFirst = null;
          let maxLast = null;
          for (const cid of cycleIds) {
            const cd = cycleDetails.find((c) => c.id === cid);
            let first = cd?.firstDay || "";
            let last = cd?.lastDay || "";
            if (!first && !last) {
              const days = cyclesById[cid]?.days;
              if (Array.isArray(days) && days.length) {
                const sorted = [...days].sort();
                first = sorted[0]; last = sorted[sorted.length - 1];
              }
            }
            if (first && (!minFirst || first < minFirst)) minFirst = first;
            if (last && (!maxLast || last > maxLast)) maxLast = last;
          }
          const a = fmtDayShort(minFirst);
          const b = fmtDayShort(maxLast);
          if (a && b && a !== b) return `${a} → ${b}`;
          return a || b || "—";
        };
        let prevFaena = null;
        const rowsHtml = subfaenaSummary.rows.map((r) => {
          const showFaena = r.faenaName !== prevFaena;
          prevFaena = r.faenaName;
          return `
            <tr>
              <td>${showFaena ? r.faenaName : ""}</td>
              <td>${r.subfaenaName}</td>
              <td style="font-size:11px;color:#444">${subfaenaPeriod(r.cycleIds)}</td>
              <td style="text-align:right">${fmt(r.bank)}</td>
              <td style="text-align:right">${fmt(r.cash)}</td>
              <td style="text-align:right"><b>${fmt(r.total)}</b></td>
            </tr>`;
        }).join("");
        return `<section class="receipt summary-page">
          <div class="hd">
            <div>
              <h1>Resumen por subfaena</h1>
              <div class="sub">${payroll.name} · ${cyclesLine}</div>
            </div>
            <div class="meta"><div><b>Fecha:</b> ${today}</div></div>
          </div>
          <table class="subfaena-summary">
            <thead>
              <tr>
                <th>Faena</th>
                <th>Subfaena</th>
                <th style="width:130px">Período</th>
                <th style="text-align:right">Con cuenta RUT</th>
                <th style="text-align:right">Efectivo</th>
                <th style="text-align:right">TOTAL</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
            <tfoot>
              <tr class="summary-total">
                <td colspan="3"><b>TOTAL</b></td>
                <td style="text-align:right"><b>${fmt(subfaenaSummary.totals.bank)}</b></td>
                <td style="text-align:right"><b>${fmt(subfaenaSummary.totals.cash)}</b></td>
                <td style="text-align:right"><b>${fmt(subfaenaSummary.totals.total)}</b></td>
              </tr>
            </tfoot>
          </table>
        </section>`;
      })()
    : "";

  const summariesHtml = (isDetail && summaries.length > 0)
    ? `<section class="receipt summary-page">
        <div class="hd">
          <div>
            <h1>Resumen por grupo</h1>
            <div class="sub">${payroll.name} · ${cyclesLine}</div>
          </div>
          <div class="meta"><div><b>Fecha:</b> ${today}</div></div>
        </div>
        ${summaries.map((s) => {
          const rowsHtml = s.rows.map((r) => {
            const faenas = (r.byFaena && r.byFaena.length > 0)
              ? r.byFaena
              : [{ faenaName: "—", total: r.total }];
            return faenas.map((f, i) => `
              <tr>
                <td>${i === 0 ? `<b>${r.leader}</b>` : ""}</td>
                <td>${f.faenaName}</td>
                <td style="text-align:right">${fmt(f.total)}</td>
              </tr>`).join("");
          }).join("");
          return `
          <div class="summary-block">
            <h3>${s.title}</h3>
            <table class="group-summary">
              <thead>
                <tr>
                  <th>Líder</th>
                  <th>Faena</th>
                  <th style="text-align:right">TOTAL</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
              <tfoot>
                <tr class="summary-total">
                  <td colspan="2"><b>Total ${s.title}</b></td>
                  <td style="text-align:right"><b>${fmt(s.total)}</b></td>
                </tr>
              </tfoot>
            </table>
          </div>`;
        }).join("")}
      </section>`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"><title>${docTitle}</title>
<style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; color: #222; }
  .receipt { padding: 22px 28px; page-break-after: always; }
  .receipt:last-child { page-break-after: auto; }
  .hd { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; border-bottom: 2px solid #555; padding-bottom: 10px; margin-bottom: 12px; }
  h1 { margin: 0 0 4px; font-size: 18px; }
  .copy-tag { font-size: 10px; font-weight: 600; padding: 2px 8px; margin-left: 8px; border: 1px solid #999; border-radius: 4px; vertical-align: middle; background: #FFE699; color: #555; }
  .sub { color: #666; font-size: 12px; }
  .meta { font-size: 12px; text-align: right; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { background: #B7DEE8; }
  th, td { border: 1px solid #999; padding: 5px 7px; }
  th .muted { font-weight: normal; color: #666; font-size: 10px; }
  .mono { font-family: ui-monospace, monospace; }
  /* Bloque firma + recap del subtotal. El recap repite el subtotal del grupo
     justo encima de la firma — si la paginación rompe entre la tabla y la
     firma, el recap garantiza que la página de la firma no quede vacía de
     contexto (subtotal grupo X · N personas · $YYY). break-inside: avoid
     mantiene el recap pegado a la firma como una unidad. Tamaños comprimidos
     ~75% del original para minimizar casos borde de paginación. */
  /* Cadena de "avoid break" para que la firma jamás quede sola en una hoja:
     últimas 3 filas (.keep-with-sign) → tfoot → .signs-block. Si la firma
     no entra en la página actual, el navegador empuja también las 3 filas
     marcadas y el tfoot a la página siguiente. Soportado por todos los
     navegadores modernos en print (Chrome/Edge/Firefox/Safari). */
  tbody tr.keep-with-sign { break-after: avoid; page-break-after: avoid; }
  tfoot { break-after: avoid; page-break-after: avoid; }
  .signs-block { break-inside: avoid; page-break-inside: avoid; margin-top: 18px; }
  .signs-recap { text-align: right; font-size: 10px; color: #444; padding: 4px 0; border-top: 1px dashed #999; }
  .signs { display: flex; justify-content: flex-end; margin-top: 18px; gap: 45px; font-size: 11px; }
  .sign { width: 210px; text-align: center; }
  .sign-right { margin-left: auto; }
  .line { border-top: 1px solid #444; margin-bottom: 3px; height: 22px; }
  .detail-title { font-size: 14px; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #999; }
  .detail { margin-top: 12px; }
  .detail h3 { font-size: 12px; padding: 4px 8px; margin: 0 0 6px; border: 1px solid #999; }
  .prod-table { margin: 6px 0 12px; }
  .prod-table h4 { font-size: 11px; padding: 3px 6px; margin: 0 0 0; border: 1px solid #999; border-bottom: none; }
  .prod-table h4 .muted { font-weight: normal; color: #555; font-size: 10px; }
  table.prod { width: 100%; font-size: 10px; table-layout: auto; }
  table.prod .prod-name { text-align: left; min-width: 110px; }
  table.prod .prod-day { text-align: center; min-width: 60px; }
  table.prod .prod-cell { text-align: center; }
  table.prod .prod-cell .muted { color: #555; font-size: 9px; }
  table.prod .prod-day .prod-price { color: #555; font-size: 9px; font-weight: normal; margin-top: 1px; }
  table.prod .prod-breakdown { font-size: 9px; color: #555; line-height: 1.2; }
  .summary-block { margin: 16px 0; }
  .summary-block h3 { font-size: 13px; margin: 0 0 6px; padding: 4px 8px; background: #F2F2F2; border: 1px solid #999; }
  table.summary { width: 60%; min-width: 320px; }
  table.summary .summary-total td { background: #FFE699; }
  table.group-summary { width: 100%; margin-top: 8px; }
  table.group-summary .summary-total td { background: #FFE699; }
  h1.group-h1 { font-size: 22px; }
  h1.group-h1 .group-leader-name { color: #555; font-weight: 600; }
  table.subfaena-summary { width: 100%; margin-top: 8px; }
  table.subfaena-summary .summary-total td { background: #FFE699; }
  table.prod .prod-total { text-align: right; min-width: 70px; }
  @media print { @page { margin: 14mm landscape; } .receipt { padding: 0; } }
</style>
</head><body>${subfaenaSummaryHtml}${summariesHtml}${groupsHtml}
<script>window.onload = () => { window.focus(); window.print(); };</script>
</body></html>`;
}

async function printPaymentDetails(payroll, allGroups, titleOverrides = {}, summaries = [], catalogs = {}, subfaenaSummary = null) {
  if (allGroups.length === 0) return;
  const cycleIds = payroll.cycleIds || (payroll.cycleDetails || []).map((c) => c.id);
  const cycles = await Promise.all(cycleIds.map((id) => cyclesService.getById(id)));
  const cyclesById = {};
  for (const c of cycles) if (c) cyclesById[c.id] = c;

  const allItems = allGroups.flatMap((g) => g.items);
  const wdIdSet = new Set(allItems.flatMap((it) => it.workdayIds || []));
  const workdays = [];
  for (let i = 0; i < cycleIds.length; i += 10) {
    const chunk = cycleIds.slice(i, i + 10);
    if (chunk.length === 0) continue;
    const wds = await workdaysService.list({ wheres: [["cycleId", "in", chunk]] });
    for (const w of wds) if (wdIdSet.has(w.id)) workdays.push(w);
  }

  const nameByRut = new Map(allItems.map((it) => [it.rut, it.name]));
  const workdaysByGroup = {};
  for (const g of allGroups) {
    const groupRuts = g.items.map((it) => it.rut);
    const byCycle = {};
    for (const cid of cycleIds) {
      const cycle = cyclesById[cid];
      if (!cycle) continue;
      byCycle[cid] = buildGroupCycleSnapshot(groupRuts, cycle, workdays, nameByRut, catalogs);
    }
    workdaysByGroup[g.leader] = byCycle;
  }

  const html = buildCashReceiptHtml(payroll, allGroups, {
    titleOverrides,
    workdaysByGroup,
    cyclesById,
    catalogs,
    mode: "detail",
    summaries,
    subfaenaSummary,
  });
  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) {
    throw new Error("Permite las ventanas emergentes para imprimir.");
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

async function printCashReceipts(payroll, cashGroups, titleOverrides = {}, catalogs = {}) {
  if (cashGroups.length === 0) return;

  // Load cycles (for labor types) + workdays linked to cash items.
  const cycleIds = payroll.cycleIds || (payroll.cycleDetails || []).map((c) => c.id);
  const cycles = await Promise.all(cycleIds.map((id) => cyclesService.getById(id)));
  const cyclesById = {};
  for (const c of cycles) if (c) cyclesById[c.id] = c;

  // Workday ids: union of all cash items.
  const cashItems = cashGroups.flatMap((g) => g.items);
  const wdIdSet = new Set(cashItems.flatMap((it) => it.workdayIds || []));
  const workdays = [];
  for (let i = 0; i < cycleIds.length; i += 10) {
    const chunk = cycleIds.slice(i, i + 10);
    if (chunk.length === 0) continue;
    const wds = await workdaysService.list({ wheres: [["cycleId", "in", chunk]] });
    for (const w of wds) if (wdIdSet.has(w.id)) workdays.push(w);
  }

  // For each group, for each cycle, build per-labor production snapshots.
  const nameByRut = new Map(cashItems.map((it) => [it.rut, it.name]));
  const workdaysByGroup = {};
  for (const g of cashGroups) {
    const groupRuts = g.items.map((it) => it.rut);
    const byCycle = {};
    for (const cid of cycleIds) {
      const cycle = cyclesById[cid];
      if (!cycle) continue;
      byCycle[cid] = buildGroupCycleSnapshot(groupRuts, cycle, workdays, nameByRut, catalogs);
    }
    workdaysByGroup[g.leader] = byCycle;
  }

  const html = buildCashReceiptHtml(payroll, cashGroups, {
    titleOverrides,
    workdaysByGroup,
    cyclesById,
    catalogs,
  });
  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) {
    throw new Error("Permite las ventanas emergentes para imprimir.");
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function PayrollDetailModal({ payroll, onClose, onRedownload, onDownloadNominaOnly, onDownloadSnapshot, onChanged }) {
  const { catalogs } = useCatalogs();
  const toast = useToast();
  const items = payroll.items || [];
  const { bank, cash } = splitBankAndCash(items);
  const cashGroups = groupCashByLeader(cash);
  const allGroups = groupCashByLeader(items); // groups everyone (bank + cash) by leader

  // Filtros y estado de UI para el HUD mejorado.
  const [search, setSearch] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("all"); // all | bank | cash
  const [leaderFilter, setLeaderFilter] = useState(() => new Set());
  const [cycleFilter, setCycleFilter] = useState(() => new Set());
  const [expandedRut, setExpandedRut] = useState(null);
  const [collapsedSections, setCollapsedSections] = useState(() => new Set());
  const [printingGroupLeader, setPrintingGroupLeader] = useState(null);
  const [workerSummaryFor, setWorkerSummaryFor] = useState(null);

  const toggleSection = (key) => setCollapsedSections((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const isCollapsed = (key) => collapsedSections.has(key);
  const toggleSetItem = (setter, value) => setter((prev) => {
    const next = new Set(prev);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  });

  // Líderes únicos en la nómina (para el filtro de grupo).
  const allLeaders = useMemo(() => {
    const set = new Map(); // label → count
    for (const it of items) {
      const l = normalizeLeader(it.groupLeader || "") || "SIN GRUPO";
      set.set(l, (set.get(l) || 0) + 1);
    }
    return [...set.entries()]
      .map(([leader, count]) => ({ leader, count }))
      .sort((a, b) => a.leader.localeCompare(b.leader, "es"));
  }, [items]);

  // Filtrado de items aplicando todos los criterios juntos.
  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (q) {
        const hay = `${it.rut || ""} ${it.name || ""} ${it.groupLeader || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      const isCash = isCashBank(it.bankCode);
      if (paymentMethod === "bank" && isCash) return false;
      if (paymentMethod === "cash" && !isCash) return false;
      if (leaderFilter.size > 0) {
        const l = normalizeLeader(it.groupLeader || "") || "SIN GRUPO";
        if (!leaderFilter.has(l)) return false;
      }
      if (cycleFilter.size > 0) {
        const hasAny = [...cycleFilter].some((cid) => (Number(it.byCycle?.[cid]) || 0) > 0);
        if (!hasAny) return false;
      }
      return true;
    });
  }, [items, search, paymentMethod, leaderFilter, cycleFilter]);

  const filteredSplit = useMemo(() => splitBankAndCash(filteredItems), [filteredItems]);
  const filteredBank = filteredSplit.bank;
  const filteredCash = filteredSplit.cash;
  const filteredCashGroups = useMemo(() => groupCashByLeader(filteredCash), [filteredCash]);
  // Banco también agrupado por líder, para poder imprimir el detalle por grupo
  // (ej. solo CHILENOS) igual que en efectivo. groupCashByLeader sirve para
  // cualquier conjunto de items, no solo cash.
  const filteredBankGroups = useMemo(() => groupCashByLeader(filteredBank), [filteredBank]);

  const hasActiveFilter = !!(search || paymentMethod !== "all" || leaderFilter.size > 0 || cycleFilter.size > 0);
  const clearFilters = () => {
    setSearch("");
    setPaymentMethod("all");
    setLeaderFilter(new Set());
    setCycleFilter(new Set());
  };

  // Two leader-total summary tables shown at the top of "Detalle pago":
  //   1) "Con cuenta RUT": CHILENOS + EXTRANJEROSCONCUENTARUT (each row separate).
  //   2) "Otros grupos": every other leader (each row separate).
  const detailSummaries = (() => {
    const CRUT_LEADERS = new Set(["CHILENOS", "EXTRANJEROSCONCUENTARUT"]);
    const compact = (s) => normalizeLeader(s).replace(/\s+/g, "");
    const inCrut = (g) => CRUT_LEADERS.has(compact(g.leader));

    // Map cycleId → faenaName (fallback al label del ciclo para nóminas
    // viejas que no traen info de faena).
    const faenaByCycle = new Map();
    for (const cd of payroll.cycleDetails || []) {
      faenaByCycle.set(cd.id, cd.faenaName || cd.label || "—");
    }
    const groupWithFaenas = (g) => {
      const byFaena = new Map();
      for (const it of g.items) {
        for (const [cid, amt] of Object.entries(it.byCycle || {})) {
          const fName = faenaByCycle.get(cid) || "—";
          byFaena.set(fName, (byFaena.get(fName) || 0) + (Number(amt) || 0));
        }
      }
      const byFaenaList = [...byFaena.entries()]
        .map(([faenaName, total]) => ({ faenaName, total }))
        .filter((f) => f.total > 0)
        .sort((a, b) => a.faenaName.localeCompare(b.faenaName, "es"));
      return { leader: g.leader, total: g.total, byFaena: byFaenaList };
    };

    const crut = allGroups.filter(inCrut).map(groupWithFaenas);
    const others = allGroups.filter((g) => !inCrut(g)).map(groupWithFaenas);
    const sumOf = (arr) => arr.reduce((s, g) => s + (Number(g.total) || 0), 0);
    const out = [];
    if (crut.length) {
      out.push({ title: "Con cuenta RUT", rows: crut, total: sumOf(crut) });
    }
    if (others.length) {
      out.push({ title: "Otros grupos", rows: others, total: sumOf(others) });
    }
    return out;
  })();

  const cycleDetails = payroll.cycleDetails || [];

  // Edit mode: permite sacar un trabajador o un ciclo entero de la nómina.
  // Solo disponible si la nómina está pendiente (paga = revertir primero).
  const isPending = payroll.status !== "paid";
  const [editMode, setEditMode] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const handleRemoveWorker = async (item) => {
    if (!isPending || editBusy) return;
    const label = `${item.name || item.rut} (${fmtCurrency(item.amount || 0)})`;
    if (!window.confirm(`¿Sacar a ${label} de esta nómina?\n\nSe liberan sus workdays y se restauran sus anticipos aplicados. No se puede deshacer (pero podés re-incluirlo generando otra nómina).`)) return;
    setEditBusy(true);
    try {
      await removeWorkerFromPayroll(payroll.id, item.rut);
      await onChanged?.();
    } catch (err) {
      toast.error(`Error al sacar el trabajador: ${err?.message || err}`);
    } finally {
      setEditBusy(false);
    }
  };
  const handleRemoveCycle = async (cycle) => {
    if (!isPending || editBusy) return;
    const cycleAmount = (payroll.items || []).reduce(
      (s, it) => s + (Number(it.byCycle?.[cycle.id]) || 0),
      0,
    );
    if (!window.confirm(`¿Sacar el ciclo "${cycle.label}" (${fmtCurrency(cycleAmount)}) de esta nómina?\n\nSe liberan los workdays del ciclo. Los trabajadores que SOLO tenían producción en este ciclo salen también; los que tenían producción en otros ciclos quedan con su monto reducido. No se puede deshacer.`)) return;
    setEditBusy(true);
    try {
      await removeCycleFromPayroll(payroll.id, cycle.id);
      await onChanged?.();
    } catch (err) {
      toast.error(`Error al sacar el ciclo: ${err?.message || err}`);
    } finally {
      setEditBusy(false);
    }
  };

  // Resumen ejecutivo por subfaena (primera hoja del "Detalle de pago"
  // imprimible). Filas: subfaenas con monto > 0, ordenadas por faena y
  // subfaena. Columnas: "Con cuenta RUT" (todas las transferencias) vs
  // "Efectivo". Si la nómina vieja no trae info de subfaena, los rows
  // muestran "—" / label del ciclo y de todos modos se rinden.
  const subfaenaSummary = (() => {
    const bySubfaena = new Map();
    for (const cd of cycleDetails) {
      const sId = cd.subfaenaId || `__${cd.id}__`;
      if (!bySubfaena.has(sId)) {
        bySubfaena.set(sId, {
          subfaenaName: cd.subfaenaName || cd.label || "—",
          faenaName: cd.faenaName || "—",
          cycleIds: new Set(),
        });
      }
      bySubfaena.get(sId).cycleIds.add(cd.id);
    }
    const sumForCycles = (arr, cycleIds) =>
      arr.reduce((s, it) => {
        let row = 0;
        for (const cid of cycleIds) row += Number(it.byCycle?.[cid]) || 0;
        return s + row;
      }, 0);
    const rows = [...bySubfaena.values()]
      .map((r) => ({
        ...r,
        bank: sumForCycles(bank, r.cycleIds),
        cash: sumForCycles(cash, r.cycleIds),
      }))
      .filter((r) => r.bank + r.cash > 0)
      .map((r) => ({ ...r, total: r.bank + r.cash }))
      .sort((a, b) => {
        const fa = a.faenaName.localeCompare(b.faenaName, "es");
        if (fa !== 0) return fa;
        return a.subfaenaName.localeCompare(b.subfaenaName, "es");
      });
    const totals = rows.reduce(
      (acc, r) => ({
        bank: acc.bank + r.bank,
        cash: acc.cash + r.cash,
        total: acc.total + r.total,
      }),
      { bank: 0, cash: 0, total: 0 },
    );
    return { rows, totals };
  })();

  // Aggregate breakdowns for the summary header.
  const bankTotal = bank.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const cashTotal = cash.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const grossTotal = items.reduce((s, x) => s + (Number(x.grossAmount) || Number(x.amount) || 0), 0);
  const advanceTotal = items.reduce((s, x) => s + (Number(x.advance) || 0), 0);
  const bonusTotal = items.reduce((s, x) => s + (Number(x.bonus) || 0), 0);
  const totalsByCycle = (cycleDetails || []).map((c) => {
    const bankSum = bank.reduce((s, x) => s + (x.byCycle?.[c.id] || 0), 0);
    const cashSum = cash.reduce((s, x) => s + (x.byCycle?.[c.id] || 0), 0);
    return { cycle: c, bank: bankSum, cash: cashSum, total: bankSum + cashSum };
  });

  // Encabezados editables por ciclo. Se guardan en el doc de la nómina
  // (`payroll.cycleLabelOverrides`) para que persistan entre dispositivos y
  // se apliquen a XLSX, comprobantes y PDF de detalle. Fallback: si la
  // nómina no tiene el campo todavía pero existe localStorage de una
  // versión vieja, lo migramos al primer save.
  const titleStorageKey = `cash_receipt_titles_${payroll.id || payroll.name}`;
  const [cycleTitleOverrides, setCycleTitleOverrides] = useState(() => {
    const fromPayroll = payroll?.cycleLabelOverrides;
    if (fromPayroll && Object.keys(fromPayroll).length > 0) return { ...fromPayroll };
    try { return JSON.parse(localStorage.getItem(titleStorageKey) || "{}"); } catch { return {}; }
  });
  const [showTitleEditor, setShowTitleEditor] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printingDetail, setPrintingDetail] = useState(false);
  const [showCashEstimation, setShowCashEstimation] = useState(false);

  const setCycleTitle = (cid, val) => {
    setCycleTitleOverrides((prev) => {
      const next = { ...prev };
      const trimmed = String(val || "").trim();
      // Vacío = restaurar default; no guardamos override.
      if (!trimmed) delete next[cid];
      else next[cid] = val;
      return next;
    });
  };

  // Persistencia debounced en Firestore. Cada cambio en cycleTitleOverrides
  // espera 500ms de inactividad y luego escribe. localStorage queda como
  // espejo por compatibilidad con la versión anterior.
  useEffect(() => {
    if (!payroll?.id) return;
    const t = setTimeout(() => {
      try { localStorage.setItem(titleStorageKey, JSON.stringify(cycleTitleOverrides)); } catch {
        /* noop */
      }
      payrollsService
        .update(payroll.id, { cycleLabelOverrides: cycleTitleOverrides })
        .catch((err) => console.warn("No se pudo guardar overrides:", err));
    }, 500);
    return () => clearTimeout(t);
  }, [cycleTitleOverrides, payroll?.id, titleStorageKey]);

  // Helper para mostrar el label con override aplicado.
  const displayCycleLabel = (cycle) =>
    cycleTitleOverrides[cycle.id] || cycle.label || cycle.id;

  const handlePrint = async () => {
    setPrinting(true);
    try {
      await printCashReceipts(payroll, cashGroups, cycleTitleOverrides, catalogs);
    } catch (err) {
      toast.error(err?.message || "Error al imprimir");
    } finally {
      setPrinting(false);
    }
  };

  const handlePrintDetail = async () => {
    setPrintingDetail(true);
    try {
      await printPaymentDetails(payroll, allGroups, cycleTitleOverrides, detailSummaries, catalogs, subfaenaSummary);
    } catch (err) {
      toast.error(err?.message || "Error al imprimir");
    } finally {
      setPrintingDetail(false);
    }
  };

  // Imprime el detalle por grupo (un solo líder) usando el mismo flujo que el
  // detalle de pago completo, pero con un solo grupo. Útil para entregar la
  // hoja del líder X sin imprimir todo lo demás. `key` se usa para distinguir
  // banco vs efectivo del mismo líder en el estado de loading (ej. CHILENOS
  // puede tener gente en ambos lados).
  const handlePrintGroupDetail = async (group, key) => {
    const loadingKey = key || group.leader;
    setPrintingGroupLeader(loadingKey);
    try {
      await printPaymentDetails(payroll, [group], cycleTitleOverrides, [], catalogs, null);
    } catch (err) {
      toast.error(err?.message || "Error al imprimir grupo");
    } finally {
      setPrintingGroupLeader(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-2 py-3 sm:px-4 sm:py-6" onClick={onClose}>
      <div
        className="flex max-h-[94vh] w-full max-w-4xl flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl sm:max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">{payroll.name}</h2>
              {cycleDetails.length > 0 && (
                <button
                  onClick={() => setShowTitleEditor((v) => !v)}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] hover:bg-[var(--color-accent-soft)]"
                  title="Cambiar el nombre con el que cada ciclo aparece en XLSX, comprobantes y PDF"
                >
                  📝 Editar encabezados
                </button>
              )}
              {isPending && (
                <button
                  onClick={() => setEditMode((v) => !v)}
                  className={`rounded border px-2 py-0.5 text-[10px] ${
                    editMode
                      ? "border-[var(--color-danger)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
                      : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"
                  }`}
                  title="Sacar trabajadores o ciclos enteros de esta nómina"
                >
                  {editMode ? "✕ Cerrar edición" : "✂ Editar contenido"}
                </button>
              )}
            </div>
            <p className="text-xs text-[var(--color-muted)]">
              {cycleDetails.length > 0
                ? cycleDetails.map((c) => displayCycleLabel(c)).join(" · ")
                : (payroll.cycleLabels || []).join(" · ") || "—"}
            </p>
          </div>
          <button onClick={onClose} className="ml-3 text-[var(--color-muted)] hover:text-[var(--color-text)]">✕</button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-3 py-3 sm:space-y-5 sm:px-5 sm:py-4">
          {showTitleEditor && cycleDetails.length > 0 && (
            <section className="rounded-lg border border-[var(--color-accent)]/50 bg-[var(--color-accent-soft)]/40 p-4">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">📝 Encabezados de ciclo</h3>
                <button
                  onClick={() => setShowTitleEditor(false)}
                  className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
                >
                  ✕
                </button>
              </div>
              <p className="mb-3 text-[11px] text-[var(--color-muted)]">
                Personalizá cómo aparece cada ciclo en el XLSX, los comprobantes y el PDF de detalle.
                Dejar vacío para restaurar el nombre original. Los cambios se guardan automáticamente.
              </p>
              <div className="space-y-2">
                {cycleDetails.map((c) => {
                  const override = cycleTitleOverrides[c.id];
                  const hasOverride = !!override;
                  return (
                    <div key={c.id} className="flex items-center gap-2">
                      <label
                        className="w-44 shrink-0 truncate text-[11px] text-[var(--color-muted)]"
                        title={c.label}
                      >
                        {c.label}
                      </label>
                      <input
                        value={override ?? ""}
                        placeholder={c.label}
                        onChange={(e) => setCycleTitle(c.id, e.target.value)}
                        className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
                      />
                      {hasOverride && (
                        <button
                          onClick={() => setCycleTitle(c.id, "")}
                          className="rounded px-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)]"
                          title="Restaurar el nombre original"
                        >
                          ↺
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Barra de filtros: búsqueda + forma de pago + grupo + ciclo.
              Edge-to-edge sticky (negativos -mx/-mt anulan el padding del padre
              para que el fondo opaco cubra todo el ancho cuando se scrollea —
              sino quedan gaps transparentes a los costados). */}
          <section className="sticky top-0 z-20 -mx-3 -mt-3 mb-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 pb-2 pt-2 shadow-sm sm:-mx-5 sm:-mt-4 sm:px-5 sm:pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="🔍 Buscar por RUT, nombre o líder…"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)] sm:w-auto sm:min-w-[200px] sm:flex-1"
              />
              <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-border)] text-xs">
                {[
                  { v: "all", l: "Todos" },
                  { v: "bank", l: "🏦 Banco" },
                  { v: "cash", l: "💵 Efectivo" },
                ].map((o) => (
                  <button
                    key={o.v}
                    onClick={() => setPaymentMethod(o.v)}
                    className={`border-l border-[var(--color-border)] px-2 py-1 first:border-l-0 ${
                      paymentMethod === o.v ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"
                    }`}
                  >
                    {o.l}
                  </button>
                ))}
              </div>
              {hasActiveFilter && (
                <button
                  onClick={clearFilters}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-danger)]"
                >
                  ✕ Limpiar
                </button>
              )}
              <span className="ml-auto text-[10px] text-[var(--color-muted)] tabular-nums">
                {hasActiveFilter ? `${filteredItems.length}/${items.length}` : items.length} trabajador{items.length === 1 ? "" : "es"}
                {hasActiveFilter && ` · ${fmtCurrency(filteredItems.reduce((s, x) => s + (Number(x.amount) || 0), 0))}`}
              </span>
            </div>
            {allLeaders.length > 1 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px]">
                <span className="text-[var(--color-muted)] mr-1">Grupo:</span>
                {allLeaders.map((g) => {
                  const active = leaderFilter.has(g.leader);
                  return (
                    <button
                      key={g.leader}
                      onClick={() => toggleSetItem(setLeaderFilter, g.leader)}
                      className={`rounded-full px-2 py-0.5 ${
                        active
                          ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                          : "bg-[var(--color-surface-2)] border border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]"
                      }`}
                    >
                      {g.leader} <span className="opacity-60">({g.count})</span>
                    </button>
                  );
                })}
                {leaderFilter.size > 0 && (
                  <button onClick={() => setLeaderFilter(new Set())} className="text-[var(--color-muted)] hover:text-[var(--color-danger)]">✕</button>
                )}
              </div>
            )}
            {cycleDetails.length > 1 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px]">
                <span className="text-[var(--color-muted)] mr-1">Ciclo:</span>
                {cycleDetails.map((c) => {
                  const active = cycleFilter.has(c.id);
                  return (
                    <button
                      key={c.id}
                      onClick={() => toggleSetItem(setCycleFilter, c.id)}
                      className={`rounded-full px-2 py-0.5 ${
                        active
                          ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                          : "bg-[var(--color-surface-2)] border border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]"
                      }`}
                      title={c.faenaName ? `${c.faenaName}${c.subfaenaName ? " / " + c.subfaenaName : ""}` : c.label}
                    >
                      {displayCycleLabel(c)}
                    </button>
                  );
                })}
                {cycleFilter.size > 0 && (
                  <button onClick={() => setCycleFilter(new Set())} className="text-[var(--color-muted)] hover:text-[var(--color-danger)]">✕</button>
                )}
              </div>
            )}
          </section>

          {/* Resumen — desglose general */}
          <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
            <h3 className="mb-3 text-sm font-semibold">Resumen</h3>
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <div className="text-xs text-[var(--color-muted)]">🏦 Transferencias</div>
                <div className="text-lg font-semibold">{fmtCurrency(bankTotal)}</div>
                <div className="text-[10px] text-[var(--color-muted)]">{bank.length} persona(s)</div>
              </div>
              <div>
                <div className="text-xs text-[var(--color-muted)]">💵 Efectivo</div>
                <div className="text-lg font-semibold">{fmtCurrency(cashTotal)}</div>
                <div className="text-[10px] text-[var(--color-muted)]">{cash.length} persona(s) · {cashGroups.length} grupo(s)</div>
              </div>
              {advanceTotal > 0 && (
                <div>
                  <div className="text-xs text-[var(--color-muted)]">↩ Anticipos aplicados</div>
                  <div className="text-lg font-semibold text-[var(--color-warning)]">− {fmtCurrency(advanceTotal)}</div>
                  <div className="text-[10px] text-[var(--color-muted)]">Bruto: {fmtCurrency(grossTotal)}</div>
                </div>
              )}
              {bonusTotal > 0 && (
                <div>
                  <div className="text-xs text-[var(--color-muted)]">🎁 Bonos aplicados</div>
                  <div className="text-lg font-semibold text-[var(--color-success)]">+ {fmtCurrency(bonusTotal)}</div>
                </div>
              )}
              <div>
                <div className="text-xs text-[var(--color-muted)]">Total a pagar</div>
                <div className="text-lg font-semibold text-[var(--color-accent)]">{fmtCurrency(payroll.total || 0)}</div>
                <div className="text-[10px] text-[var(--color-muted)]">{items.length} trabajador(es)</div>
              </div>
            </div>

            {totalsByCycle.length > 1 && (
              <div className="mt-4 overflow-x-auto rounded-md border border-[var(--color-border)]">
                <table className="w-full text-xs">
                  <thead className="bg-[var(--color-surface-2)] text-left text-[var(--color-muted)]">
                    <tr>
                      <th className="px-2 py-1.5">Ciclo</th>
                      <th className="px-2 py-1.5 text-right">🏦 Banco</th>
                      <th className="px-2 py-1.5 text-right">💵 Efectivo</th>
                      <th className="px-2 py-1.5 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {totalsByCycle.map(({ cycle, bank: b, cash: c, total }) => (
                      <tr key={cycle.id} className="border-t border-[var(--color-border)]">
                        <td className="px-2 py-1">
                          <span className="font-medium">{displayCycleLabel(cycle)}</span>
                          {cycle.faenaName && (
                            <span className="ml-1 text-[10px] text-[var(--color-muted)]">
                              · {cycle.faenaName}{cycle.subfaenaName ? `/${cycle.subfaenaName}` : ""}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmtCurrency(b)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmtCurrency(c)}</td>
                        <td className="px-2 py-1 text-right font-semibold tabular-nums">{fmtCurrency(total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {cycleDetails.length > 0 && (
            <section>
              <button
                type="button"
                onClick={() => toggleSection("cycles")}
                className="mb-2 flex w-full items-center gap-2 text-left text-sm font-semibold hover:text-[var(--color-accent)]"
              >
                <span>{isCollapsed("cycles") ? "▸" : "▾"}</span>
                <span>Ciclos / Faenas pagadas ({cycleDetails.length})</span>
              </button>
              {!isCollapsed("cycles") && (
                <>
                  <ul className="space-y-1 text-sm">
                    {cycleDetails.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5">
                        <div className="min-w-0">
                          <span className="font-medium">{c.label}</span>
                          {c.faenaName && (
                            <span className="ml-2 text-xs text-[var(--color-muted)]">
                              {c.faenaName}{c.subfaenaName ? ` / ${c.subfaenaName}` : ""}
                            </span>
                          )}
                          {(c.firstDay || c.lastDay) && (
                            <span className="ml-2 text-[10px] text-[var(--color-muted)] tabular-nums">
                              📅 {c.firstDay || "?"}{c.lastDay && c.firstDay !== c.lastDay ? ` → ${c.lastDay}` : ""}
                            </span>
                          )}
                        </div>
                        {editMode && cycleDetails.length > 1 && (
                          <button
                            type="button"
                            disabled={editBusy}
                            onClick={() => handleRemoveCycle(c)}
                            className="shrink-0 rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-2 py-0.5 text-[10px] text-[var(--color-danger)] hover:opacity-80 disabled:opacity-50"
                            title="Sacar este ciclo entero de la nómina"
                          >
                            ✕ Quitar ciclo
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {editMode && cycleDetails.length === 1 && (
                    <p className="mt-1 text-[10px] text-[var(--color-muted)]">
                      Para sacar el único ciclo, eliminá la nómina entera.
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          {filteredBankGroups.length > 0 && (
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">🏦 Banco agrupado por líder ({filteredBank.length}{filteredBank.length !== bank.length ? `/${bank.length}` : ""})</h3>
                <span className="text-xs font-normal tabular-nums text-[var(--color-muted)]">
                  {fmtCurrency(filteredBank.reduce((s, x) => s + (Number(x.amount) || 0), 0))}
                </span>
              </div>
              <div className="space-y-2">
                {filteredBankGroups.map((g) => {
                  const sectionKey = `bank_${g.leader}`;
                  const collapsed = isCollapsed(sectionKey);
                  const groupKey = `bank:${g.leader}`;
                  return (
                    <div key={g.leader} className="rounded border border-[var(--color-border)]">
                      <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm">
                        <button
                          type="button"
                          onClick={() => toggleSection(sectionKey)}
                          className="flex flex-1 items-center gap-2 text-left hover:text-[var(--color-accent)]"
                        >
                          <span>{collapsed ? "▸" : "▾"}</span>
                          <span className="font-medium">{g.leader}</span>
                          <span className="text-[10px] text-[var(--color-muted)]">· {g.items.length} pers.</span>
                        </button>
                        <span className="font-semibold tabular-nums">{fmtCurrency(g.total)}</span>
                        <button
                          type="button"
                          disabled={printingGroupLeader === groupKey}
                          onClick={() => handlePrintGroupDetail(g, groupKey)}
                          title="Imprimir el detalle de pago solo para este grupo de transferencias"
                          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px] hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
                        >
                          {printingGroupLeader === groupKey ? "..." : "🖨 Imprimir"}
                        </button>
                      </div>
                      {!collapsed && (
                        <div className="overflow-x-auto">
                        <table className="w-full min-w-[640px] text-sm sm:min-w-0">
                          <thead className="bg-[var(--color-surface-2)] text-left text-[var(--color-muted)]">
                            <tr>
                              <th className="px-2 py-1 w-4"></th>
                              <th className="px-2 py-1">RUT</th>
                              <th className="px-2 py-1">Nombre</th>
                              <th className="px-2 py-1">Banco</th>
                              <th className="px-2 py-1">Cuenta</th>
                              <th className="px-2 py-1">Tipo</th>
                              <th className="px-2 py-1 text-right">Monto</th>
                              {editMode && <th className="px-2 py-1"></th>}
                            </tr>
                          </thead>
                          <tbody>
                            {g.items.map((it) => (
                              <WorkerDetailRow
                                key={it.rut}
                                item={it}
                                expanded={expandedRut === it.rut}
                                onToggle={() => setExpandedRut((cur) => cur === it.rut ? null : it.rut)}
                                onShowSummary={() => setWorkerSummaryFor(it)}
                                cycleDetails={cycleDetails}
                                displayCycleLabel={displayCycleLabel}
                                editMode={editMode}
                                editBusy={editBusy}
                                onRemoveWorker={handleRemoveWorker}
                                cols="bank"
                              />
                            ))}
                          </tbody>
                        </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {filteredCashGroups.length > 0 && (
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">💵 Efectivo agrupado por líder ({filteredCash.length}{filteredCash.length !== cash.length ? `/${cash.length}` : ""})</h3>
                <span className="text-xs font-normal tabular-nums text-[var(--color-muted)]">
                  {fmtCurrency(filteredCash.reduce((s, x) => s + (Number(x.amount) || 0), 0))}
                </span>
              </div>
              <div className="space-y-2">
                {filteredCashGroups.map((g) => {
                  const sectionKey = `cash_${g.leader}`;
                  const collapsed = isCollapsed(sectionKey);
                  const groupKey = `cash:${g.leader}`;
                  return (
                    <div key={g.leader} className="rounded border border-[var(--color-border)]">
                      <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm">
                        <button
                          type="button"
                          onClick={() => toggleSection(sectionKey)}
                          className="flex flex-1 items-center gap-2 text-left hover:text-[var(--color-accent)]"
                        >
                          <span>{collapsed ? "▸" : "▾"}</span>
                          <span className="font-medium">{g.leader}</span>
                          <span className="text-[10px] text-[var(--color-muted)]">· {g.items.length} pers.</span>
                        </button>
                        <span className="font-semibold tabular-nums">{fmtCurrency(g.total)}</span>
                        <button
                          type="button"
                          disabled={printingGroupLeader === groupKey}
                          onClick={() => handlePrintGroupDetail(g, groupKey)}
                          title="Imprimir el detalle de pago solo para este grupo (mismo formato que el comprobante en efectivo)"
                          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px] hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
                        >
                          {printingGroupLeader === groupKey ? "..." : "🖨 Imprimir"}
                        </button>
                      </div>
                      {!collapsed && (
                        <table className="w-full text-sm">
                          <tbody>
                            {g.items.map((it) => (
                              <WorkerDetailRow
                                key={it.rut}
                                item={it}
                                expanded={expandedRut === it.rut}
                                onToggle={() => setExpandedRut((cur) => cur === it.rut ? null : it.rut)}
                                onShowSummary={() => setWorkerSummaryFor(it)}
                                cycleDetails={cycleDetails}
                                displayCycleLabel={displayCycleLabel}
                                editMode={editMode}
                                editBusy={editBusy}
                                onRemoveWorker={handleRemoveWorker}
                                cols="cash"
                              />
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <div className="flex justify-end border-t border-[var(--color-border)] pt-3 text-sm font-semibold">
            <span>TOTAL: {fmtCurrency(payroll.total || 0)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5 border-t border-[var(--color-border)] px-3 py-3 sm:gap-2 sm:px-5">
          {cash.length > 0 && (
            <button
              onClick={() => setShowCashEstimation(true)}
              title="Cuántos billetes y monedas de cada denominación se necesitan para pagar el efectivo de esta nómina"
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-accent-soft)]"
            >
              💵 Estimación efectivo
            </button>
          )}
          {cashGroups.length > 0 && (
            <button
              onClick={handlePrint}
              disabled={printing}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
            >
              {printing ? "Cargando..." : "🖨 Comprobantes efectivo"}
            </button>
          )}
          {allGroups.length > 0 && (
            <button
              onClick={handlePrintDetail}
              disabled={printingDetail}
              title="Detalle de pago de todos los trabajadores (efectivo + transferencia), sin firma ni copia"
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
            >
              {printingDetail ? "Cargando..." : "📄 Detalle pago"}
            </button>
          )}
          <button
            onClick={() => onDownloadNominaOnly(payroll)}
            title="Solo la hoja de Nómina BChile (para subir al banco)"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-accent-soft)]"
          >
            🏦 Sólo Nómina
          </button>
          <button
            onClick={() => onDownloadSnapshot(payroll)}
            title="Descargar el JSON estático con toda la info para reconstruir esta nómina"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-accent-soft)]"
          >
            📄 JSON
          </button>
          <button
            onClick={() => onRedownload(payroll)}
            title="XLSX completo (Nómina + Resumen + Transferencias + Efectivo)"
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)]"
          >
            📥 XLSX completo
          </button>
        </div>
      </div>
      <WorkerSummaryModal
        open={!!workerSummaryFor}
        worker={workerSummaryFor ? { id: workerSummaryFor.rut, name: workerSummaryFor.name } : null}
        onClose={() => setWorkerSummaryFor(null)}
      />
      {showCashEstimation && (
        <CashEstimationModal
          cashItems={cash}
          payrollName={payroll.name}
          onClose={() => setShowCashEstimation(false)}
        />
      )}
    </div>
  );
}

// Modal de estimación de efectivo: dice cuántos billetes/monedas de cada
// denominación se necesitan para pagar la nómina en efectivo. Cada monto se
// redondea HACIA ARRIBA al múltiplo de $100 más cercano para garantizar que
// sea descomponible exactamente con denominaciones de [10000, 5000, 1000,
// 500, 100].
function CashEstimationModal({ cashItems, payrollName, onClose }) {
  const toast = useToast();
  const est = useMemo(() => estimateCashBreakdown(cashItems), [cashItems]);
  const [showDetail, setShowDetail] = useState(false);
  const [busy, setBusy] = useState("");
  const captureRef = useRef(null);
  const diff = est.totalNeeded - est.totalOriginal;

  // Snapshot textual del desglose principal (sin el detalle por trabajador,
  // para que entre en un chat o nota). Las cantidades quedan alineadas con
  // padStart para que se lea ordenado en monospace.
  const buildPlainText = () => {
    const lines = [];
    lines.push(`💵 Estimación de efectivo — ${payrollName}`);
    lines.push(`${cashItems.length} trabajador(es) · Total: ${fmtCurrency(est.totalNeeded)}`);
    if (diff > 0) {
      lines.push(`(Original ${fmtCurrency(est.totalOriginal)} + redondeo ${fmtCurrency(diff)})`);
    }
    lines.push("");
    lines.push("Billetes y monedas:");
    for (const d of CASH_DENOMINATIONS) {
      const n = est.counts.get(d) || 0;
      if (n === 0) continue;
      const isBill = d >= 1000;
      const denomStr = fmtCurrency(d).padStart(9, " ");
      const qtyStr = String(n).padStart(4, " ");
      const subStr = fmtCurrency(n * d).padStart(11, " ");
      lines.push(`  ${denomStr} ${isBill ? "billete" : " moneda"} × ${qtyStr} = ${subStr}`);
    }
    lines.push("");
    const totalQty = [...est.counts.values()].reduce((s, v) => s + v, 0);
    lines.push(`Total: ${totalQty} billetes/monedas · ${fmtCurrency(est.totalNeeded)}`);
    return lines.join("\n");
  };

  const handleCopyText = async () => {
    setBusy("text");
    try {
      await navigator.clipboard.writeText(buildPlainText());
      toast.success("Texto copiado");
    } catch (err) {
      toast.error("Error al copiar: " + (err.message || err));
    } finally {
      setBusy("");
    }
  };

  const handleCopyImage = async () => {
    if (!captureRef.current) return;
    setBusy("image");
    try {
      const blob = await toBlob(captureRef.current, {
        backgroundColor: "#ffffff",
        pixelRatio: 2,
      });
      if (!blob) throw new Error("No se pudo generar la imagen");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast.success("Imagen copiada");
    } catch (err) {
      toast.error("Error al copiar: " + (err.message || err));
    } finally {
      setBusy("");
    }
  };

  return (
    <Modal open onClose={onClose} title="💵 Estimación de efectivo" size="lg">
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-[var(--color-muted)]">
            Para <b>{payrollName}</b> · {cashItems.length} trabajador(es) en efectivo.
            Cada monto se redondea hacia arriba al múltiplo de $100 más cercano.
          </p>
          <div className="flex gap-1">
            <button
              onClick={handleCopyText}
              disabled={busy === "text"}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
              title="Copiar el desglose como texto plano (para pegar en chat o notas)"
            >
              {busy === "text" ? "..." : "📋 Texto"}
            </button>
            <button
              onClick={handleCopyImage}
              disabled={busy === "image"}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)] disabled:opacity-50"
              title="Copiar el desglose como imagen al portapapeles"
            >
              {busy === "image" ? "..." : "📋 Imagen"}
            </button>
          </div>
        </div>
        <div ref={captureRef} className="space-y-4" style={{ background: "var(--color-surface)" }}>

        {/* Total destacado */}
        <div className="rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-3">
          <div className="text-xs text-[var(--color-muted)]">Total efectivo a llevar</div>
          <div className="text-2xl font-bold tabular-nums text-[var(--color-accent)]">
            {fmtCurrency(est.totalNeeded)}
          </div>
          {diff > 0 && (
            <div className="mt-1 text-[11px] text-[var(--color-muted)]">
              Original: {fmtCurrency(est.totalOriginal)} · Redondeo hacia arriba: +{fmtCurrency(diff)}
            </div>
          )}
        </div>

        {/* Tabla de denominaciones */}
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Billetes y monedas necesarios
          </h4>
          <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-surface-2)] text-left text-[var(--color-muted)]">
                <tr>
                  <th className="px-3 py-1.5">Denominación</th>
                  <th className="px-3 py-1.5 text-right">Cantidad</th>
                  <th className="px-3 py-1.5 text-right">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {CASH_DENOMINATIONS.map((d) => {
                  const n = est.counts.get(d) || 0;
                  const isBill = d >= 1000;
                  return (
                    <tr key={d} className="border-t border-[var(--color-border)]">
                      <td className="px-3 py-1.5">
                        <span className="font-medium">{fmtCurrency(d)}</span>
                        <span className="ml-2 text-[10px] text-[var(--color-muted)]">
                          {isBill ? "billete" : "moneda"}
                        </span>
                      </td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${n === 0 ? "text-[var(--color-muted)]" : "font-semibold"}`}>
                        {n}
                      </td>
                      <td className={`px-3 py-1.5 text-right tabular-nums ${n === 0 ? "text-[var(--color-muted)]" : ""}`}>
                        {fmtCurrency(n * d)}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-[var(--color-border)] bg-[var(--color-surface-2)]/60 font-semibold">
                  <td className="px-3 py-1.5">Total</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {[...est.counts.values()].reduce((s, v) => s + v, 0)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-[var(--color-accent)]">
                    {fmtCurrency(est.totalNeeded)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        </div>

        {/* Detalle por trabajador (colapsable) — fuera del captureRef para que
            no entre en la imagen copiada (puede ser muy largo). */}
        <div>
          <button
            type="button"
            onClick={() => setShowDetail((v) => !v)}
            className="flex w-full items-center gap-2 text-left text-xs font-semibold text-[var(--color-muted)] hover:text-[var(--color-accent)]"
          >
            <span>{showDetail ? "▾" : "▸"}</span>
            <span>Detalle por trabajador ({est.perWorker.length})</span>
          </button>
          {showDetail && (
            <div className="mt-2 overflow-x-auto rounded-md border border-[var(--color-border)]">
              <table className="w-full text-xs">
                <thead className="bg-[var(--color-surface-2)] text-left text-[var(--color-muted)]">
                  <tr>
                    <th className="px-2 py-1">Nombre</th>
                    <th className="px-2 py-1 text-right">Original</th>
                    <th className="px-2 py-1 text-right">Redondeado</th>
                    {CASH_DENOMINATIONS.map((d) => (
                      <th key={d} className="px-2 py-1 text-right">{fmtCurrency(d).replace("$", "")}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {est.perWorker.map((w) => (
                    <tr key={w.rut} className="border-t border-[var(--color-border)]">
                      <td className="px-2 py-1">
                        <div className="font-medium">{w.name}</div>
                        {w.leader && (
                          <div className="text-[9px] text-[var(--color-muted)]">{w.leader}</div>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtCurrency(w.original)}</td>
                      <td className="px-2 py-1 text-right tabular-nums font-semibold">
                        {fmtCurrency(w.rounded)}
                        {w.delta > 0 && (
                          <div className="text-[9px] text-[var(--color-muted)]">+{fmtCurrency(w.delta)}</div>
                        )}
                      </td>
                      {CASH_DENOMINATIONS.map((d) => (
                        <td key={d} className="px-2 py-1 text-right tabular-nums">
                          {w.breakdown[d] || ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Fila expandible para banco/efectivo. Click → muestra el desglose interno
// de la nómina (byCycle + anticipos aplicados + bonos aplicados + bruto/
// descuentos/neto). Botón "📅 Ver días" abre el WorkerSummaryModal completo.
function WorkerDetailRow({
  item, expanded, onToggle, onShowSummary, cycleDetails, displayCycleLabel,
  editMode, editBusy, onRemoveWorker, cols,
}) {
  const isBank = cols === "bank";
  const colSpan = isBank ? (editMode ? 8 : 7) : (editMode ? 4 : 3);
  const byCycleEntries = Object.entries(item.byCycle || {})
    .filter(([, v]) => Number(v) > 0)
    .map(([cid, amt]) => {
      const c = cycleDetails.find((x) => x.id === cid);
      return { id: cid, label: c ? displayCycleLabel(c) : cid, faena: c?.faenaName, subfaena: c?.subfaenaName, amount: Number(amt) };
    });
  return (
    <>
      <tr
        className="cursor-pointer border-t border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]"
        onClick={onToggle}
      >
        {isBank ? (
          <>
            <td className="px-2 py-1 text-center text-[var(--color-muted)]">{expanded ? "▾" : "▸"}</td>
            <td className="px-2 py-1 font-mono text-xs">{formatRutForDisplay(item.rut)}</td>
            <td className="px-2 py-1">{item.name}</td>
            <td className="px-2 py-1 text-xs">{bankName(item.bankCode)}</td>
            <td className="px-2 py-1 font-mono text-xs">{item.accountNumber}</td>
            <td className="px-2 py-1 text-xs">{accountTypeShort(item.accountType)}</td>
            <td className="px-2 py-1 text-right tabular-nums">{fmtCurrency(item.amount)}</td>
          </>
        ) : (
          <>
            <td className="px-2 py-1 text-center text-[var(--color-muted)]">{expanded ? "▾" : "▸"}</td>
            <td className="px-2 py-1 font-mono text-xs">{formatRutForDisplay(item.rut)}</td>
            <td className="px-2 py-1">{item.name}</td>
            <td className="px-2 py-1 text-right tabular-nums">{fmtCurrency(item.amount)}</td>
          </>
        )}
        {editMode && (
          <td className="px-2 py-1 text-right" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              disabled={editBusy}
              onClick={() => onRemoveWorker(item)}
              className="rounded border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-1.5 py-0.5 text-[10px] text-[var(--color-danger)] hover:opacity-80 disabled:opacity-50"
              title="Sacar trabajador de la nómina"
            >
              ✕
            </button>
          </td>
        )}
      </tr>
      {expanded && (
        <tr className="border-t border-[var(--color-border)] bg-[var(--color-surface-2)]/60">
          <td colSpan={colSpan} className="px-3 py-2.5">
            <div className="flex flex-col gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-[var(--color-text)]">Detalle del pago en esta nómina</span>
                <button
                  type="button"
                  onClick={onShowSummary}
                  className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-fg)]"
                >
                  📅 Ver días completos
                </button>
                {item.groupLeader && (
                  <span className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px]">
                    👥 Líder: <b>{item.groupLeader}</b>
                  </span>
                )}
                {item.email && (
                  <span className="text-[10px] text-[var(--color-muted)]">✉ {item.email}</span>
                )}
              </div>

              {byCycleEntries.length > 0 && (
                <div>
                  <div className="mb-0.5 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">Por ciclo</div>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {byCycleEntries.map((e) => (
                      <div key={e.id} className="flex items-center justify-between gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{e.label}</div>
                          {(e.faena || e.subfaena) && (
                            <div className="truncate text-[10px] text-[var(--color-muted)]">
                              {e.faena}{e.subfaena ? ` / ${e.subfaena}` : ""}
                            </div>
                          )}
                        </div>
                        <span className="shrink-0 font-semibold tabular-nums">{fmtCurrency(e.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5">
                  <div className="text-[9px] uppercase text-[var(--color-muted)]">Bruto</div>
                  <div className="font-bold tabular-nums">{fmtCurrency(item.grossAmount || item.amount || 0)}</div>
                </div>
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5">
                  <div className="text-[9px] uppercase text-[var(--color-muted)]">Anticipos</div>
                  <div className="font-bold tabular-nums text-amber-600 dark:text-amber-400">
                    {Number(item.advance) > 0 ? `−${fmtCurrency(item.advance)}` : "—"}
                  </div>
                  {(item.anticipoApplications || []).length > 0 && (
                    <div className="mt-0.5 text-[9px] text-[var(--color-muted)]">
                      {(item.anticipoApplications || []).length} aplicación{(item.anticipoApplications || []).length === 1 ? "" : "es"}
                    </div>
                  )}
                </div>
                <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5">
                  <div className="text-[9px] uppercase text-[var(--color-muted)]">Bonos</div>
                  <div className="font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {Number(item.bonus) > 0 ? `+${fmtCurrency(item.bonus)}` : "—"}
                  </div>
                  {(item.bonoApplications || []).length > 0 && (
                    <div className="mt-0.5 text-[9px] text-[var(--color-muted)]">
                      {(item.bonoApplications || []).length} aplicación{(item.bonoApplications || []).length === 1 ? "" : "es"}
                    </div>
                  )}
                </div>
                <div className="rounded border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-1.5">
                  <div className="text-[9px] uppercase text-[var(--color-muted)]">Neto</div>
                  <div className="font-bold tabular-nums text-[var(--color-accent)]">{fmtCurrency(item.amount || 0)}</div>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─────────────────────────── Workers History ───────────────────────────
// Buscador retroactivo de pagos por trabajador. Carga todas las nóminas
// (sin tope) y filtra cliente-side por rango de fechas, tipo y faena.
// Default: últimos 6 meses, todas las clasificaciones.

const sixMonthsAgoISO = () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d.toISOString().slice(0, 10);
};
const todayISO = () => new Date().toISOString().slice(0, 10);

const payrollDate = (p) => {
  if (p?.createdAt?.toDate) return p.createdAt.toDate();
  if (p?.createdAt?.seconds) return new Date(p.createdAt.seconds * 1000);
  return new Date(0);
};
const payrollDateISO = (p) => {
  const d = payrollDate(p);
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
};

const normRut = (r) => String(r || "").replace(/[^a-z0-9]/gi, "").toLowerCase();

function WorkersHistory({ faenas, onOpenPayroll }) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [allPayrolls, setAllPayrolls] = useState([]);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState(sixMonthsAgoISO());
  const [dateTo, setDateTo] = useState(todayISO());
  const [classification, setClassification] = useState("all"); // all|nomina|diferencia
  const [faenaFilter, setFaenaFilter] = useState(() => new Set());
  const [selectedRut, setSelectedRut] = useState(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const list = await payrollsService.list({ order: ["createdAt", "desc"] });
        if (!cancelled) setAllPayrolls(list);
      } catch (err) {
        toast.error("No se pudieron cargar las nóminas: " + (err?.message || err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const faenaById = useMemo(() => new Map(faenas.map((f) => [f.id, f])), [faenas]);

  // 1) Filtramos payrolls por rango de fechas + clasificación.
  const filteredPayrolls = useMemo(() => {
    return allPayrolls.filter((p) => {
      const iso = payrollDateISO(p);
      if (dateFrom && iso && iso < dateFrom) return false;
      if (dateTo && iso && iso > dateTo) return false;
      if (classification !== "all" && (p.classification || "nomina") !== classification) return false;
      return true;
    });
  }, [allPayrolls, dateFrom, dateTo, classification]);

  // 2) Index workers: por RUT, lista de pagos enriquecidos.
  const workersIndex = useMemo(() => {
    const map = new Map();
    for (const p of filteredPayrolls) {
      for (const it of (p.items || [])) {
        if (!it.rut) continue;
        if (!map.has(it.rut)) {
          map.set(it.rut, {
            rut: it.rut,
            name: it.name || "",
            totalAmount: 0,
            totalGross: 0,
            totalAdvance: 0,
            totalBonus: 0,
            payments: [],
          });
        }
        const w = map.get(it.rut);
        if (it.name && (!w.name || w.name === it.rut)) w.name = it.name;
        const amount = Number(it.amount) || 0;
        const gross = Number(it.grossAmount) || amount;
        const advance = Number(it.advance) || Number(it.anticiposTotal) || 0;
        const bonus = Number(it.bonus) || Number(it.bonosTotal) || 0;
        // Faenas que cubre este pago según byCycle + cycleDetails.
        const payFaenaIds = new Set();
        const payFaenaNames = new Set();
        const cds = p.cycleDetails || [];
        for (const cid of Object.keys(it.byCycle || {})) {
          if ((it.byCycle[cid] || 0) > 0) {
            const cd = cds.find((c) => c.id === cid);
            if (cd?.faenaId) payFaenaIds.add(cd.faenaId);
            if (cd?.faenaName) payFaenaNames.add(cd.faenaName);
          }
        }
        w.totalAmount += amount;
        w.totalGross += gross;
        w.totalAdvance += advance;
        w.totalBonus += bonus;
        w.payments.push({
          payrollId: p.id,
          payrollName: p.name || "(sin nombre)",
          payrollDate: payrollDate(p),
          payrollDateISO: payrollDateISO(p),
          classification: p.classification || "nomina",
          status: p.status || "pending",
          amount, gross, advance, bonus,
          // Líder de grupo congelado al momento de la nómina (item.groupLeader
          // se persiste cuando se genera). Útil para auditoría: a quién
          // estaba asignado el trabajador entonces, no quien lo lidera hoy.
          groupLeader: it.groupLeader || "",
          faenaIds: payFaenaIds,
          faenaNames: [...payFaenaNames],
          payroll: p,
        });
      }
    }
    for (const w of map.values()) {
      w.payments.sort((a, b) => b.payrollDate - a.payrollDate);
    }
    return map;
  }, [filteredPayrolls]);

  // 3) Filtro por faena (a nivel pago — al menos un pago del worker tiene faena en el set).
  const workersAfterFaena = useMemo(() => {
    if (faenaFilter.size === 0) return [...workersIndex.values()];
    const out = [];
    for (const w of workersIndex.values()) {
      const filtered = w.payments.filter((pay) =>
        [...pay.faenaIds].some((fid) => faenaFilter.has(fid)),
      );
      if (filtered.length === 0) continue;
      // Recalcular totales solo con los pagos filtrados por faena.
      const totals = filtered.reduce(
        (acc, pay) => ({
          totalAmount: acc.totalAmount + pay.amount,
          totalGross: acc.totalGross + pay.gross,
          totalAdvance: acc.totalAdvance + pay.advance,
          totalBonus: acc.totalBonus + pay.bonus,
        }),
        { totalAmount: 0, totalGross: 0, totalAdvance: 0, totalBonus: 0 },
      );
      out.push({ ...w, ...totals, payments: filtered });
    }
    return out;
  }, [workersIndex, faenaFilter]);

  // 4) Filtro por búsqueda (rut o nombre) y orden por total desc.
  const filteredWorkers = useMemo(() => {
    const list = [...workersAfterFaena].sort((a, b) => b.totalAmount - a.totalAmount);
    const q = search.trim();
    if (!q) return list;
    const qNorm = normRut(q);
    const qLow = q.toLowerCase();
    return list.filter((w) =>
      normRut(w.rut).includes(qNorm) ||
      String(w.name || "").toLowerCase().includes(qLow),
    );
  }, [workersAfterFaena, search]);

  const selectedWorker = selectedRut ? filteredWorkers.find((w) => w.rut === selectedRut) || workersAfterFaena.find((w) => w.rut === selectedRut) : null;

  // Faenas disponibles para el chip-toggle: las que aparecen en filteredPayrolls.
  const faenasInPayrolls = useMemo(() => {
    const ids = new Set();
    for (const p of filteredPayrolls) {
      for (const cd of p.cycleDetails || []) {
        if (cd.faenaId) ids.add(cd.faenaId);
      }
    }
    return faenas.filter((f) => ids.has(f.id));
  }, [filteredPayrolls, faenas]);

  const resetFilters = () => {
    setSearch("");
    setDateFrom(sixMonthsAgoISO());
    setDateTo(todayISO());
    setClassification("all");
    setFaenaFilter(new Set());
  };

  const setRange = (months) => {
    const today = new Date();
    const from = new Date(today);
    from.setMonth(from.getMonth() - months);
    setDateFrom(from.toISOString().slice(0, 10));
    setDateTo(today.toISOString().slice(0, 10));
  };

  const handleExport = async () => {
    if (!selectedWorker) return;
    setExporting(true);
    try {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Pagos");
      ws.addRow(["", ""]); // fila 1 vacía
      ws.getColumn(1).width = 4;
      ws.addRow(["", `Historial de pagos — ${selectedWorker.name} (${selectedWorker.rut})`]);
      ws.getRow(2).font = { bold: true, size: 13 };
      ws.addRow(["", `Rango: ${dateFrom} → ${dateTo} · ${classification === "all" ? "Nóminas + Diferencias" : classification === "nomina" ? "Solo nóminas" : "Solo diferencias"}`]);
      ws.addRow([]);
      const header = ["", "Fecha", "Nómina", "Tipo", "Líder", "Faenas", "Bruto", "Anticipos", "Bonos", "Neto"];
      const hdrRow = ws.addRow(header);
      hdrRow.eachCell((cell, col) => {
        if (col === 1) return;
        cell.font = { bold: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB7DEE8" } };
        cell.border = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };
      });
      for (const pay of selectedWorker.payments) {
        const r = ws.addRow([
          "",
          pay.payrollDateISO,
          pay.payrollName,
          pay.classification === "diferencia" ? "Diferencia" : "Nómina",
          pay.groupLeader || "—",
          pay.faenaNames.join(" / ") || "—",
          Math.round(pay.gross),
          Math.round(pay.advance),
          Math.round(pay.bonus),
          Math.round(pay.amount),
        ]);
        for (let c = 7; c <= 10; c++) r.getCell(c).numFmt = '"$"#,##0';
      }
      const totalRow = ws.addRow([
        "", "", "TOTAL", "", "", "",
        Math.round(selectedWorker.totalGross),
        Math.round(selectedWorker.totalAdvance),
        Math.round(selectedWorker.totalBonus),
        Math.round(selectedWorker.totalAmount),
      ]);
      totalRow.font = { bold: true };
      totalRow.eachCell((cell, col) => {
        if (col === 1) return;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };
        if (col >= 7) cell.numFmt = '"$"#,##0';
      });
      ws.getColumn(2).width = 12;
      ws.getColumn(3).width = 30;
      ws.getColumn(4).width = 12;
      ws.getColumn(5).width = 18;
      ws.getColumn(6).width = 28;
      for (let c = 7; c <= 10; c++) ws.getColumn(c).width = 14;
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safeName = (selectedWorker.name || selectedWorker.rut).replace(/[^a-z0-9_-]+/gi, "_");
      a.href = url;
      a.download = `historial_${safeName}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      toast.error("No se pudo exportar: " + (err?.message || err));
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-[var(--color-muted)]">Cargando nóminas…</div>;
  }

  return (
    <div className="flex flex-1 flex-col gap-3 min-h-0">
      {/* Filtros */}
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Buscar por RUT o nombre…"
            className="min-w-[220px] flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex items-center gap-1 text-xs">
            <span className="text-[var(--color-muted)]">Desde</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
            />
            <span className="text-[var(--color-muted)]">→</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
            />
          </div>
          <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-border)] text-xs">
            {[
              { v: 3, l: "3m" }, { v: 6, l: "6m" }, { v: 12, l: "1a" }, { v: 24, l: "2a" },
            ].map((r) => (
              <button
                key={r.v}
                onClick={() => setRange(r.v)}
                className="border-l border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 first:border-l-0 hover:bg-[var(--color-accent-soft)]"
                title={`Últimos ${r.l}`}
              >
                {r.l}
              </button>
            ))}
          </div>
          <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-border)] text-xs">
            {[
              { v: "all", l: "Todos" },
              { v: "nomina", l: "📋 Nóminas" },
              { v: "diferencia", l: "🏷️ Diferencias" },
            ].map((c) => (
              <button
                key={c.v}
                onClick={() => setClassification(c.v)}
                className={`border-l border-[var(--color-border)] px-2 py-1 first:border-l-0 ${
                  classification === c.v ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "bg-[var(--color-surface)] hover:bg-[var(--color-accent-soft)]"
                }`}
              >
                {c.l}
              </button>
            ))}
          </div>
          <button
            onClick={resetFilters}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-danger)]"
            title="Volver a defaults (6 meses, todas las clasif., sin faena)"
          >
            ⟲ Reset
          </button>
        </div>
        {faenasInPayrolls.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
            <span className="text-[var(--color-muted)] mr-1">Faena:</span>
            {faenasInPayrolls.map((f) => {
              const active = faenaFilter.has(f.id);
              return (
                <button
                  key={f.id}
                  onClick={() => {
                    setFaenaFilter((prev) => {
                      const next = new Set(prev);
                      if (next.has(f.id)) next.delete(f.id);
                      else next.add(f.id);
                      return next;
                    });
                  }}
                  className={`rounded-full px-2 py-0.5 ${
                    active
                      ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                      : "bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]"
                  }`}
                >
                  {f.name}
                </button>
              );
            })}
            {faenaFilter.size > 0 && (
              <button
                onClick={() => setFaenaFilter(new Set())}
                className="ml-1 text-[var(--color-muted)] hover:text-[var(--color-danger)]"
              >
                ✕
              </button>
            )}
          </div>
        )}
      </div>

      {/* Contenido principal */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!selectedWorker ? (
          <WorkersList
            workers={filteredWorkers}
            search={search}
            onSelect={(rut) => setSelectedRut(rut)}
          />
        ) : (
          <WorkerDetail
            worker={selectedWorker}
            onBack={() => setSelectedRut(null)}
            onExport={handleExport}
            exporting={exporting}
            onOpenPayroll={onOpenPayroll}
          />
        )}
      </div>
    </div>
  );
}

function WorkersList({ workers, search, onSelect }) {
  if (workers.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[var(--color-border)] py-8 text-center text-sm text-[var(--color-muted)]">
        {search.trim()
          ? `Ningún trabajador coincide con "${search}" en el rango seleccionado.`
          : "No hay trabajadores con pagos en este rango/filtros."}
      </div>
    );
  }
  return (
    <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
      {workers.map((w) => (
        <button
          key={w.rut}
          onClick={() => onSelect(w.rut)}
          className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-left text-sm transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
        >
          <div className="min-w-0">
            <div className="truncate font-semibold">{w.name}</div>
            <div className="font-mono text-[11px] text-[var(--color-muted)]">{formatRutForDisplay(w.rut)}</div>
            <div className="mt-0.5 text-[11px] text-[var(--color-muted)]">
              {w.payments.length} pago{w.payments.length === 1 ? "" : "s"}
            </div>
          </div>
          <div className="text-right">
            <div className="font-bold tabular-nums text-[var(--color-accent)]">
              {fmtCurrency(w.totalAmount)}
            </div>
            {(w.totalAdvance > 0 || w.totalBonus > 0) && (
              <div className="text-[10px] text-[var(--color-muted)] tabular-nums">
                {w.totalAdvance > 0 && <span className="text-amber-600 dark:text-amber-400">−{fmtCurrency(w.totalAdvance)} </span>}
                {w.totalBonus > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{fmtCurrency(w.totalBonus)}</span>}
              </div>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

function WorkerDetail({ worker, onBack, onExport, exporting, onOpenPayroll }) {
  // Chart: bar por pago, X = orden cronológico, Y = monto neto.
  const chartData = useMemo(() => {
    const sorted = [...worker.payments].sort((a, b) => a.payrollDate - b.payrollDate);
    const maxAmt = Math.max(1, ...sorted.map((p) => p.amount));
    return { sorted, maxAmt };
  }, [worker.payments]);

  // Modal de resumen integral del trabajador — reusa el mismo componente
  // que se usa desde la tab Trabajadores del CRM. Trae todos los workdays
  // (incluso los que aún no se pagaron / no entraron a una nómina) ordenados
  // por ciclo + fecha.
  const [summaryOpen, setSummaryOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div>
          <button
            onClick={onBack}
            className="mb-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)]"
          >
            ← Volver al listado
          </button>
          <div className="text-xl font-semibold">{worker.name}</div>
          <div className="font-mono text-sm text-[var(--color-muted)]">{formatRutForDisplay(worker.rut)}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setSummaryOpen(true)}
            title="Ver todos sus días registrados (incluyendo los que aún no entraron a ninguna nómina)"
            className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-fg)]"
          >
            📅 Ver días sin pagar
          </button>
          <button
            onClick={onExport}
            disabled={exporting}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
          >
            {exporting ? "Exportando…" : "📥 Descargar XLSX"}
          </button>
        </div>
      </div>

      <WorkerSummaryModal
        open={summaryOpen}
        worker={{ id: worker.rut, name: worker.name }}
        onClose={() => setSummaryOpen(false)}
      />

      {/* Métricas */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <MetricCard label="Total neto pagado" value={fmtCurrency(worker.totalAmount)} accent />
        <MetricCard label="Pagos" value={String(worker.payments.length)} />
        <MetricCard label="Bruto acumulado" value={fmtCurrency(worker.totalGross)} />
        <MetricCard
          label="Anticipos / Bonos"
          value={
            <span>
              <span className="text-amber-600 dark:text-amber-400">−{fmtCurrency(worker.totalAdvance)}</span>
              {" / "}
              <span className="text-emerald-600 dark:text-emerald-400">+{fmtCurrency(worker.totalBonus)}</span>
            </span>
          }
        />
      </div>

      {/* Chart simple: barras por pago en orden cronológico */}
      {chartData.sorted.length > 0 && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div className="mb-2 text-xs font-medium text-[var(--color-muted)]">
            Pagos en el tiempo · {chartData.sorted.length} eventos
          </div>
          <PaymentsBarChart data={chartData.sorted} maxAmt={chartData.maxAmt} />
        </div>
      )}

      {/* Listado de pagos */}
      <div className="rounded-lg border border-[var(--color-border)]">
        <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm font-medium">
          Detalle de pagos ({worker.payments.length})
        </div>
        <div className="divide-y divide-[var(--color-border)]">
          {worker.payments.map((pay, i) => (
            <button
              key={`${pay.payrollId}_${i}`}
              onClick={() => onOpenPayroll?.(pay.payroll)}
              className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-[var(--color-accent-soft)]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{pay.payrollName}</span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                    pay.classification === "diferencia"
                      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                      : "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                  }`}>
                    {pay.classification === "diferencia" ? "diferencia" : "nómina"}
                  </span>
                  <span className={`text-[10px] ${
                    pay.status === "paid" ? "text-[var(--color-success)]" : "text-[var(--color-warning)]"
                  }`}>
                    {pay.status === "paid" ? "pagado" : "pendiente"}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                  📅 {pay.payrollDateISO || "—"}
                  {pay.groupLeader && (
                    <> · 👥 Líder: <span className="text-[var(--color-text)] font-medium">{pay.groupLeader}</span></>
                  )}
                  {pay.faenaNames.length > 0 && (
                    <> · 🏞 {pay.faenaNames.join(" / ")}</>
                  )}
                </div>
                {(pay.advance > 0 || pay.bonus > 0) && (
                  <div className="mt-0.5 text-[11px] tabular-nums">
                    Bruto {fmtCurrency(pay.gross)}
                    {pay.advance > 0 && <span className="text-amber-600 dark:text-amber-400"> · −{fmtCurrency(pay.advance)}</span>}
                    {pay.bonus > 0 && <span className="text-emerald-600 dark:text-emerald-400"> · +{fmtCurrency(pay.bonus)}</span>}
                  </div>
                )}
              </div>
              <div className="text-right">
                <div className="font-bold tabular-nums">{fmtCurrency(pay.amount)}</div>
                <div className="text-[10px] text-[var(--color-muted)] opacity-0 transition-opacity group-hover:opacity-100">→</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, accent = false }) {
  return (
    <div className={`rounded-lg border p-3 ${accent ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}>
      <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className={`mt-1 text-base font-bold tabular-nums ${accent ? "text-[var(--color-accent)]" : ""}`}>{value}</div>
    </div>
  );
}

function PaymentsBarChart({ data, maxAmt }) {
  // SVG inline simple. Width 100% (viewport responsive), height fija.
  const H = 140;
  const padTop = 8, padBottom = 24, padLeft = 4, padRight = 4;
  const innerH = H - padTop - padBottom;
  const n = data.length;
  // Cada barra ocupa una franja proporcional + 4px de gap entre barras.
  const VW = Math.max(280, n * 36);
  const innerW = VW - padLeft - padRight;
  const barW = Math.max(8, Math.min(40, innerW / Math.max(1, n) - 4));
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${VW} ${H}`} width="100%" height={H} style={{ display: "block", minWidth: 280 }}>
        {data.map((p, i) => {
          const h = (p.amount / maxAmt) * innerH;
          const x = padLeft + (i + 0.5) * (innerW / n) - barW / 2;
          const y = padTop + (innerH - h);
          const isDif = p.classification === "diferencia";
          return (
            <g key={`${p.payrollId}_${i}`}>
              <title>{`${p.payrollDateISO} — ${p.payrollName}\n${fmtCurrency(p.amount)}${p.advance > 0 ? `  (anticipo −${fmtCurrency(p.advance)})` : ""}${p.bonus > 0 ? `  (bono +${fmtCurrency(p.bonus)})` : ""}`}</title>
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                fill={isDif ? "#f59e0b" : "#16a34a"}
                opacity={p.status === "paid" ? 1 : 0.5}
                rx={2}
              />
              {n <= 24 && (
                <text
                  x={x + barW / 2}
                  y={H - 8}
                  textAnchor="middle"
                  fontSize="9"
                  fill="currentColor"
                  opacity="0.6"
                >
                  {p.payrollDateISO?.slice(5) /* MM-DD */}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex items-center gap-3 text-[10px] text-[var(--color-muted)]">
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: "#16a34a" }} /> Nómina</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: "#f59e0b" }} /> Diferencia</span>
        <span className="flex items-center gap-1 opacity-50"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: "#16a34a" }} /> pendiente</span>
      </div>
    </div>
  );
}
