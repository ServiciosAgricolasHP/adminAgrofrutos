import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { CatalogsProvider } from "./contexts/CatalogsContext";
import { CarriersProvider } from "./contexts/CarriersContext";
import ProtectedRoute from "./components/ProtectedRoute";
import Layout from "./components/Layout";
import Login from "./screens/Login";
import Dashboard from "./screens/Dashboard";
import Placeholder from "./screens/Placeholder";
import Faenas from "./screens/Faenas";
import CycleDetail from "./screens/CycleDetail";
import Workers from "./screens/Workers";
import Transports from "./screens/Transports";
import Payroll from "./screens/Payroll";
import Advances from "./screens/Advances";
import MigrateWorkers from "./screens/MigrateWorkers";
import CleanupPaidWorkdays from "./screens/CleanupPaidWorkdays";
import InterestLinks from "./screens/InterestLinks";
import AdminConsole from "./screens/AdminConsole";
import Calendar from "./screens/Calendar";
import Facturacion from "./screens/Facturacion";

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <CatalogsProvider>
          <CarriersProvider>
            <BrowserRouter basename="/adminAgrofrutos">
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route
                element={
                  <ProtectedRoute>
                    <Layout />
                  </ProtectedRoute>
                }
              >
                <Route index element={<Dashboard />} />
                <Route path="faenas" element={<Faenas />} />
                <Route path="cycles/:id" element={<CycleDetail />} />
                <Route path="workers" element={<Workers />} />
                <Route path="transports" element={<Transports />} />
                <Route path="payroll" element={<Payroll />} />
                <Route path="advances" element={<Advances />} />
                <Route path="links" element={<InterestLinks />} />
                <Route path="calendar" element={<Calendar />} />
                <Route path="facturacion" element={<Facturacion />} />
                <Route
                  path="audit"
                  element={
                    <ProtectedRoute adminOnly>
                      <Placeholder title="Auditoría" />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="admin/migrate-workers"
                  element={
                    <ProtectedRoute adminOnly>
                      <MigrateWorkers />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="admin/cleanup-paid-workdays"
                  element={
                    <ProtectedRoute adminOnly>
                      <CleanupPaidWorkdays />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="admin/console"
                  element={
                    <ProtectedRoute adminOnly>
                      <AdminConsole />
                    </ProtectedRoute>
                  }
                />
                <Route path="*" element={<NotFound />} />
              </Route>
              <Route path="*" element={<NotFound />} />
            </Routes>
            </BrowserRouter>
          </CarriersProvider>
        </CatalogsProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="text-5xl">🤔</div>
      <h1 className="mt-4 text-2xl font-semibold">Página no encontrada</h1>
      <p className="mt-2 max-w-md text-sm text-[var(--color-muted)]">
        La URL no corresponde a ninguna pantalla del sistema. Puede que el ciclo
        fue eliminado o que el link esté mal escrito.
      </p>
      <div className="mt-6 flex gap-2">
        <button
          type="button"
          onClick={() => window.history.back()}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2 text-sm hover:bg-[var(--color-accent-soft)]"
        >
          ← Volver
        </button>
        <Link
          to="/"
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
        >
          Ir al Dashboard
        </Link>
      </div>
    </div>
  );
}
