import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import ProtectedRoute from "./components/ProtectedRoute";
import Layout from "./components/Layout";
import Login from "./screens/Login";
import Dashboard from "./screens/Dashboard";
import Placeholder from "./screens/Placeholder";
import Faenas from "./screens/Faenas";
import Harvests from "./screens/Harvests";
import CycleDetail from "./screens/CycleDetail";

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
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
              <Route path="harvests" element={<Harvests />} />
              <Route path="cycles/:id" element={<CycleDetail />} />
              <Route path="workers" element={<Placeholder title="Trabajadores" />} />
              <Route path="transports" element={<Placeholder title="Transportes" />} />
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
      </AuthProvider>
    </ThemeProvider>
  );
}
