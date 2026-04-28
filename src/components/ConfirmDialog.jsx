import Modal from "./Modal";

export default function ConfirmDialog({ open, title = "Confirmar", message, onConfirm, onCancel, confirmLabel = "Confirmar", danger = false, busy = false }) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 ${
              danger ? "bg-[var(--color-danger)] hover:opacity-90" : "bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]"
            }`}
          >
            {busy ? "..." : confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm text-[var(--color-muted)]">{message}</p>
    </Modal>
  );
}
