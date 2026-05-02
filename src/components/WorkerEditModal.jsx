import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import TextField from "./TextField";
import Select from "./Select";
import { workersService } from "../services";
import { createWorker, findWorkerByRut } from "../services/workersService";
import { formatRutForDisplay, normalizeRut, validateRut, isForeignRut } from "../utils/rutUtils";
import { findSimilarWorkers } from "../utils/similarity";
import {
  BANKS,
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_RUT,
  DEFAULT_BANK_CODE,
  rutWithoutDv,
} from "../utils/banks";

function normalizeIdQrInput(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function WorkerEditModal({ open, mode, worker, allWorkers = [], onClose, onSaved }) {
  const isCreate = mode === "create";
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [overrideSimilar, setOverrideSimilar] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError("");
    setOverrideSimilar(false);
    if (isCreate) {
      setForm({
        rut: "",
        name: "",
        groupLeader: "",
        groupLeaderHistory: [],
        idQrText: "",
        bd_paymentRut: "",
        bd_accountNumber: "",
        bd_accountType: ACCOUNT_TYPE_RUT,
        bd_bankCode: DEFAULT_BANK_CODE,
      });
    } else {
      const bd = worker?.bankDetails || [];
      const rut = worker?.id || "";
      setForm({
        rut,
        name: worker?.name || "",
        groupLeader: worker?.groupLeader?.[0] || "",
        groupLeaderHistory: worker?.groupLeader || [],
        idQrText: (worker?.idQr || []).join(", "),
        bd_paymentRut: bd[0] || rut,
        bd_accountNumber: bd[1] || rutWithoutDv(rut),
        bd_accountType: bd[2] != null ? Number(bd[2]) : ACCOUNT_TYPE_RUT,
        bd_bankCode: bd[3] || DEFAULT_BANK_CODE,
      });
    }
  }, [open, worker, isCreate]);

  const similarMatches = useMemo(() => {
    if (!isCreate || !form?.name || form.name.trim().length < 3) return [];
    return findSimilarWorkers(form.name, allWorkers, { threshold: 0.8, limit: 4 });
  }, [isCreate, form?.name, allWorkers]);

  const showSimilarBlock = isCreate && similarMatches.length > 0;
  const isForeign = form ? isForeignRut(form.rut) : false;
  const requireOverride = showSimilarBlock && (isForeign || similarMatches.some((m) => m.score >= 0.92));

  if (!form) return <Modal open={open} onClose={onClose} title="..." />;

  const accType = Number(form.bd_accountType);
  const isCuentaRutSelected = accType === ACCOUNT_TYPE_RUT;

  const onAccountTypeChange = (v) => {
    const t = Number(v);
    setForm((f) => {
      const next = { ...f, bd_accountType: t };
      if (t === ACCOUNT_TYPE_RUT) {
        next.bd_bankCode = DEFAULT_BANK_CODE;
        next.bd_accountNumber = rutWithoutDv(f.bd_paymentRut || form.rut);
      }
      return next;
    });
  };

  const onPaymentRutChange = (v) => {
    setForm((f) => {
      const norm = normalizeRut(v);
      const next = { ...f, bd_paymentRut: norm };
      if (Number(f.bd_accountType) === ACCOUNT_TYPE_RUT) next.bd_accountNumber = rutWithoutDv(norm);
      return next;
    });
  };

  const submit = async (e) => {
    e.preventDefault();
    setError("");

    const rut = normalizeRut(form.rut);
    if (!validateRut(rut)) return setError("RUT inválido");
    if (!form.name.trim()) return setError("Ingresa el nombre");

    if (requireOverride && !overrideSimilar) {
      return setError("Confirma que es un trabajador distinto antes de continuar.");
    }

    if (isCreate) {
      const dup = await findWorkerByRut(rut);
      if (dup) return setError("Ya existe un trabajador con ese RUT");
    }

    const payRut = normalizeRut(form.bd_paymentRut || rut);
    if (!validateRut(payRut)) return setError("RUT de pago inválido");

    const accNumber =
      accType === ACCOUNT_TYPE_RUT ? rutWithoutDv(payRut) : String(form.bd_accountNumber || "").trim();
    if (!accNumber) return setError("Número de cuenta requerido");
    const bankCode = accType === ACCOUNT_TYPE_RUT ? DEFAULT_BANK_CODE : form.bd_bankCode;
    if (!bankCode) return setError("Selecciona el banco");

    const newLeader = form.groupLeader.trim().toUpperCase();
    const prevLeaders = form.groupLeaderHistory || [];
    let groupLeader = prevLeaders;
    if (newLeader && newLeader !== prevLeaders[0]) groupLeader = [newLeader, ...prevLeaders];
    else if (!newLeader && prevLeaders.length === 0) groupLeader = [];

    const idQr = normalizeIdQrInput(form.idQrText);
    const bankDetails = [payRut, accNumber, accType, bankCode];

    setBusy(true);
    try {
      if (isCreate) {
        await createWorker({ rut, name: form.name });
        await workersService.update(rut, { groupLeader, idQr, bankDetails });
      } else {
        await workersService.update(worker.id, {
          name: form.name.trim().toUpperCase(),
          groupLeader,
          idQr,
          bankDetails,
        });
      }
      onSaved?.();
    } catch (err) {
      setError(err.message || "Error al guardar");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={isCreate ? "Nuevo trabajador" : `Editar ${formatRutForDisplay(worker?.id)}`}
      size="lg"
    >
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <TextField
              label="RUT"
              required
              placeholder="12345678-K o 12345678-B"
              value={form.rut}
              onChange={(v) => isCreate && setForm((f) => ({ ...f, rut: v }))}
            />
            {!isCreate && (
              <p className="mt-1 text-xs text-[var(--color-muted)]">El RUT no se puede modificar.</p>
            )}
            {isCreate && isForeign && (
              <p className="mt-1 text-xs text-[var(--color-warning)]">
                RUT extranjero — no se valida con dígito verificador. Verifica datos manualmente.
              </p>
            )}
          </div>
          <TextField
            label="Nombre"
            required
            value={form.name}
            onChange={(v) => setForm((f) => ({ ...f, name: v }))}
          />
        </div>

        {showSimilarBlock && (
          <div className="rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-4 text-sm">
            <div className="mb-2 font-medium text-[var(--color-warning)]">
              Posibles duplicados
            </div>
            <p className="mb-3 text-[var(--color-muted)]">
              Hay trabajadores con nombre muy similar. Verifica que no estés duplicando.
            </p>
            <ul className="mb-3 space-y-1">
              {similarMatches.map((m) => (
                <li key={m.worker.id} className="flex items-center justify-between text-xs">
                  <span className="font-medium text-[var(--color-text)]">{m.worker.name}</span>
                  <span className="text-[var(--color-muted)]">
                    {formatRutForDisplay(m.worker.id)} · {Math.round(m.score * 100)}%
                  </span>
                </li>
              ))}
            </ul>
            {requireOverride && (
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={overrideSimilar}
                  onChange={(e) => setOverrideSimilar(e.target.checked)}
                  className="mt-0.5"
                />
                <span>Confirmo que es una persona distinta y quiero crearla de todos modos.</span>
              </label>
            )}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Líder de grupo actual"
            value={form.groupLeader}
            onChange={(v) => setForm((f) => ({ ...f, groupLeader: v }))}
            placeholder="Nombre del líder"
          />
          <TextField
            label="IDs QR (separados por coma)"
            value={form.idQrText}
            onChange={(v) => setForm((f) => ({ ...f, idQrText: v }))}
            placeholder="QR1, QR2..."
          />
        </div>

        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Datos bancarios</h3>
            {isCuentaRutSelected && (
              <span className="rounded bg-[var(--color-accent-soft)] px-2 py-0.5 text-xs text-[var(--color-accent)]">
                Cuenta RUT (Banco Estado)
              </span>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="RUT de pago"
              required
              value={form.bd_paymentRut}
              onChange={onPaymentRutChange}
              placeholder="Puede diferir del trabajador"
            />
            <Select
              label="Tipo de cuenta"
              required
              value={String(form.bd_accountType)}
              onChange={onAccountTypeChange}
              options={ACCOUNT_TYPES.map((t) => ({ value: String(t.value), label: t.label }))}
              placeholder="Selecciona"
            />
            <TextField
              label="Número de cuenta"
              required
              value={form.bd_accountNumber}
              onChange={(v) => setForm((f) => ({ ...f, bd_accountNumber: v }))}
            />
            <Select
              label="Banco"
              required
              value={form.bd_bankCode}
              onChange={(v) => setForm((f) => ({ ...f, bd_bankCode: v }))}
              options={BANKS.map((b) => ({ value: b.code, label: `${b.code} · ${b.name}` }))}
              placeholder="Selecciona"
            />
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] shadow-sm hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
          >
            {busy ? "..." : "Guardar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
