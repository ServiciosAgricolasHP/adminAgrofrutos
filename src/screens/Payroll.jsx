import { useEffect, useMemo, useState } from "react";
import {
  faenasService,
  subfaenasService,
  cyclesService,
  workersService,
  workdaysService,
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
} from "../services/advancesService";
import { formatRutForDisplay } from "../utils/rutUtils";
import { bankName, ACCOUNT_TYPES, isCashBank, CASH_BANK_CODE } from "../utils/banks";
import {
  aggregateWorkerAmounts,
  downloadBchileXlsx,
  downloadNominaOnlyXlsx,
  payrollSuggestedName,
  groupCashByLeader,
  splitBankAndCash,
  validateAccountNumber,
} from "../utils/payroll";
import ConfirmDialog from "../components/ConfirmDialog";

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
        faenasService.list({ order: ["name", "asc"] }),
        subfaenasService.list({ order: ["name", "asc"] }),
        cyclesService.list({ order: ["createdAt", "desc"] }),
        workersService.list({ order: ["name", "asc"] }),
        payrollsService.list({ order: ["createdAt", "desc"] }),
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

      // Load workdays for each cycle, excluding ones already tagged in another payroll.
      const allWorkdays = [];
      const chunkSize = 10;
      for (let i = 0; i < cycleIds.length; i += chunkSize) {
        const chunk = cycleIds.slice(i, i + chunkSize);
        const wds = await workdaysService.list({ wheres: [["cycleId", "in", chunk]] });
        for (const wd of wds) if (!wd.payrollId) allWorkdays.push(wd);
      }

      const aggregates = aggregateWorkerAmounts(allWorkdays, laborTypeById);

      // Pull pending advances for everyone in this preview.
      const candidateRuts = aggregates.filter((a) => a.total > 0).map((a) => a.rut);
      const pendingAdvances = await listPendingForWorkers(candidateRuts);
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
          const anticiposTotal = adv.anticipos.reduce((s, x) => s + (Number(x.amount) || 0), 0);
          const adelantosTotal = adv.adelantos.reduce((s, x) => s + (Number(x.amount) || 0), 0);
          const totalAdvance = anticiposTotal + adelantosTotal;
          const advanceIds = [...adv.anticipos, ...adv.adelantos].map((x) => x.id);
          const advanceNoteParts = [];
          if (anticiposTotal) advanceNoteParts.push(`Anticipos ${adv.anticipos.length}`);
          if (adelantosTotal) advanceNoteParts.push(`Adelantos ${adv.adelantos.length}`);
          return {
            rut: a.rut,
            name: w?.name || "(sin nombre)",
            paymentRut: bd[0] || a.rut,
            accountNumber: bd[1] || "",
            accountType: bd[2] != null ? Number(bd[2]) : 3,
            bankCode,
            email: w?.email || "",
            groupLeader: w?.groupLeader?.[0] || "",
            grossAmount: Math.round(a.total),
            advance: Math.min(Math.round(a.total), Math.round(totalAdvance)),
            advanceNote: advanceNoteParts.join(" · "),
            advanceIds,
            anticiposTotal: Math.round(anticiposTotal),
            adelantosTotal: Math.round(adelantosTotal),
            amount: Math.max(0, Math.round(a.total) - Math.min(Math.round(a.total), Math.round(totalAdvance))),
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
        anticiposTotal: Math.round(Number(p.anticiposTotal) || 0),
        adelantosTotal: Math.round(Number(p.adelantosTotal) || 0),
        amount: Math.round(Number(p.amount) || 0),
        byCycle: p.byCycle || {},
        workdayIds: p.workdayIds || [],
      }));

      const allWorkdayIds = cleanItems.flatMap((p) => p.workdayIds);
      const allAdvanceIds = cleanItems.flatMap((p) => p.advanceIds || []);
      const { bank: bankItems, cash: cashItems } = splitBankAndCash(cleanItems);

      const created = await payrollsService.create({
        name: payrollName || payrollSuggestedName(),
        format: "bchile",
        status: "pending",
        cycleIds,
        cycleLabels,
        cycleDetails,
        items: cleanItems,
        total: cleanItems.reduce((s, x) => s + x.amount, 0),
        bankTotal: bankItems.reduce((s, x) => s + x.amount, 0),
        cashTotal: cashItems.reduce((s, x) => s + x.amount, 0),
        workerCount: cleanItems.length,
        bankCount: bankItems.length,
        cashCount: cashItems.length,
        workdayIds: allWorkdayIds,
        advanceIds: allAdvanceIds,
        advanceTotal: cleanItems.reduce((s, x) => s + (Number(x.advance) || 0), 0),
      });

      await tagWorkdaysWithPayroll(allWorkdayIds, created.id);
      await applyAdvancesToPayroll(allAdvanceIds, created.id);

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
  const onDelete = async () => {
    if (!confirmDelete) return;
    await untagWorkdaysFromPayroll(confirmDelete.workdayIds || []);
    await restoreAdvancesFromPayroll(confirmDelete.advanceIds || []);
    await payrollsService.remove(confirmDelete.id);
    setConfirmDelete(null);
    await load();
  };
  const onRedownload = async (p) => {
    const cyclesForExport = (p.cycleDetails || []).map((c) => ({ id: c.id, label: c.label }));
    if (cyclesForExport.length === 0 && p.cycleIds) {
      for (const id of p.cycleIds) cyclesForExport.push({ id, label: id });
    }
    await downloadBchileXlsx(p.items || [], p.name || "Nomina", cyclesForExport);
  };
  const onDownloadNominaOnly = async (p) => {
    const filename = `${p.name || "Nomina"}_BChile`;
    await downloadNominaOnlyXlsx(p.items || [], filename);
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
            onBack={() => setStep(1)}
            onGenerate={generateAndSave}
            busy={busy}
          />
        )
      ) : (
        <HistoryList
          payrolls={payrolls}
          onMarkPaid={onMarkPaid}
          onMarkPending={onMarkPending}
          onAskDelete={setConfirmDelete}
          onRedownload={onRedownload}
          onDownloadNominaOnly={onDownloadNominaOnly}
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

      {detailPayroll && (
        <PayrollDetailModal
          payroll={detailPayroll}
          onClose={() => setDetailPayroll(null)}
          onRedownload={onRedownload}
          onDownloadNominaOnly={onDownloadNominaOnly}
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
  onBack,
  onGenerate,
  busy,
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all"); // all | bank | cash | missing | leader:<name>

  const bankTotal = bankItems.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const cashTotal = cashGroups.reduce((s, g) => s + g.total, 0);
  const totalAdvance = items.reduce((s, p) => s + (p.include ? Number(p.advance) || 0 : 0), 0);

  const leaders = useMemo(() => {
    const set = new Set();
    for (const p of items) if (p.groupLeader) set.add(p.groupLeader);
    return [...set].sort();
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((p) => {
      if (filter === "bank" && isCashBank(p.bankCode)) return false;
      if (filter === "cash" && !isCashBank(p.bankCode)) return false;
      if (filter === "missing" && !p._missing) return false;
      if (filter === "suspicious" && !p._accountIssue) return false;
      if (filter.startsWith("leader:") && p.groupLeader !== filter.slice(7)) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.rut.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, search, filter]);

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
    <div className="flex flex-1 flex-col gap-3 overflow-hidden">
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
            className="w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
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
          className="w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
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
        <div className="ml-auto flex flex-wrap gap-1 text-xs">
          <span className="text-[var(--color-muted)]">{filteredItems.length} visibles:</span>
          <button
            onClick={() => setIncludeAllVisible(true)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
          >
            ✓ Incluir
          </button>
          <button
            onClick={() => setIncludeAllVisible(false)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
          >
            ✗ Excluir
          </button>
          <button
            onClick={() => setBankAllVisible(true)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
          >
            💵 → Efectivo
          </button>
          <button
            onClick={() => setBankAllVisible(false)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 hover:bg-[var(--color-accent-soft)]"
          >
            🏦 → Banco
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
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
                  <td className="px-3 py-2 text-right text-xs text-[var(--color-muted)]">
                    {fmtCurrency(p.grossAmount || 0)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      value={p.advance || 0}
                      title="Anticipo a descontar"
                      onChange={(e) => updatePreview(p.rut, { advance: Number(e.target.value) || 0 })}
                      className="w-24 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-right text-sm"
                    />
                    {Number(p.advance) > 0 && (
                      <input
                        value={p.advanceNote || ""}
                        onChange={(e) => updatePreview(p.rut, { advanceNote: e.target.value })}
                        placeholder="motivo..."
                        className="mt-1 block w-24 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-right text-[10px] text-[var(--color-muted)]"
                      />
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      value={p.amount}
                      onChange={(e) => updatePreview(p.rut, { amount: Number(e.target.value) || 0 })}
                      className="w-28 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-right text-sm font-medium"
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => toggleCash(p)}
                      title={cash ? "Cambiar a banco" : "Pagar en efectivo"}
                      className={`rounded border px-2 py-1 text-xs ${
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

      {cashGroups.length > 0 && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div className="mb-2 text-sm font-semibold">💵 Efectivo agrupado por líder</div>
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

function HistoryList({ payrolls, onMarkPaid, onMarkPending, onAskDelete, onRedownload, onDownloadNominaOnly, onOpen }) {
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
          className="w-56 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
        >
          <option value="all">Todos</option>
          <option value="pending">Pendientes</option>
          <option value="paid">Pagadas</option>
        </select>
        <select
          value={monthFilter}
          onChange={(e) => setMonthFilter(e.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
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

    <div className="flex-1 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-[var(--color-surface-2)] text-left">
          <tr>
            <th className="px-3 py-2">Nombre</th>
            <th className="px-3 py-2">Estado</th>
            <th className="px-3 py-2">Trabajadores</th>
            <th className="px-3 py-2 text-right">Total</th>
            <th className="px-3 py-2">Creada</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-[var(--color-muted)]">
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
              <td className="px-3 py-2">{p.workerCount || (p.items?.length ?? 0)}</td>
              <td className="px-3 py-2 text-right">{fmtCurrency(p.total || 0)}</td>
              <td className="px-3 py-2 text-xs text-[var(--color-muted)]">{fmtDate(p.createdAt)}</td>
              <td className="px-3 py-2">
                <div className="flex justify-end gap-1">
                  <button
                    onClick={() => onDownloadNominaOnly(p)}
                    title="Solo la hoja de Nómina BChile"
                    className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                  >
                    🏦 Nómina
                  </button>
                  <button
                    onClick={() => onRedownload(p)}
                    title="XLSX completo (Nómina + Resumen + Transferencias + Efectivo)"
                    className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                  >
                    📥 Completo
                  </button>
                  {p.status === "paid" ? (
                    <button
                      onClick={() => onMarkPending(p)}
                      className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                    >
                      ↩ Pendiente
                    </button>
                  ) : (
                    <button
                      onClick={() => onMarkPaid(p)}
                      className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs hover:bg-[var(--color-accent-soft)]"
                    >
                      ✓ Pagada
                    </button>
                  )}
                  <button
                    onClick={() => onAskDelete(p)}
                    className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
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
    </div>
  );
}

function buildCashReceiptHtml(payroll, cashGroups) {
  const cyclesLine = (payroll.cycleDetails || [])
    .map((c) => `${c.label}${c.faenaName ? ` (${c.faenaName}${c.subfaenaName ? "/" + c.subfaenaName : ""})` : ""}`)
    .join(" · ");
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

  const groupsHtml = cashGroups
    .map(
      (g) => `
    <section class="receipt">
      <header>
        <div class="hd">
          <div>
            <h1>Comprobante de pago en efectivo</h1>
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
            <th style="width:120px;text-align:right">Monto</th>
            <th style="width:200px">Firma</th>
          </tr>
        </thead>
        <tbody>
          ${g.items
            .map(
              (it, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${it.name}</td>
              <td class="mono">${fmtRut(it.rut)}</td>
              <td style="text-align:right">${fmt(it.amount)}</td>
              <td></td>
            </tr>`,
            )
            .join("")}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="3" style="text-align:right"><b>Total entregado</b></td>
            <td style="text-align:right"><b>${fmt(g.total)}</b></td>
            <td></td>
          </tr>
        </tfoot>
      </table>
      <div class="signs">
        <div class="sign">
          <div class="line"></div>
          <div>Firma líder (${g.leader})</div>
        </div>
        <div class="sign">
          <div class="line"></div>
          <div>Firma quien entrega</div>
        </div>
      </div>
    </section>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${payroll.name} — Efectivo</title>
<style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; color: #222; }
  .receipt { padding: 22px 28px; page-break-after: always; }
  .receipt:last-child { page-break-after: auto; }
  .hd { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; border-bottom: 2px solid #555; padding-bottom: 10px; margin-bottom: 12px; }
  h1 { margin: 0 0 4px; font-size: 18px; }
  .sub { color: #666; font-size: 12px; }
  .meta { font-size: 12px; text-align: right; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { background: #B7DEE8; }
  th, td { border: 1px solid #999; padding: 5px 7px; }
  tfoot td { background: #C6EFCE; }
  .mono { font-family: ui-monospace, monospace; }
  .signs { display: flex; justify-content: space-between; margin-top: 32px; gap: 60px; font-size: 12px; }
  .sign { flex: 1; text-align: center; }
  .line { border-top: 1px solid #444; margin-bottom: 4px; height: 30px; }
  @media print { @page { margin: 14mm; } .receipt { padding: 0; } }
</style>
</head><body>${groupsHtml}
<script>window.onload = () => { window.focus(); window.print(); };</script>
</body></html>`;
}

function printCashReceipts(payroll, cashGroups) {
  if (cashGroups.length === 0) return;
  const html = buildCashReceiptHtml(payroll, cashGroups);
  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) {
    alert("Permite las ventanas emergentes para imprimir.");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function PayrollDetailModal({ payroll, onClose, onRedownload, onDownloadNominaOnly }) {
  const items = payroll.items || [];
  const { bank, cash } = splitBankAndCash(items);
  const cashGroups = groupCashByLeader(cash);
  const cycleDetails = payroll.cycleDetails || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-5 py-3">
          <div>
            <h2 className="font-semibold">{payroll.name}</h2>
            <p className="text-xs text-[var(--color-muted)]">
              {(payroll.cycleLabels || []).join(" · ") || "—"}
            </p>
          </div>
          <button onClick={onClose} className="text-[var(--color-muted)] hover:text-[var(--color-text)]">✕</button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
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
                <thead className="text-left text-[var(--color-muted)]">
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
                      <td className="px-2 py-1 text-right">{fmtCurrency(it.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[var(--color-border)] font-semibold">
                    <td colSpan={5} className="px-2 py-2 text-right">Subtotal banco</td>
                    <td className="px-2 py-2 text-right">{fmtCurrency(bank.reduce((s, x) => s + x.amount, 0))}</td>
                  </tr>
                </tfoot>
              </table>
            </section>
          )}

          {cashGroups.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">💵 Efectivo agrupado por líder ({cash.length})</h3>
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
                            <td className="px-2 py-1 text-right">{fmtCurrency(it.amount)}</td>
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
              onClick={() => printCashReceipts(payroll, cashGroups)}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-accent-soft)]"
            >
              🖨 Comprobantes efectivo
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
