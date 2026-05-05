import { BrowserRouter, Routes, Route } from "react-router-dom";
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
                <Route
                  path="audit"
                  element={
                    <ProtectedRoute adminOnly>
                      <Placeholder title="Auditoría" />
                    </ProtectedRoute>
                  }
                />
              </Route>
            </Routes>
            </BrowserRouter>
          </CarriersProvider>
        </CatalogsProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
