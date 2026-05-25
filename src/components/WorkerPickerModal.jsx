import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import TextField from "./TextField";
import Select from "./Select";
import { workersService } from "../services";
import { findWorkerByRut, createWorker } from "../services/workersService";
import { formatRutForDisplay, normalizeRut, validateRut, isForeignRut } from "../utils/rutUtils";
import {
  BANKS,
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_RUT,
  CASH_BANK_CODE,
  DEFAULT_BANK_CODE,
  rutWithoutDv,
} from "../utils/banks";

const MIN_SEARCH = 3;
const WORKERS_TTL_MS = 2 * 60 * 60 * 1000;
const LEADER_LOCAL = "CHILENOS";
const LEADER_FOREIGN = "EXTRANJEROS";

// Strip accents + lowercase for accent-insensitive substring matching.
const norm = (s) => String(s || "")
  .toLowerCase()
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "");

function defaultLeaderForRut(rut) {
  return isForeignRut(rut) ? LEADER_FOREIGN : LEADER_LOCAL;
}

function emptyNewWorker() {
  return {
    rut: "",
    name: "",
    bd_paymentRut: "",
    bd_accountNumber: "",
    bd_accountType: ACCOUNT_TYPE_RUT,
    bd_bankCode: DEFAULT_BANK_CODE,
    leader: "",
  };
}

