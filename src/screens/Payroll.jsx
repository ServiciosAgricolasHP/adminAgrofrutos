import { useEffect, useMemo, useRef, useState } from "react";
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
} from "../services/payrollsService";
import {
  listPendingForWorkers,
  applyAdvancesToPayroll,
  restoreAdvancesFromPayroll,
  advanceRemaining,
} from "../services/advancesService";
import { formatRutForDisplay } from "../utils/rutUtils";
import { bankName, ACCOUNT_TYPES, isCashBank, CASH_BANK_CODE } from "../utils/banks";
import { getTratoTierTotals, getDayCombos, getDaySingle, getTratoTiers, tratoTypeLabel, cosechaUnit } from "../utils/cosechaCombos";
import { useCatalogs } from "../contexts/CatalogsContext";
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
import { useIsMobile } from "../hooks/useIsMobile";

const fmtCurrency = (v) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", minimumFractionDigits: 0 }).format(
    Number(v) || 0,
  );

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
  const [tab, setTab] = useState("create"); // create | history
  const [loading, setLoading] = useState(true);
  const [faenas, setFaenas] = useState([]);
  const [subfaenas, setSubfaenas] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [payrolls, setPayrolls] = useState([]);

  const [selectedCycleIds, setSelectedCycleIds] = useState(loadSelection);
  const [step, setStep] = useState(1); // 1 = pick cycles, 2 = preview
  const [previewItems, setPreviewItems] = useState([]); // [{rut, name, accountNumber, bankCode, accountType, email, amount, include, _missing}]
  // Cached source data from buildPreview, used to assemble the static snapshot
  // when generateAndSave fires. Avoids re-querying workdays and advances.
  const previewWorkdaysRef = useRef([]);
  const previewAdvancesRef = useRef([]);
  const [busy, setBusy] = useState(false);
  const [payrollName, setPayrollName] = useState("");

  const [confirmDelete, setConfirmDelete] = useState(null);
  const [detailPayroll, setDetailPayroll] = useState(null);

  // Per-cycle aggregates: { [cycleId]: { unpaid, paid, total } }
  const [cycleStats, setCycleStats] = useState({});

  const load = async () => {
    setLoading(true);
    try {
      const [f, s, c, w, p] = await Promise.all([
        faenasService.list({ order: ["name", "asc"], cache: true, persist: true, ttl: 10 * 60 * 1000 }),
        subfaenasService.list({ order: ["name", "asc"], cache: true, persist: true, ttl: 10 * 60 * 1000 }),
        cyclesService.list({ order: ["createdAt", "desc"], cache: true, persist: true, ttl: 5 * 60 * 1000 }),
        workersService.list({ order: ["name", "asc"], cache: true, persist: true, ttl: 24 * 60 * 60 * 1000 }),
        payrollsService.list({ order: ["createdAt", "desc"], take: 50, cache: true, persist: true, ttl: 5 * 60 * 1000 }),
      ]);
      setFaenas(f);
      setSubfaenas(s);
      setCycles(c);
      setWorkers(w);
      setPayrolls(p);

      // Compute per-cycle paid/unpaid totals (for active cycles only).
      const activeIds = c.filter((x) => x.status !== "closed").map((x) => x.id);
      const stats = {};
      for (const id of activeIds) stats[id] = { unpaid: 0, paid: 0, total: 0 };
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
            const tiers = wd.tiers ? Object.values(wd.tiers) : null;
            amount = tiers
              ? tiers.reduce((s, t) => s + (Number(t?.amount) || 0), 0)
              : Number(wd.amount) || 0;
          } else {
            amount = Number(wd.amount) || 0;
          }
          stats[cid].total += amount;
          if (wd.payrollId) stats[cid].paid += amount;
          else stats[cid].unpaid += amount;
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
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveSelection(next);
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
      // payroll and ones belonging to TEMP-* (temporary) workers, which never
      // make it into a payroll until their RUT is assigned in CycleDetail.
      const allWorkdays = [];
      const chunkSize = 10;
      for (let i = 0; i < cycleIds.length; i += chunkSize) {
        const chunk = cycleIds.slice(i, i + chunkSize);
        const wds = await workdaysService.list({ wheres: [["cycleId", "in", chunk]] });
        for (const wd of wds) {
          if (wd.payrollId) continue;
          if (String(wd.workerRut || "").startsWith("TEMP-")) continue;
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
        const e = advancesByRut.get(adv.workerRut) || { anticipos: [], adelantos: [] };
        if (adv.type === "anticipo") e.anticipos.push(adv);
        else if (adv.type === "adelanto") e.adelantos.push(adv);
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
          const adv = advancesByRut.get(a.rut) || { anticipos: [], adelantos: [] };
          // Allocate the worker's gross to advances oldest-first, partial-aware.
          // Anticipos before adelantos within the same date.
          const allAdvs = [...adv.anticipos, ...adv.adelantos]
            .map((x) => ({ ...x, _typeOrder: x.type === "anticipo" ? 0 : 1 }))
            .sort((x, y) => {
              const da = (x.date || ""), dbb = (y.date || "");
              if (da !== dbb) return da < dbb ? -1 : 1;
              return x._typeOrder - y._typeOrder;
            });
          const grossInt = Math.round(a.total);
          let remainingGross = grossInt;
          const applications = []; // [{advanceId, type, amount}]
          for (const advItem of allAdvs) {
            if (remainingGross <= 0) break;
            const advRem = Math.round(advanceRemaining(advItem));
            if (advRem <= 0) continue;
            const apply = Math.min(remainingGross, advRem);
            if (apply <= 0) continue;
            applications.push({ advanceId: advItem.id, type: advItem.type, amount: apply });
            remainingGross -= apply;
          }
          const anticiposTotal = applications
            .filter((x) => x.type === "anticipo")
            .reduce((s, x) => s + x.amount, 0);
          const adelantosTotal = applications
            .filter((x) => x.type === "adelanto")
            .reduce((s, x) => s + x.amount, 0);
          const totalAdvance = anticiposTotal + adelantosTotal;
          const advanceIds = applications.map((x) => x.advanceId);
          const advanceNoteParts = [];
          const anticiposCount = applications.filter((x) => x.type === "anticipo").length;
          const adelantosCount = applications.filter((x) => x.type === "adelanto").length;
          if (anticiposTotal) advanceNoteParts.push(`Anticipos ${anticiposCount}`);
          if (adelantosTotal) advanceNoteParts.push(`Adelantos ${adelantosCount}`);
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
            advance: totalAdvance,
            advanceNote: advanceNoteParts.join(" · "),
            advanceIds,
            advanceApplications: applications.map(({ advanceId, amount }) => ({ advanceId, amount })),
            anticiposTotal,
            adelantosTotal,
            amount: Math.max(0, grossInt - totalAdvance),
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
        if (Object.prototype.hasOwnProperty.call(patch, "advance")) {
          const adv = Math.max(0, Number(patch.advance) || 0);
          next.advance = adv;
          next.amount = Math.max(0, Math.round((p.grossAmount || 0) - adv));
          // Re-clip advanceApplications oldest-first so the per-advance
          // breakdown stays consistent with the (possibly reduced) total.
          const apps = (p.advanceApplications || []).map((x) => ({ ...x }));
          let remaining = adv;
          const out = [];
          for (const ap of apps) {
            if (remaining <= 0) break;
            const take = Math.min(ap.amount, remaining);
            if (take > 0) out.push({ advanceId: ap.advanceId, amount: take });
            remaining -= take;
          }
          next.advanceApplications = out;
          next.advanceIds = out.map((x) => x.advanceId);
        }
        return next;
      }),
    );
  };

  const bulkUpdate = (predicate, patch) => {
    setPreviewItems((prev) => prev.map((p) => (predicate(p) ? { ...p, ...patch } : p)));
  };

  const generateAndSave = async () => {
    const items = previewItems.filter((p) => p.include && Number(p.amount) > 0);
    if (items.length === 0) {
      alert("No hay trabajadores seleccionados con monto > 0.");
      return;
    }
    const missing = items.filter((p) => !isCashBank(p.bankCode) && (!p.accountNumber || !p.bankCode));
    if (missing.length > 0) {
      const proceed = confirm(
        `${missing.length} trabajador(es) bancarizados tienen datos incompletos. ¿Generar de todos modos?`,
      );
      if (!proceed) return;
    }
    const suspicious = items
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
    try {
      const cycleIds = [...selectedCycleIds];
      const selectedCycles = cycles.filter((c) => cycleIds.includes(c.id));
      const cycleLabels = selectedCycles.map((c) => c.label || c.id);
      const cycleDetails = selectedCycles.map((c) => {
        const f = faenas.find((x) => x.id === c.faenaId);
        const s = subfaenas.find((x) => x.id === c.subfaenaId);
        return {
          id: c.id,
          label: c.label || c.id,
          faenaId: c.faenaId || "",
          faenaName: f?.name || "",
          subfaenaId: c.subfaenaId || "",
          subfaenaName: s?.name || "",
        };
      });

      const cleanItems = items.map((p) => ({
        rut: p.rut,
        name: p.name,
        accountNumber: p.accountNumber,
        bankCode: p.bankCode,
        accountType: p.accountType,
        email: p.email || "",
        groupLeader: p.groupLeader || "",
        grossAmount: Math.round(Number(p.grossAmount) || Number(p.amount) || 0),
        advance: Math.round(Number(p.advance) || 0),
        advanceNote: p.advanceNote || "",
        advanceIds: p.advanceIds || [],
        advanceApplications: (p.advanceApplications || []).map((x) => ({
          advanceId: x.advanceId,
          amount: Math.round(Number(x.amount) || 0),
        })),
        anticiposTotal: Math.round(Number(p.anticiposTotal) || 0),
        adelantosTotal: Math.round(Number(p.adelantosTotal) || 0),
        amount: Math.round(Number(p.amount) || 0),
        byCycle: p.byCycle || {},
        workdayIds: p.workdayIds || [],
      }));

      const allWorkdayIds = cleanItems.flatMap((p) => p.workdayIds);
      const allAdvanceIds = cleanItems.flatMap((p) => p.advanceIds || []);
      const allApplications = cleanItems.flatMap((p) => p.advanceApplications || []);
      const { bank: bankItems, cash: cashItems } = splitBankAndCash(cleanItems);

      const total = cleanItems.reduce((s, x) => s + x.amount, 0);
      const bankTotal = bankItems.reduce((s, x) => s + x.amount, 0);
      const cashTotal = cashItems.reduce((s, x) => s + x.amount, 0);
      const advanceTotalSum = cleanItems.reduce((s, x) => s + (Number(x.advance) || 0), 0);
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
          status: "pending",
          total, bankTotal, cashTotal,
          workerCount: cleanItems.length,
          bankCount: bankItems.length,
          cashCount: cashItems.length,
          advanceTotal: advanceTotalSum,
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

      const created = await payrollsService.create({
        name: finalName,
        format: "bchile",
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

      // Persist the snapshot in its own collection, keyed by payrollId. Keeps
      // the payrolls doc light for listing and stays under the 1MB per-doc
      // limit for big nominas.
      const fullSnapshot = { ...snapshot, payrollId: created.id };
      try {
        await payrollSnapshotsService.upsert(created.id, fullSnapshot);
      } catch (err) {
        console.warn("No se pudo guardar el snapshot en payrollSnapshots:", err);
      }

      // Immediate local download of the JSON file. Independent of the cloud
      // save above so the user always gets a local copy.
      downloadSnapshotJson(finalName, fullSnapshot);

      await tagWorkdaysWithPayroll(allWorkdayIds, created.id);
      await applyAdvancesToPayroll(allApplications, created.id);

      const cyclesForExport = cycleDetails.map((c) => ({ id: c.id, label: c.label }));
      await downloadBchileXlsx(cleanItems, payrollName || payrollSuggestedName(), cyclesForExport);

      // Reset
      setSelectedCycleIds(new Set());
      saveSelection(new Set());
      setPreviewItems([]);
      setPayrollName("");
      setStep(1);
      setTab("history");
      await load();
    } finally {
      setBusy(false);
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
    await untagWorkdaysFromPayroll(confirmDelete.workdayIds || []);
    await restoreAdvancesFromPayroll(confirmDelete.advanceIds || [], confirmDelete.id);
    await payrollsService.remove(confirmDelete.id);
    // Best-effort cleanup of the snapshot. Old nominas may not have one.
    try { await payrollSnapshotsService.remove(confirmDelete.id); } catch { /* noop */ }
    setConfirmDelete(null);
    await load();
  };
  const onRedownload = async (p) => {
    // Aplicar overrides persistidos en el doc (lo que el usuario editó vía
    // "📝 Editar encabezados") para que el XLSX use los nombres cortos.
    const overrides = p.cycleLabelOverrides || {};
    const cyclesForExport = (p.cycleDetails || []).map((c) => ({
      id: c.id,
      label: overrides[c.id] || c.label,
    }));
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
        alert("Esta nómina no tiene snapshot guardado (creada antes de la feature).");
        return;
      }
      downloadSnapshotJson(p.name || "Nomina", snap);
    } catch (err) {
      console.error(err);
      alert("No se pudo descargar el JSON.");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Nómina</h1>
          <p className="text-sm text-[var(--color-muted)]">Generar nóminas Banco de Chile a partir de ciclos activos</p>
        </div>
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
            Historial ({payrolls.length})
          </button>
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
      ) : (
        <HistoryList
          payrolls={payrolls}
          onMarkPaid={onAskMarkPaid}
          onMarkPending={onAskRevert}
          onAskDelete={setConfirmDelete}
          onRedownload={onRedownload}
          onDownloadNominaOnly={onDownloadNominaOnly}
          onDownloadSnapshot={onDownloadSnapshot}
          onOpen={setDetailPayroll}
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
        />
      )}
    </div>
  );
}

