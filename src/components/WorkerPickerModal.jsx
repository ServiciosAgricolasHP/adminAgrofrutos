import { useEffect, useMemo, useRef, useState } from "react";
import Modal from "./Modal";
import TextField from "./TextField";
import Select from "./Select";
import { workersService } from "../services";
import { findWorkerByRut, createWorker, searchWorkers } from "../services/workersService";
import { formatRutForDisplay, normalizeRut, validateRut, isForeignRut } from "../utils/rutUtils";
import {
  BANKS,
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_RUT,
  CASH_BANK_CODE,
  DEFAULT_BANK_CODE,
  rutWithoutDv,
} from "../utils/banks";

const MIN_SEARCH = 4;
const LEADER_LOCAL = "CHILENOS";
const LEADER_FOREIGN = "EXTRANJEROS";

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
  };
}

export default function WorkerPickerModal({ open, onClose, onPick, excludeRuts = [] }) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [newWorker, setNewWorker] = useState(emptyNewWorker());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const cacheRef = useRef(new Map());
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setResults([]);
    setCreating(false);
    setNewWorker(emptyNewWorker());
    setError("");
    cacheRef.current = new Map();
  }, [open]);

  const excluded = useMemo(() => new Set(excludeRuts.map((r) => normalizeRut(r))), [excludeRuts]);

  const queryRaw = search.trim();
  const queryReady = queryRaw.replace(/[.\s-]/g, "").length >= MIN_SEARCH;

  useEffect(() => {
    if (!open || !queryReady) {
      setResults([]);
      setLoading(false);
      return;
    }
    const key = queryRaw.toLowerCase();
    const cached = cacheRef.current.get(key);
    if (cached) {
      setResults(cached);
      setLoading(false);
      return;
    }
    const myId = ++reqIdRef.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const list = await searchWorkers(queryRaw, { take: 30 });
        if (reqIdRef.current !== myId) return;
        cacheRef.current.set(key, list);
        setResults(list);
      } finally {
        if (reqIdRef.current === myId) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [open, queryRaw, queryReady]);

  const filtered = useMemo(
    () => results.filter((w) => !excluded.has(w.id)).slice(0, 30),
    [results, excluded],
  );

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
      const groupLeader = [defaultLeaderForRut(rut)];
      await workersService.update(created.id, { bankDetails, groupLeader, idQr: [] });
      onPick({ rut: created.id, name: created.name });
    } catch (err) {
      setError(err.message || "Error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Agregar trabajador" size={creating ? "lg" : "md"}>
      {!creating ? (
        <div className="space-y-3">
          <TextField label="Buscar por RUT o nombre" value={search} onChange={setSearch} autoFocus />
          <div className="max-h-72 overflow-y-auto rounded-md border border-[var(--color-border)]">
            {!queryReady ? (
              <div className="p-3 text-sm text-[var(--color-muted)]">
                Escribe al menos {MIN_SEARCH} caracteres (RUT o nombre).
              </div>
            ) : loading ? (
              <div className="p-3 text-sm text-[var(--color-muted)]">Buscando...</div>
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
          <button
            onClick={() => setCreating(true)}
            className="w-full rounded-md border border-dashed border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
          >
            + Crear nuevo trabajador
          </button>
        </div>
      ) : (
        <form onSubmit={submitNew} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <TextField
                label="RUT"
                required
                autoFocus
                placeholder="12345678-K o 12345678-B"
                value={newWorker.rut}
                onChange={onRutChange}
              />
              {newWorker.rut && (
                <p className="mt-1 text-[10px] text-[var(--color-muted)]">
                  Líder por defecto: <b>{defaultLeaderForRut(newWorker.rut)}</b>
                </p>
              )}
            </div>
            <TextField
              label="Nombre"
              required
              value={newWorker.name}
              onChange={(v) => setNewWorker((w) => ({ ...w, name: v }))}
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
