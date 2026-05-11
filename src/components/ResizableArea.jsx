import { useEffect, useRef, useState } from "react";

const STORAGE_PREFIX = "af.gridHeight.";

// Wraps a grid/table area in a fixed-height container with a drag handle
// below it. The user can drag the handle vertically to grow or shrink the
// area; the chosen height is persisted in localStorage keyed by `storageKey`
// so it sticks between sessions. Heights are clamped to [minHeight,
// (viewport - 120px)] to keep the page usable.
export default function ResizableArea({
  storageKey,
  defaultHeight = 500,
  minHeight = 240,
  children,
}) {
  const computeMax = () => Math.max(minHeight + 100, window.innerHeight - 120);

  const [height, setHeight] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + storageKey);
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return Math.min(computeMax(), Math.max(minHeight, n));
    } catch { /* noop */ }
    return defaultHeight;
  });
  const heightRef = useRef(height);
  useEffect(() => { heightRef.current = height; }, [height]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_PREFIX + storageKey, String(height)); } catch { /* noop */ }
  }, [height, storageKey]);

  const onPointerDown = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = heightRef.current;
    const max = computeMax();
    const onMove = (ev) => {
      const next = Math.max(minHeight, Math.min(max, startH + (ev.clientY - startY)));
      setHeight(next);
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const onDoubleClick = () => setHeight(defaultHeight);

  return (
    <>
      <div style={{ height: `${height}px` }} className="flex min-h-0 flex-col">
        {children}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Arrastrar para cambiar el alto. Doble click para reiniciar."
        title="Arrastrar para cambiar el alto · Doble click para reiniciar"
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        className="group mt-1 mb-1 flex h-5 shrink-0 cursor-ns-resize select-none items-center justify-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[10px] font-medium text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
      >
        <span aria-hidden className="tracking-widest">⋮⋮⋮</span>
        <span className="hidden sm:inline">Arrastrar para cambiar el alto · Doble click para reiniciar</span>
        <span className="sm:hidden">Arrastrar para ajustar</span>
        <span aria-hidden className="tracking-widest">⋮⋮⋮</span>
      </div>
    </>
  );
}