function CycleSelector({ groups, selected, toggle, subfaenaName, cycleStats, onNext, busy }) {
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
                const stat = cycleStats?.[c.id] || { unpaid: 0, paid: 0, total: 0 };
                const noUnpaid = stat.unpaid <= 0;
                return (
                  <label
                    key={c.id}
                    className={`flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-[var(--color-accent-soft)] ${
                      noUnpaid ? "opacity-60" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggle(c.id)}
                      disabled={noUnpaid && !isSelected}
                      className="h-4 w-4"
                    />
                    <div className="flex-1 text-sm">
                      <div className="font-medium">{c.label || c.id}</div>
                      {sub && <div className="text-xs text-[var(--color-muted)]">{sub}</div>}
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
          {busy ? "Generando..." : "Guardar y descargar XLSX"}
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
                      value={p.amount || ""}
                      placeholder="0"
                      onChange={(e) => updatePreview(p.rut, { amount: Number(e.target.value) || 0 })}
                      className="w-28 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-right text-sm font-medium tabular-nums outline-none focus:border-[var(--color-accent)]"
                    />
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
                <td colSpan={10} className="px-3 py-6 text-center text-[var(--color-muted)]">
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

function HistoryList({ payrolls, onMarkPaid, onMarkPending, onAskDelete, onRedownload, onDownloadNominaOnly, onDownloadSnapshot, onOpen }) {
  const isMobile = useIsMobile();
  const [statusFilter, setStatusFilter] = useState("all"); // all | pending | paid
  const [monthFilter, setMonthFilter] = useState("all"); // all | YYYY-MM
  const [search, setSearch] = useState("");

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
      if (statusFilter !== "all" && (p.status || "pending") !== statusFilter) return false;
      if (monthFilter !== "all" && monthKey(p.createdAt) !== monthFilter) return false;
      if (q && !(p.name || "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [payrolls, statusFilter, monthFilter, search]);

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
function buildGroupCycleSnapshot(groupRuts, cycle, workdays, nameByRut) {
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
        const ck = `Q${x}/E${y}`;
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
        if (wd.tiers) {
          for (const [idx, tt] of Object.entries(wd.tiers)) {
            const i = Number(idx);
            const q = Number(tt?.qty) || 0;
            const a = Number(tt?.amount) || 0;
            if (!q && !a) continue;
            if (!c.byTier[idx]) c.byTier[idx] = { index: i, jornadas: 0, amount: 0 };
            c.byTier[idx].jornadas += q;
            c.byTier[idx].amount += a;
          }
        } else if (t.qty || t.amount) {
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
      priceByDate[d] = formatLaborDayPrice(labor, d, dayPrices);
    }

    out.push({
      laborId: labor.id,
      laborName: labor.name,
      laborType: labor.type,
      tratoType: labor.tratoType ?? 0,
      cosechaContainers: [...containers],
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

// Pull the unit price(s) configured for a labor on a given date.
// Returns a short string suitable for rendering under the day header.
function formatLaborDayPrice(labor, date, dayPrices) {
  if (!labor) return "";
  if (labor.type === "cosecha") {
    const combos = getDayCombos(dayPrices, labor.id, date, "unit");
    if (!combos.length) return "";
    if (combos.length === 1) {
      const c = combos[0];
      if (!c.price) return "";
      return c.mode === "flat" ? `${fmtMoneyShort(c.price)}/día` : `${fmtMoneyShort(c.price)}/kg`;
    }
    return combos
      .filter((c) => c.price)
      .map((c) => `Q${c.x}/E${c.y}: ${fmtMoneyShort(c.price)}${c.mode === "flat" ? "/día" : "/kg"}`)
      .join(" · ");
  }
  if (labor.type === "trato") {
    const tiers = getTratoTiers(dayPrices, labor.id, date, "unit");
    const used = tiers.filter((t) => t.price);
    if (!used.length) return "";
    if (used.length === 1) {
      const t = used[0];
      return `${fmtMoneyShort(t.price)}${t.mode === "flat" ? "/día" : "/jorn."}`;
    }
    return used.map((t) => `T${t.index + 1}: ${fmtMoneyShort(t.price)}`).join(" · ");
  }
  if (labor.type === "main" || labor.type === "supervision" || labor.type === "extra") {
    const cfg = getDaySingle(dayPrices, labor.id, date, "normal");
    const price = Number(cfg?.price) || Number(labor.baseDayDefault) || 0;
    if (!price) return "";
    return fmtMoneyShort(price) + "/día";
  }
  if (labor.type === "tratoHE") {
    const cfg = getDaySingle(dayPrices, labor.id, date, "normal");
    const price = Number(cfg?.price) || Number(labor.baseDayDefault) || 0;
    if (!price) return "";
    return `Base sug. ${fmtMoneyShort(price)}`;
  }
  return "";
}

function fmtDateShort(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return dateStr;
  const m = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"][d.getMonth()];
  return `${String(d.getDate()).padStart(2, "0")}-${m}`;
}

function renderProductionCell(cell, laborType, tratoLabel, kilosUnit) {
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
      const lines = combos
        .map(([ck, b]) => `<div class="muted prod-breakdown">${ck}: ${num(b.kilos)} ${unit}</div>`)
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
function renderProductionTotal(totals, laborType, tratoLabel, kilosUnit) {
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
      ? combos.map(([ck, b]) => `<div class="muted prod-breakdown">${ck}: ${num(b.kilos)} ${unit}</div>`).join("")
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
  const overviewTitle = isDetail ? "Detalle de pago" : "Comprobante de pago en efectivo";
  const docTitle = isDetail ? `${payroll.name} — Detalle pago` : `${payroll.name} — Efectivo`;
  const cycleLabel = (cycleId) => titleOverrides[cycleId] || cyclesById[cycleId]?.label || cycleDetails.find((c) => c.id === cycleId)?.label || cycleId;
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
      const advanceHeader = groupHasAdvance
        ? `<th style="width:110px;text-align:right">Anticipo</th>`
        : "";

      const rows = g.items
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
          const advanceCell = groupHasAdvance
            ? `<td style="text-align:right;color:#b45309">${
                Number(it.advance) > 0 ? `− ${fmt(it.advance)}` : "—"
              }</td>`
            : "";
          return `
            <tr style="background:${itemFill}">
              <td>${i + 1}</td>
              <td>${it.name}</td>
              <td class="mono">${fmtRut(it.rut)}</td>
              ${cellsByCycle}
              ${advanceCell}
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

      const totalColSpan = 3; // # + Nombre + RUT

      // Per-cycle production snapshot for THIS group — mirrors the CycleDetail
      // grid: one table per labor, rows = workers, columns = days.
      const detailHtml = cycleCols
        .map((c) => {
          const laborSnapshots = workdaysByGroup[g.leader]?.[c.id] || [];
          if (laborSnapshots.length === 0) return "";
          const laborTables = laborSnapshots
            .map((ls) => {
              // Para trato usamos el label del catálogo (ej. "Poda") en vez
              // del genérico "A trato" / "jorn." que oscurece de qué labor se
              // trata cuando hay varias del mismo tipo. Para cosecha la
              // unidad sale del envase del catálogo (ej. "Saco" vs "Kilo").
              const tratoLabel = ls.laborType === "trato"
                ? tratoTypeLabel(catalogs, ls.tratoType ?? 0)
                : "";
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
                      (d) => `<td class="prod-cell">${renderProductionCell(row.cells[d], ls.laborType, tratoLabel, kilosUnit)}</td>`,
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
                      <td class="prod-total">${renderProductionTotal(rowTotalAgg, ls.laborType, tratoLabel, kilosUnit)}</td>
                    </tr>`;
                })
                .join("");
              const dayTotals = ls.dates
                .map((d) => `<td class="prod-total">${renderProductionTotal(ls.dayTotals[d], ls.laborType, tratoLabel, kilosUnit)}</td>`)
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
                        <td class="prod-total">${renderProductionTotal(grandTotalAgg, ls.laborType, tratoLabel, kilosUnit)}</td>
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
              return `
                <tr style="background:${itemFill}">
                  <td>${i + 1}</td>
                  <td>${it.name}</td>
                  <td class="mono">${fmtRut(it.rut)}</td>
                  <td style="font-size:10px;color:#555">${bankTag}</td>
                  ${cellsByCycle}
                  ${advanceCell}
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
            <h1>${overviewTitle}${copyLabel ? `<span class="copy-tag">${copyLabel}</span>` : ""}</h1>
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
            ${isDetail ? '<th style="width:90px">Forma pago</th>' : ""}
            ${cycleHeaders}
            ${advanceHeader}
            <th style="width:120px;text-align:right">TOTAL</th>
            ${isDetail ? "" : '<th style="width:200px">Firma</th>'}
          </tr>
        </thead>
        <tbody>
          ${isDetail ? rowsNoSign : rows}
        </tbody>
        <tfoot>
          <tr style="background:${leaderFill}">
            <td colspan="${isDetail ? totalColSpan + 1 : totalColSpan}" style="text-align:right"><b>Subtotal ${g.leader}</b></td>
            ${subtotalCells}
            ${advanceSubtotalCell}
            <td style="text-align:right"><b>${fmt(g.total)}</b></td>
            ${isDetail ? "" : "<td></td>"}
          </tr>
        </tfoot>
      </table>
      ${isDetail ? "" : `
      <div class="signs">
        <div class="sign sign-right">
          <div class="line"></div>
          <div>Firma líder (${g.leader})</div>
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
                <h1>Detalle de producción del grupo</h1>
                <div class="sub">${payroll.name} · Líder: ${g.leader}</div>
              </div>
              <div class="meta"><div><b>Fecha:</b> ${today}</div></div>
            </div>
            ${detailHtml}
          </section>`
        : ""
    }`;
    })
    .join("");

  const summariesHtml = (isDetail && summaries.length > 0)
    ? `<section class="receipt summary-page">
        <div class="hd">
          <div>
            <h1>Resumen por grupo</h1>
            <div class="sub">${payroll.name} · ${cyclesLine}</div>
          </div>
          <div class="meta"><div><b>Fecha:</b> ${today}</div></div>
        </div>
        ${summaries.map((s) => `
          <div class="summary-block">
            <h3>${s.title}</h3>
            <table class="summary">
              <tbody>
                ${s.rows.map((r) => `
                  <tr>
                    <td>${r.leader}</td>
                    <td style="text-align:right">${fmt(r.total)}</td>
                  </tr>`).join("")}
                <tr class="summary-total">
                  <td><b>Total</b></td>
                  <td style="text-align:right"><b>${fmt(s.total)}</b></td>
                </tr>
              </tbody>
            </table>
          </div>`).join("")}
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
  .signs { display: flex; justify-content: flex-end; margin-top: 48px; gap: 60px; font-size: 12px; }
  .sign { width: 280px; text-align: center; }
  .sign-right { margin-left: auto; }
  .line { border-top: 1px solid #444; margin-bottom: 4px; height: 30px; }
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
  table.prod .prod-total { text-align: right; min-width: 70px; }
  @media print { @page { margin: 14mm landscape; } .receipt { padding: 0; } }
</style>
</head><body>${summariesHtml}${groupsHtml}
<script>window.onload = () => { window.focus(); window.print(); };</script>
</body></html>`;
}

async function printPaymentDetails(payroll, allGroups, titleOverrides = {}, summaries = [], catalogs = {}) {
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
      byCycle[cid] = buildGroupCycleSnapshot(groupRuts, cycle, workdays, nameByRut);
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
  });
  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) {
    alert("Permite las ventanas emergentes para imprimir.");
    return;
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
      byCycle[cid] = buildGroupCycleSnapshot(groupRuts, cycle, workdays, nameByRut);
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
    alert("Permite las ventanas emergentes para imprimir.");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function PayrollDetailModal({ payroll, onClose, onRedownload, onDownloadNominaOnly, onDownloadSnapshot }) {
  const { catalogs } = useCatalogs();
  const items = payroll.items || [];
  const { bank, cash } = splitBankAndCash(items);
  const cashGroups = groupCashByLeader(cash);
  const allGroups = groupCashByLeader(items); // groups everyone (bank + cash) by leader

  // Two leader-total summary tables shown at the top of "Detalle pago":
  //   1) "Con cuenta RUT": CHILENOS + EXTRANJEROSCONCUENTARUT (each row separate).
  //   2) "Otros grupos": every other leader (each row separate).
  const detailSummaries = (() => {
    const CRUT_LEADERS = new Set(["CHILENOS", "EXTRANJEROSCONCUENTARUT"]);
    const compact = (s) => normalizeLeader(s).replace(/\s+/g, "");
    const inCrut = (g) => CRUT_LEADERS.has(compact(g.leader));
    const crut = allGroups.filter(inCrut);
    const others = allGroups.filter((g) => !inCrut(g));
    const sumOf = (arr) => arr.reduce((s, g) => s + (Number(g.total) || 0), 0);
    const out = [];
    if (crut.length) {
      out.push({
        title: "Con cuenta RUT",
        rows: crut.map((g) => ({ leader: g.leader, total: g.total })),
        total: sumOf(crut),
      });
    }
    if (others.length) {
      out.push({
        title: "Otros grupos",
        rows: others.map((g) => ({ leader: g.leader, total: g.total })),
        total: sumOf(others),
      });
    }
    return out;
  })();

  const cycleDetails = payroll.cycleDetails || [];

  // Aggregate breakdowns for the summary header.
  const bankTotal = bank.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const cashTotal = cash.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const grossTotal = items.reduce((s, x) => s + (Number(x.grossAmount) || Number(x.amount) || 0), 0);
  const advanceTotal = items.reduce((s, x) => s + (Number(x.advance) || 0), 0);
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
    } finally {
      setPrinting(false);
    }
  };

  const handlePrintDetail = async () => {
    setPrintingDetail(true);
    try {
      await printPaymentDetails(payroll, allGroups, cycleTitleOverrides, detailSummaries, catalogs);
    } finally {
      setPrintingDetail(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-5 py-3">
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
            </div>
            <p className="text-xs text-[var(--color-muted)]">
              {cycleDetails.length > 0
                ? cycleDetails.map((c) => displayCycleLabel(c)).join(" · ")
                : (payroll.cycleLabels || []).join(" · ") || "—"}
            </p>
          </div>
          <button onClick={onClose} className="ml-3 text-[var(--color-muted)] hover:text-[var(--color-text)]">✕</button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
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
                  <div className="text-lg font-semibold">{fmtCurrency(advanceTotal)}</div>
                  <div className="text-[10px] text-[var(--color-muted)]">Bruto: {fmtCurrency(grossTotal)}</div>
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
              <h3 className="mb-2 text-sm font-semibold">Ciclos / Faenas pagadas</h3>
              <ul className="space-y-1 text-sm">
                {cycleDetails.map((c) => (
                  <li key={c.id} className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5">
                    <span className="font-medium">{c.label}</span>
                    {c.faenaName && (
                      <span className="ml-2 text-xs text-[var(--color-muted)]">
                        {c.faenaName}{c.subfaenaName ? ` / ${c.subfaenaName}` : ""}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {bank.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">🏦 Banco ({bank.length})</h3>
              <table className="w-full text-sm">
                <thead className="bg-[var(--color-surface-2)] text-left text-[var(--color-muted)]">
                  <tr>
                    <th className="px-2 py-1">RUT</th>
                    <th className="px-2 py-1">Nombre</th>
                    <th className="px-2 py-1">Banco</th>
                    <th className="px-2 py-1">Cuenta</th>
                    <th className="px-2 py-1">Tipo</th>
                    <th className="px-2 py-1 text-right">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {bank.map((it) => (
                    <tr key={it.rut} className="border-t border-[var(--color-border)]">
                      <td className="px-2 py-1 font-mono text-xs">{formatRutForDisplay(it.rut)}</td>
                      <td className="px-2 py-1">{it.name}</td>
                      <td className="px-2 py-1 text-xs">{bankName(it.bankCode)}</td>
                      <td className="px-2 py-1 font-mono text-xs">{it.accountNumber}</td>
                      <td className="px-2 py-1 text-xs">{accountTypeShort(it.accountType)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtCurrency(it.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[var(--color-border)] font-semibold">
                    <td colSpan={5} className="px-2 py-2 text-right">Subtotal banco</td>
                    <td className="px-2 py-2 text-right tabular-nums">{fmtCurrency(bank.reduce((s, x) => s + x.amount, 0))}</td>
                  </tr>
                </tfoot>
              </table>
            </section>
          )}

          {cashGroups.length > 0 && (
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">💵 Efectivo agrupado por líder ({cash.length})</h3>
              </div>
              <div className="space-y-3">
                {cashGroups.map((g) => (
                  <div key={g.leader} className="rounded border border-[var(--color-border)]">
                    <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm">
                      <span className="font-medium">{g.leader}</span>
                      <span className="font-semibold">{fmtCurrency(g.total)}</span>
                    </div>
                    <table className="w-full text-sm">
                      <tbody>
                        {g.items.map((it) => (
                          <tr key={it.rut} className="border-t border-[var(--color-border)]">
                            <td className="px-2 py-1 font-mono text-xs">{formatRutForDisplay(it.rut)}</td>
                            <td className="px-2 py-1">{it.name}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{fmtCurrency(it.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="flex justify-end border-t border-[var(--color-border)] pt-3 text-sm font-semibold">
            <span>TOTAL: {fmtCurrency(payroll.total || 0)}</span>
          </div>
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-[var(--color-border)] px-5 py-3">
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
    </div>
  );
}