export default function WorkerPickerModal({ open, onClose, onPick, excludeRuts = [], allowTemp = false, title = "Agregar trabajador", availableLeaders = [] }) {
  const [allWorkers, setAllWorkers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [creatingTemp, setCreatingTemp] = useState(false);
  const [tempName, setTempName] = useState("");
  const [tempLeader, setTempLeader] = useState("");
  const [newWorker, setNewWorker] = useState(emptyNewWorker());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Leader options for the create / temp forms. Combines the enabled leaders
  // passed by the parent with the two built-in defaults so the dropdown is
  // useful even if the parent forgot to load them.
  const leaderOptions = useMemo(() => {
    const set = new Set([LEADER_LOCAL, LEADER_FOREIGN, ...availableLeaders.map((l) => String(l || "").toUpperCase())]);
    return [...set].filter(Boolean).sort();
  }, [availableLeaders]);

  // Load the workers list (from cache if hot, otherwise full fetch). Cache is
  // additive on writes, so a brand-new worker added via this same modal
  // appears immediately in subsequent searches without a re-fetch.
  useEffect(() => {
    if (!open) return;
    setSearch("");
    setCreating(false);
    setCreatingTemp(false);
    setTempName("");
    setNewWorker(emptyNewWorker());
    setError("");
    setTempLeader(LEADER_LOCAL);
    let cancelled = false;
    setLoading(true);
    workersService
      .list({ cache: true, persist: true, ttl: WORKERS_TTL_MS })
      .then((list) => {
        if (cancelled) return;
        setAllWorkers(list);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const excluded = useMemo(() => new Set(excludeRuts.map((r) => normalizeRut(r))), [excludeRuts]);

  const queryRaw = search.trim();
  const queryReady = queryRaw.replace(/[.\s-]/g, "").length >= MIN_SEARCH;

  // Client-side substring search over the cached list. Accent-insensitive,
  // case-insensitive. Matches against name OR rut so the user can type either
  // "Perez" (matches any worker whose name contains "Perez", including those
  // with it as a last name) or partial RUT digits.
  const filtered = useMemo(() => {
    if (!queryReady) return [];
    const q = norm(queryRaw);
    const isDigits = /^[\d.\s-]+$/.test(queryRaw);
    const qDigits = queryRaw.replace(/[.\s-]/g, "").toLowerCase();
    const out = [];
    for (const w of allWorkers) {
      if (excluded.has(w.id)) continue;
      const nameMatch = norm(w.name).includes(q);
      const rutMatch = isDigits && String(w.id).toLowerCase().includes(qDigits);
      if (nameMatch || rutMatch) out.push(w);
      if (out.length >= 50) break;
    }
    return out;
  }, [queryReady, queryRaw, allWorkers, excluded]);

  const accType = Number(newWorker.bd_accountType);
  const isCash = String(newWorker.bd_bankCode).toUpperCase() === CASH_BANK_CODE;
  const isCuentaRutSelected = accType === ACCOUNT_TYPE_RUT && !isCash;

  const onRutChange = (v) => {
    setNewWorker((w) => {
      const norm = normalizeRut(v);
      const next = { ...w, rut: v, bd_paymentRut: norm };
      if (Number(w.bd_accountType) === ACCOUNT_TYPE_RUT && String(w.bd_bankCode).toUpperCase() !== CASH_BANK_CODE) {
        next.bd_accountNumber = rutWithoutDv(norm);
      }
      // Reset leader to the RUT-based default whenever the user changes the
      // RUT, unless they have explicitly chosen one (we detect "explicit" by
      // the previous leader differing from the previous RUT's default).
      const prevDefault = w.rut ? defaultLeaderForRut(w.rut) : LEADER_LOCAL;
      const userOverridden = w.leader && w.leader !== prevDefault;
      if (!userOverridden) {
        next.leader = defaultLeaderForRut(norm);
      }
      return next;
    });
  };

  const onPaymentRutChange = (v) => {
    setNewWorker((w) => {
      const norm = normalizeRut(v);
      const next = { ...w, bd_paymentRut: norm };
      if (Number(w.bd_accountType) === ACCOUNT_TYPE_RUT && String(w.bd_bankCode).toUpperCase() !== CASH_BANK_CODE) {
        next.bd_accountNumber = rutWithoutDv(norm);
      }
      return next;
    });
  };

  const onAccountTypeChange = (v) => {
    const t = Number(v);
    setNewWorker((w) => {
      const next = { ...w, bd_accountType: t };
      if (t === ACCOUNT_TYPE_RUT && String(w.bd_bankCode).toUpperCase() !== CASH_BANK_CODE) {
        next.bd_bankCode = DEFAULT_BANK_CODE;
        next.bd_accountNumber = rutWithoutDv(w.bd_paymentRut || normalizeRut(w.rut));
      }
      return next;
    });
  };

  const setQuickCash = () => {
    setNewWorker((w) => ({
      ...w,
      bd_accountType: ACCOUNT_TYPE_RUT,
      bd_bankCode: CASH_BANK_CODE,
      bd_accountNumber: "EFECTIVO",
    }));
  };

  const setQuickCuentaRut = () => {
    setNewWorker((w) => {
      const payRut = w.bd_paymentRut || normalizeRut(w.rut);
      return {
        ...w,
        bd_accountType: ACCOUNT_TYPE_RUT,
        bd_bankCode: DEFAULT_BANK_CODE,
        bd_paymentRut: payRut,
        bd_accountNumber: rutWithoutDv(payRut),
      };
    });
  };

  const submitNew = async (e) => {
    e.preventDefault();
    setError("");
    const rut = normalizeRut(newWorker.rut);
    if (!validateRut(rut)) return setError("RUT inválido");
    if (excluded.has(rut)) return setError("El trabajador ya está en el ciclo");
    if (!newWorker.name.trim()) return setError("Ingresa el nombre");

    const payRut = normalizeRut(newWorker.bd_paymentRut || rut);
    if (!validateRut(payRut)) return setError("RUT de pago inválido");
    const bankCode = isCash ? CASH_BANK_CODE : (accType === ACCOUNT_TYPE_RUT ? DEFAULT_BANK_CODE : newWorker.bd_bankCode);
    if (!bankCode) return setError("Selecciona el banco");
    const accNumber = isCash
      ? "EFECTIVO"
      : (accType === ACCOUNT_TYPE_RUT ? rutWithoutDv(payRut) : String(newWorker.bd_accountNumber || "").trim());
    if (!accNumber) return setError("Número de cuenta requerido");

    setBusy(true);
    try {
      const existing = await findWorkerByRut(rut);
      if (existing) {
        onPick({ rut: existing.id, name: existing.name });
        return;
      }
      const created = await createWorker({ rut, name: newWorker.name });
      const bankDetails = [payRut, accNumber, accType, bankCode];
      const leaderChoice = String(newWorker.leader || "").trim().toUpperCase() || defaultLeaderForRut(rut);
      const groupLeader = [leaderChoice];
      await workersService.update(created.id, { bankDetails, groupLeader, idQr: [] });
      onPick({ rut: created.id, name: created.name });
    } catch (err) {
      setError(err.message || "Error");
    } finally {
      setBusy(false);
    }
  };

  const submitTemp = (e) => {
    e.preventDefault();
    setError("");
    const name = tempName.trim();
    if (!name) return setError("Ingresa el nombre");
    const leader = String(tempLeader || "").trim().toUpperCase() || LEADER_LOCAL;
    const tempRut = `TEMP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    onPick({ rut: tempRut, name, isTemp: true, groupLeader: leader });
  };

  return (
    <Modal open={open} onClose={onClose} title={title} size={creating ? "lg" : "md"}>
      {creatingTemp ? (
        <form onSubmit={submitTemp} className="space-y-3">
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            Trabajador <b>temporal</b>: solo vive en este ciclo y se ignora al pagar nóminas. Cuando llegue el RUT real, usa <b>Asignar RUT</b> en su fila para convertirlo.
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Nombre" required autoFocus value={tempName} onChange={setTempName} />
            <Select
              label="Líder del grupo"
              required
              value={tempLeader}
              onChange={setTempLeader}
              options={leaderOptions.map((l) => ({ value: l, label: l }))}
              placeholder="Selecciona"
            />
          </div>
          {error && <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-[var(--color-danger)]">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => { setCreatingTemp(false); setError(""); }}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
            >
              Volver
            </button>
            <button
              type="submit"
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)]"
            >
              Crear temporal
            </button>
          </div>
        </form>
      ) : !creating ? (
        <div className="space-y-3">
          <TextField label="Buscar por RUT, nombre o apellido" value={search} onChange={setSearch} autoFocus />
          <div className="max-h-72 overflow-y-auto rounded-md border border-[var(--color-border)]">
            {loading && allWorkers.length === 0 ? (
              <div className="p-3 text-sm text-[var(--color-muted)]">Cargando catálogo...</div>
            ) : !queryReady ? (
              <div className="p-3 text-sm text-[var(--color-muted)]">
                Escribe al menos {MIN_SEARCH} caracteres (RUT, nombre o apellido).
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-3 text-sm text-[var(--color-muted)]">Sin coincidencias.</div>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {filtered.map((w) => (
                  <li key={w.id}>
                    <button
                      onClick={() => onPick({ rut: w.id, name: w.name })}
                      className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-[var(--color-accent-soft)]"
                    >
                      <span className="text-sm font-medium">{w.name}</span>
                      <span className="text-xs text-[var(--color-muted)]">{formatRutForDisplay(w.id)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              onClick={() => setCreating(true)}
              className="rounded-md border border-dashed border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
            >
              + Crear nuevo trabajador
            </button>
            {allowTemp && (
              <button
                onClick={() => { setCreatingTemp(true); setTempName(""); setError(""); }}
                className="rounded-md border border-dashed border-amber-500/60 px-3 py-2 text-sm text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
                title="Crear un trabajador solo para este ciclo, sin RUT, mientras llega la información"
              >
                + Crear trabajador temporal
              </button>
            )}
          </div>
        </div>
      ) : (
        <form onSubmit={submitNew} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <TextField
                label="RUT"
                required
                autoFocus
                placeholder="12345678-K o 12345678-B"
                value={newWorker.rut}
                onChange={onRutChange}
              />
            </div>
            <TextField
              label="Nombre"
              required
              value={newWorker.name}
              onChange={(v) => setNewWorker((w) => ({ ...w, name: v }))}
            />
            <Select
              label="Líder del grupo"
              required
              value={newWorker.leader || (newWorker.rut ? defaultLeaderForRut(newWorker.rut) : LEADER_LOCAL)}
              onChange={(v) => setNewWorker((w) => ({ ...w, leader: String(v || "").toUpperCase() }))}
              options={leaderOptions.map((l) => ({ value: l, label: l }))}
              placeholder="Selecciona"
            />
          </div>

          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">Datos bancarios</h3>
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={setQuickCash}
                  className={`rounded-md border px-2 py-1 text-xs ${isCash ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : "border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]"}`}
                >
                  💵 Efectivo
                </button>
                <button
                  type="button"
                  onClick={setQuickCuentaRut}
                  className={`rounded-md border px-2 py-1 text-xs ${isCuentaRutSelected ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : "border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]"}`}
                >
                  🏦 Cuenta RUT
                </button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="RUT de pago"
                required
                value={newWorker.bd_paymentRut}
                onChange={onPaymentRutChange}
                placeholder="Puede diferir del trabajador"
              />
              <Select
                label="Tipo de cuenta"
                required
                value={String(newWorker.bd_accountType)}
                onChange={onAccountTypeChange}
                options={ACCOUNT_TYPES.map((t) => ({ value: String(t.value), label: t.label }))}
                placeholder="Selecciona"
              />
              <TextField
                label="Número de cuenta"
                required
                value={newWorker.bd_accountNumber}
                onChange={(v) => setNewWorker((w) => ({ ...w, bd_accountNumber: v }))}
              />
              <Select
                label="Banco"
                required
                value={newWorker.bd_bankCode}
                onChange={(v) => setNewWorker((w) => ({ ...w, bd_bankCode: v }))}
                options={BANKS.map((b) => ({ value: b.code, label: `${b.code} · ${b.name}` }))}
                placeholder="Selecciona"
              />
            </div>
          </div>

          {error && <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-[var(--color-danger)]">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setCreating(false)}
              disabled={busy}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
            >
              Volver
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
            >
              {busy ? "..." : "Crear y agregar"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
