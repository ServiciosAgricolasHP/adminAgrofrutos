import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useTheme } from "../contexts/ThemeContext";

const navItems = [
  { to: "/", label: "Dashboard", icon: "🏠", end: true },
  { to: "/faenas", label: "Faenas", icon: "🌾" },
  { to: "/calendar", label: "Calendario", icon: "📅" },
  { to: "/workers", label: "Trabajadores", icon: "👷" },
  { to: "/transports", label: "Transportes", icon: "🚛" },
  { to: "/advances", label: "Anticipos / Bonos", icon: "🪙" },
  { to: "/payroll", label: "Nómina", icon: "💰" },
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
          <NavLink to="/audit" className={linkClass}>
            <span>🛡️</span>
            <span>Auditoría</span>
          </NavLink>
        )}
        {isAdmin && (
          <>
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
          </>
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
              <span className="truncate">{user?.email}</span>
              <span className="ml-2 rounded bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] text-[var(--color-accent)] sm:text-xs">
                {user?.role}
              </span>
            </div>
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
        <main className="flex-1 overflow-auto p-3 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
