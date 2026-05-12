import { useEffect, useRef, useState } from "react";

const STORAGE_PREFIX = "af.gridHeight.";

// Headless hook for components that need to expose the resize control somewhere
// other than directly under the grid (e.g. a toolbar). Returns the current
// height, a drag-start handler and a reset helper; pair it with <ResizeHandle>.
export function useResizableHeight(storageKey, defaultHeight = 500, minHeight = 240) {
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

  // Mutable drag state. Kept in a ref so the pointermove/pointerup listeners
  // (attached imperatively in onPointerDown) always see fresh values even if
  // React re-renders mid-drag.
  const dragRef = useRef(null);

  // Pointer Events with setPointerCapture: the most reliable cross-device
  // approach. We capture the pointer on the handle DOM node itself, which
  // routes every subsequent pointermove/pointerup to that node regardless of
  // what the cursor is hovering over (ag-grid, popovers, iframes, etc.). No
  // window listeners means nothing else on the page can swallow the events.
  const onPointerDown = (e) => {
    // Only react to primary button on mouse; touch/pen have button === 0 too
    if (e.button !== undefined && e.button !== 0) return;
    const target = e.currentTarget;
    if (!target) return;

    const startY = e.clientY;
    const startH = heightRef.current;
    const max = computeMax();

    try { target.setPointerCapture(e.pointerId); } catch { /* noop */ }

    const move = (ev) => {
      const next = Math.max(minHeight, Math.min(max, startH + (ev.clientY - startY)));
      setHeight(next);
    };
    const stop = (ev) => {
      try { target.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
      target.removeEventListener("pointercancel", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      dragRef.current = null;
    };

    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
    target.addEventListener("pointercancel", stop);
    dragRef.current = { target, move, stop };

    // Prevent text selection on the surrounding page during drag. We do NOT
    // stopPropagation here: leaving the event to bubble lets other listeners
    // (e.g. dropdown close-on-outside) see the click as normal.
    e.preventDefault();
  };

  const reset = () => setHeight(defaultHeight);

  return { height, setHeight, onPointerDown, reset };
}

// Visible drag bar styled like a UI splitter. Spans the full width of its
// parent and shows a clear grip. Drag vertically to resize, double-click to
// reset. Mouse, pen and touch are all handled via Pointer Events.
export function ResizeHandle({ onPointerDown, onDoubleClick, label = "Arrastrar para cambiar el alto del grid · Doble click para reiniciar" }) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Arrastrar para cambiar el alto. Doble click para reiniciar."
      title={label}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      className="group relative my-1 flex h-3 w-full shrink-0 cursor-ns-resize select-none items-center justify-center rounded bg-[var(--color-surface-2)] hover:bg-[var(--color-accent-soft)]"
      style={{ touchAction: "none" }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[var(--color-border)] group-hover:bg-[var(--color-accent)]" />
      <div className="pointer-events-none relative z-10 flex h-2 w-12 items-center justify-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 group-hover:border-[var(--color-accent)]">
        <span className="block h-0.5 w-1 rounded-full bg-[var(--color-muted)] group-hover:bg-[var(--color-accent)]" />
        <span className="block h-0.5 w-1 rounded-full bg-[var(--color-muted)] group-hover:bg-[var(--color-accent)]" />
        <span className="block h-0.5 w-1 rounded-full bg-[var(--color-muted)] group-hover:bg-[var(--color-accent)]" />
      </div>
    </div>
  );
}

// Convenience wrapper: a fixed-height area with the drag handle rendered
// directly underneath. Used by screens that want everything self-contained.
// For screens that need the handle somewhere else (e.g. in a toolbar), use
// useResizableHeight + ResizeHandle directly.
export default function ResizableArea({
  storageKey,
  defaultHeight = 500,
  minHeight = 240,
  children,
}) {
  const { height, onPointerDown, reset } = useResizableHeight(storageKey, defaultHeight, minHeight);
  return (
    <>
      <div style={{ height: `${height}px` }} className="flex min-h-0 flex-col">
        {children}
      </div>
      <ResizeHandle onPointerDown={onPointerDown} onDoubleClick={reset} />
    </>
  );
}
