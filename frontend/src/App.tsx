import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ToastProvider } from './components/Toast';
import { ConfirmProvider } from './components/ui';
import { Layout } from './components/Layout';
import { useAuth } from './store/auth';
import { hasPermission, type Permission } from './lib/permissions';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Products from './pages/Products';
import StockPage from './pages/Stock';
import Deliveries from './pages/Deliveries';
import DeliveryNew from './pages/DeliveryNew';
import DeliveryDetail from './pages/DeliveryDetail';
import Entries from './pages/Entries';
import Transfers from './pages/Transfers';
import Counts from './pages/Counts';
import Movements from './pages/Movements';
import Users from './pages/Users';
import Locations from './pages/Locations';
import Reports from './pages/Reports';
import Audit from './pages/Audit';

function Protected({ children }: { children: ReactNode }) {
  const user = useAuth((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequirePerm({ perm, children }: { perm: Permission; children: ReactNode }) {
  const user = useAuth((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  if (!hasPermission(user.role, perm)) {
    return (
      <div className="rounded-xl bg-white p-8 text-center shadow-sm">
        <div className="text-4xl">🔒</div>
        <h2 className="mt-2 font-semibold text-slate-700">Sin permisos</h2>
        <p className="text-sm text-slate-400">Tu rol no tiene acceso a esta sección.</p>
      </div>
    );
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/"
              element={
                <Protected>
                  <Layout />
                </Protected>
              }
            >
              <Route index element={<RequirePerm perm="dashboard.read"><Dashboard /></RequirePerm>} />
              <Route path="entregas" element={<RequirePerm perm="deliveries.read"><Deliveries /></RequirePerm>} />
              <Route path="entregas/nueva" element={<RequirePerm perm="deliveries.write"><DeliveryNew /></RequirePerm>} />
              <Route path="entregas/:id" element={<RequirePerm perm="deliveries.read"><DeliveryDetail /></RequirePerm>} />
              <Route path="stock" element={<RequirePerm perm="stock.read"><StockPage /></RequirePerm>} />
              <Route path="productos" element={<RequirePerm perm="products.read"><Products /></RequirePerm>} />
              <Route path="entradas" element={<RequirePerm perm="entries.read"><Entries /></RequirePerm>} />
              <Route path="transferencias" element={<RequirePerm perm="transfers.read"><Transfers /></RequirePerm>} />
              <Route path="inventarios" element={<RequirePerm perm="counts.read"><Counts /></RequirePerm>} />
              <Route path="movimientos" element={<RequirePerm perm="movements.read"><Movements /></RequirePerm>} />
              <Route path="reportes" element={<RequirePerm perm="reports.read"><Reports /></RequirePerm>} />
              <Route path="usuarios" element={<RequirePerm perm="users.manage"><Users /></RequirePerm>} />
              <Route path="ubicaciones" element={<RequirePerm perm="locations.manage"><Locations /></RequirePerm>} />
              <Route path="auditoria" element={<RequirePerm perm="audit.read"><Audit /></RequirePerm>} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ConfirmProvider>
    </ToastProvider>
  );
}
