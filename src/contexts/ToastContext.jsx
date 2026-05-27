import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Sistema de notificaciones tipo toast — reemplaza los `window.alert` nativos
// del navegador (que rompen estética y bloquean el hilo de UI). Soporta cuatro
// niveles (success/error/info/warning), auto-dismiss configurable, click-to-
// dismiss, y mensajes multilinea (renderiza `\n` como salto). Stackea arriba
// a la derecha con animación.

const ToastContext = createContext(null);

const TYPE_META = {
  success: {
    icon: "✓",
    border: "border-[var(--color-success,#16a34a)]",
    bg: "bg-[var(--color-success-soft,rgba(22,163,74,0.12))]",
    text: "text-[var(--color-success,#16a34a)]",
    defaultDuration: 3500,
  },
  error: {
    icon: "✕",
    border: "border-[var(--color-danger,#dc2626)]",
    bg: "bg-[var(--color-danger-soft,rgba(220,38,38,0.12))]",
    text: "text-[var(--color-danger,#dc2626)]",
    defaultDuration: 7000,
  },
  warning: {
    icon: "⚠",
    border: "border-[var(--color-warning,#d97706)]",
    bg: "bg-[var(--color-warning-soft,rgba(217,119,6,0.12))]",
    text: "text-[var(--color-warning,#d97706)]",
    defaultDuration: 5500,
  },
  info: {
    icon: "ℹ",
    border: "border-[var(--color-accent,#2563eb)]",
    bg: "bg-[var(--color-accent-soft,rgba(37,99,235,0.12))]",
    text: "text-[var(--color-accent,#2563eb)]",
    defaultDuration: 4500,
  },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((type, message, opts = {}) => {
    if (message == null) return null;
    const id = ++idRef.current;
    const meta = TYPE_META[type] || TYPE_META.info;
    const duration = opts.duration ?? meta.defaultDuration;
    const title = opts.title || null;
    setToasts((prev) => [...prev, { id, type, message: String(message), title, duration }]);
    return id;
  }, []);

  const toast = useMemo(
    () => ({
      success: (msg, opts) => show("success", msg, opts),
      error: (msg, opts) => show("error", msg, opts),
      warning: (msg, opts) => show("warning", msg, opts),
      info: (msg, opts) => show("info", msg, opts),
      dismiss,
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fallback graceful: si por error alguien lo usa sin provider, no rompemos
    // la app — caemos al alert nativo. Esto facilita el reemplazo gradual.
    return {
      success: (m) => window.alert(m),
      error: (m) => window.alert(m),
      warning: (m) => window.alert(m),
      info: (m) => window.alert(m),
      dismiss: () => {},
    };
  }
  return ctx;
}

function ToastViewport({ toasts, onDismiss }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed right-3 top-3 z-[9999] flex w-[min(420px,calc(100vw-1.5rem))] flex-col gap-2 sm:right-5 sm:top-5"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>,
    document.body,
  );
}

function ToastItem({ toast, onDismiss }) {
  const meta = TYPE_META[toast.type] || TYPE_META.info;
  // Auto-dismiss timer pausable cuando el mouse está encima. Implementado con
  // un ref + recalcular remaining al hover/leave para que el usuario tenga
  // tiempo de leer mensajes largos.
  const remainingRef = useRef(toast.duration);
  const startedRef = useRef(Date.now());
  const timerRef = useRef(null);

  useEffect(() => {
    if (!toast.duration || toast.duration <= 0) return;
    startedRef.current = Date.now();
    timerRef.current = setTimeout(onDismiss, remainingRef.current);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onMouseEnter = () => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedRef.current));
  };
  const onMouseLeave = () => {
    if (!toast.duration || toast.duration <= 0) return;
    if (timerRef.current) return;
    startedRef.current = Date.now();
    timerRef.current = setTimeout(onDismiss, remainingRef.current);
  };

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onDismiss}
      role="alert"
      className={`pointer-events-auto cursor-pointer animate-[toastIn_180ms_ease-out] rounded-md border ${meta.border} ${meta.bg} bg-[var(--color-surface)] shadow-lg`}
      style={{ animation: "toastIn 180ms ease-out" }}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span className={`mt-0.5 text-base leading-none ${meta.text}`}>{meta.icon}</span>
        <div className="min-w-0 flex-1">
          {toast.title && (
            <div className={`text-xs font-semibold uppercase tracking-wide ${meta.text}`}>
              {toast.title}
            </div>
          )}
          <div className="whitespace-pre-line break-words text-sm text-[var(--color-text)]">
            {toast.message}
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          aria-label="Cerrar"
          className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
        >
          ×
        </button>
      </div>
    </div>
  );
}
