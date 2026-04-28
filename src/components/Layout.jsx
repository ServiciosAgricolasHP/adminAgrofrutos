import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useTheme } from "../contexts/ThemeContext";

const navItems = [
  { to: "/", label: "Dashboard", icon: "🏠", end: true },
  { to: "/faenas", label: "Faenas", icon: "🌾" },
  { to: "/harvests", label: "Cosechas", icon: "🌽" },
  { to: "/workers", label: "Trabajadores", icon: "👷" },
  { to: "/transports", label: "Transportes", icon: "🚛" },
];

export default function Layout() {
  const { user, logout, isAdmin } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

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

  return (
    <div className="flex h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <aside className="flex w-60 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4 font-semibold">
          <span>🌾</span>
          <span>Agrofrutos</span>
        </div>
        <nav className="flex-1 space-y-1 p-2">
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
        </nav>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4">
          <div className="text-sm text-[var(--color-muted)]">
            {user?.email}
            <span className="ml-2 rounded bg-[var(--color-accent-soft)] px-2 py-0.5 text-xs text-[var(--color-accent)]">
              {user?.role}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
            >
              {theme === "dark" ? "☀️ Claro" : "🌙 Oscuro"}
            </button>
            <button
              onClick={handleLogout}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent-soft)]"
            >
              Salir
            </button>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
