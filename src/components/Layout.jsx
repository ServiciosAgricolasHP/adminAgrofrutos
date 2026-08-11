import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useTheme } from "../contexts/ThemeContext";
import Modal from "./Modal";
import { indicatorsService } from "../services";

const INDICATORS_DOC = "main";
const INDICATOR_DEFS = [
  { key: "sueldoBase", label: "Sueldo base", icon: "💵" },
  { key: "dia", label: "Día", icon: "📅" },
  { key: "hora", label: "Hora extra", icon: "⏱" },
];
const fmtCLP = (v) =>
  Number(v) > 0
    ? new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(Number(v))
    : "—";

// Inyectado por Vite en build-time desde el count de commits de HEAD.
// Visible en el header para confirmar que el bundle no quedó en caché vieja
// (PWA/Service Worker). Si el usuario ve una versión menor a la última
// desplegada → hard refresh.
export const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

const navItems = [
  { to: "/", label: "Dashboard", icon: "🏠", end: true },
  { to: "/faenas", label: "Faenas", icon: "🌾" },
  { to: "/calendar", label: "Calendario", icon: "📅" },
  { to: "/workers", label: "Trabajadores", icon: "👷" },
  { to: "/transports", label: "Transportes", icon: "🚛" },
  { to: "/advances", label: "Anticipos / Bonos", icon: "🪙" },
  { to: "/payroll", label: "Nómina", icon: "💰" },
  { to: "/facturacion", label: "Facturación", icon: "🧾" },
  { to: "/price-book", label: "Libro de Precios", icon: "📖" },
  { to: "/info-cuentas", label: "Información y Cuentas", icon: "📇" },
  { to: "/links", label: "Links útiles", icon: "🔗" },
];

function ThemePicker() {
  const { theme, setTheme, themes } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const current = themes.find((t) => t.key === theme) || themes[0];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] sm:px-3"
      >
        🎨 <span className="hidden sm:inline">{current.label}</span>
        <span className="text-[var(--color-muted)]">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-48 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg">
          {themes.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                setTheme(t.key);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-[var(--color-accent-soft)] ${
                t.key === theme
                  ? "font-medium text-[var(--color-accent)]"
                  : "text-[var(--color-text)]"
              }`}
            >
              <span>{t.label}</span>
              {t.key === theme && <span>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Desktop sidebar collapsed state, persisted between sessions. Hidden
  // entirely when collapsed to give the main content the full viewport width.
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem("layout.sidebarOpen") !== "false"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("layout.sidebarOpen", String(sidebarOpen)); } catch { /* noop */ }
  }, [sidebarOpen]);
  // Sección Admin colapsable — persistida entre sesiones. Default cerrada
  // porque el admin la usa esporádicamente y evita que el sidebar quede
  // largo. Solo aplica cuando el usuario es admin.
  const [adminExpanded, setAdminExpanded] = useState(() => {
    try { return localStorage.getItem("layout.adminExpanded") === "true"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("layout.adminExpanded", String(adminExpanded)); } catch { /* noop */ }
  }, [adminExpanded]);

  // Indicadores del banner (sueldo base / día / hora extra). Carga única al
  // montar; se editan manualmente vía modal y quedan en el doc `indicators/main`.
  const [indicators, setIndicators] = useState(null);
  const [indicatorsModalOpen, setIndicatorsModalOpen] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const doc = await indicatorsService.getById(INDICATORS_DOC);
        setIndicators(doc || {});
      } catch {
        setIndicators({});
      }
    })();
  }, []);
  const saveIndicators = async (values) => {
    await indicatorsService.upsert(INDICATORS_DOC, values);
    setIndicators((prev) => ({ ...(prev || {}), ...values }));
    setIndicatorsModalOpen(false);
  };

  // Auto-close drawer on route change
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Single button handles both mobile drawer and desktop collapse depending
  // on viewport width so the user only has to learn one control.
  const onMenuClick = () => {
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches) {
      setSidebarOpen((o) => !o);
    } else {
      setDrawerOpen(true);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  const linkClass = ({ isActive }) =>
    `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
      isActive
        ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
        : "text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
    }`;

  const sidebarContent = (
    <>
      <div className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4 font-semibold">
        <span>🌾</span>
        <span>Agrofrutos</span>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {navItems.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={linkClass}>
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
        {isAdmin && (
          <div className="mt-3 border-t border-[var(--color-border)] pt-2">
            <button
              type="button"
              onClick={() => setAdminExpanded((v) => !v)}
              className="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
              aria-expanded={adminExpanded}
            >
              <span className="flex items-center gap-2">
                <span>🛡️</span>
                <span>Admin</span>
              </span>
              <span>{adminExpanded ? "▾" : "▸"}</span>
            </button>
            {adminExpanded && (
              <div className="mt-1 space-y-1">
                <NavLink to="/audit" className={linkClass}>
                  <span>🛡️</span>
                  <span>Auditoría</span>
                </NavLink>
                <NavLink to="/admin/migrate-workers" className={linkClass}>
                  <span>📥</span>
                  <span>Migrar CSV</span>
                </NavLink>
                <NavLink to="/admin/cleanup-paid-workdays" className={linkClass}>
                  <span>🧹</span>
                  <span>Limpiar pagados</span>
                </NavLink>
                <NavLink to="/admin/console" className={linkClass}>
                  <span>📟</span>
                  <span>Consola</span>
                </NavLink>
                <NavLink to="/admin/harvest-qr" className={linkClass}>
                  <span>📷</span>
                  <span>Cosecha QR</span>
                </NavLink>
              </div>
            )}
          </div>
        )}
      </nav>
    </>
  );

  return (
    <div className="flex h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* Desktop sidebar */}
      <aside className={`hidden w-60 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] ${sidebarOpen ? "md:flex" : ""}`}>
        {sidebarContent}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
            aria-label="Cerrar menú"
          />
          <aside className="absolute inset-y-0 left-0 flex w-60 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
            {sidebarContent}
          </aside>
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 sm:px-4">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={onMenuClick}
              aria-label={sidebarOpen ? "Ocultar barra lateral" : "Mostrar barra lateral"}
              title={sidebarOpen ? "Ocultar barra lateral" : "Mostrar barra lateral"}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
            >
              ☰
            </button>
            <div className="truncate text-xs text-[var(--color-muted)] sm:text-sm">
              <span className="font-semibold text-[var(--color-text)]">Agrofrutos {APP_VERSION}</span>
              <span className="mx-1.5 text-[var(--color-border)]">·</span>
              <span className="truncate">{user?.email}</span>
              <span className="ml-2 rounded bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] text-[var(--color-accent)] sm:text-xs">
                {user?.role}
              </span>
            </div>
          </div>
          {/* Indicadores en el centro del header — solo en desktop ancho; en
              mobile van en la barra de abajo (IndicatorsBar). */}
          <div className="hidden min-w-0 flex-1 items-center justify-center gap-2 lg:flex">
            <div className="flex items-center gap-2 overflow-x-auto">
              <IndicatorChips indicators={indicators} />
            </div>
            <EditIndicatorsButton onEdit={() => setIndicatorsModalOpen(true)} />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1 sm:gap-2">
            <ThemePicker />
            <button
              onClick={handleLogout}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-sm hover:bg-[var(--color-accent-soft)] sm:px-3"
            >
              Salir
            </button>
          </div>
        </header>
        <IndicatorsBar indicators={indicators} onEdit={() => setIndicatorsModalOpen(true)} />
        <main className="flex-1 overflow-auto p-3 sm:p-6">
          <Outlet />
        </main>
      </div>

      {indicatorsModalOpen && (
        <IndicatorsModal
          indicators={indicators}
          onCancel={() => setIndicatorsModalOpen(false)}
          onSave={saveIndicators}
        />
      )}
    </div>
  );
}

// Los 3 chips de indicadores (sin contenedor). Se reusa en el centro del
// header (desktop) y en la barra tipo ticker de mobile.
function IndicatorChips({ indicators }) {
  return INDICATOR_DEFS.map((ind) => (
    <div
      key={ind.key}
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs"
    >
      <span>{ind.icon}</span>
      <span className="text-[var(--color-muted)]">{ind.label}</span>
      <span className="font-semibold tabular-nums text-[var(--color-text)]">
        {fmtCLP(indicators?.[ind.key])}
      </span>
    </div>
  ));
}

function EditIndicatorsButton({ onEdit }) {
  return (
    <button
      onClick={onEdit}
      title="Editar indicadores"
      className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
    >
      ✎
    </button>
  );
}

// Barra tipo ticker — solo en mobile/tablet angosto, donde el header no tiene
// espacio para los indicadores en el centro. Scroll horizontal por si acaso.
function IndicatorsBar({ indicators, onEdit }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 sm:px-4 lg:hidden">
      <div className="flex flex-1 items-center gap-2 overflow-x-auto">
        <IndicatorChips indicators={indicators} />
      </div>
      <EditIndicatorsButton onEdit={onEdit} />
    </div>
  );
}

// Modal para editar los 3 indicadores a la vez. Inputs numéricos simples.
function IndicatorsModal({ indicators, onCancel, onSave }) {
  const [form, setForm] = useState(() => ({
    sueldoBase: indicators?.sueldoBase ?? "",
    dia: indicators?.dia ?? "",
    hora: indicators?.hora ?? "",
  }));
  const [busy, setBusy] = useState(false);

  const set = (key, raw) => {
    // Solo dígitos — los montos en CLP no llevan decimales.
    const digits = String(raw).replace(/[^\d]/g, "");
    setForm((f) => ({ ...f, [key]: digits === "" ? "" : Number(digits) }));
  };

  const submit = async () => {
    setBusy(true);
    try {
      await onSave({
        sueldoBase: Number(form.sueldoBase) || 0,
        dia: Number(form.dia) || 0,
        hora: Number(form.hora) || 0,
      });
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]";

  return (
    <Modal
      open
      onClose={onCancel}
      size="sm"
      title="Editar indicadores"
      footer={
        <>
          <button onClick={onCancel} className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
          >
            {busy ? "Guardando…" : "Guardar"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {INDICATOR_DEFS.map((ind) => (
          <div key={ind.key}>
            <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">
              {ind.icon} {ind.label}
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--color-muted)]">$</span>
              <input
                type="text"
                inputMode="numeric"
                value={form[ind.key] === "" ? "" : Number(form[ind.key]).toLocaleString("es-CL")}
                onChange={(e) => set(ind.key, e.target.value)}
                placeholder="0"
                className={inputCls}
              />
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
