import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { ROLE_LABEL, type Permission } from '../lib/permissions';
import { api } from '../lib/api';
import { Modal, Button, Field, Input } from './ui';
import { useToast } from './Toast';
import { useSyncExternalStore } from 'react';
import { getGpsState, subscribe as subscribeGps, maybeResume, pollSchedule } from '../lib/gpsShare';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  perm: Permission;
  /** Muestra contador de pendientes (endpoint /alerts/pending-count). */
  badge?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: '📊', perm: 'dashboard.read' },
  { to: '/entregas', label: 'Entregas', icon: '📦', perm: 'deliveries.read' },
  { to: '/reservas', label: 'Reservas / Retiros', icon: '📋', perm: 'deliveries.read' },
  { to: '/stock', label: 'Stock', icon: '🏷️', perm: 'stock.read' },
  { to: '/productos', label: 'Productos', icon: '🧴', perm: 'products.read' },
  { to: '/proveedores', label: 'Proveedores', icon: '🏭', perm: 'suppliers.manage' },
  { to: '/entradas', label: 'Entradas', icon: '📥', perm: 'entries.read' },
  { to: '/transferencias', label: 'Transferencias', icon: '🚚', perm: 'transfers.read' },
  { to: '/repartos', label: 'Repartos', icon: '🗺️', perm: 'tracking.read' },
  { to: '/mi-reparto', label: 'Mi Reparto', icon: '🚛', perm: 'tracking.gps' },
  { to: '/entregas-atrasos', label: 'Atrasos', icon: '⏱️', perm: 'tracking.read' },
  { to: '/inventarios', label: 'Inventarios', icon: '📋', perm: 'counts.read' },
  { to: '/movimientos', label: 'Movimientos', icon: '📜', perm: 'movements.read' },
  { to: '/reportes', label: 'Reportes', icon: '📈', perm: 'reports.read' },
  { to: '/alertas', label: 'Alertas', icon: '🛎️', perm: 'alerts.read', badge: true },
  { to: '/aprobaciones', label: 'Aprobaciones', icon: '✅', perm: 'approvals.read' },
  { to: '/usuarios', label: 'Usuarios', icon: '👤', perm: 'users.manage' },
  { to: '/ubicaciones', label: 'Ubicaciones', icon: '🏪', perm: 'locations.manage' },
  { to: '/auditoria', label: 'Auditoría', icon: '🛡️', perm: 'audit.read' },
  { to: '/reglas', label: 'Reglas de negocio', icon: '📏', perm: 'audit.read' },
  { to: '/reconciliacion', label: 'Reconciliación', icon: '🧮', perm: 'audit.read' },
  { to: '/config/confirmaciones', label: 'Confirmaciones / Segregación', icon: '🔐', perm: 'settings.write' },
  { to: '/permisos-ubicacion', label: 'Permisos por ubicación', icon: '🔑', perm: 'users.manage' },
];

export function Layout() {
  const { user, can, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();

  // ===== Chip de GPS compartido persistente =====
  // Se reanuda después de recargar la página (flag en localStorage) hasta
  // que el usuario cierre sesión. useSyncExternalStore para reflejar el
  // estado del singleton (que vive fuera de React).
  const gps = useSyncExternalStore(subscribeGps, getGpsState);
  useEffect(() => {
    if (!user) return;
    void maybeResume(can('tracking.gps'));
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (gps.state === 'off' || gps.state === 'error') return;
    const t = window.setInterval(() => void pollSchedule(), 60000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gps.state]);

  useEffect(() => { setOpen(false); }, [location.pathname]);

  // ===== Badge de alertas pendientes =====
  // Se refresca al cambiar de página; silencioso si el endpoint o el permiso
  // no están disponibles.
  const [alertsCount, setAlertsCount] = useState(0);
  useEffect(() => {
    if (!can('alerts.read')) { setAlertsCount(0); return; }
    let cancelled = false;
    api<{ count: number }>('/alerts/pending-count')
      .then((r) => { if (!cancelled) setAlertsCount(r.count ?? 0); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, user?.id]);

  // ===== Cierre automático por inactividad =====
  useEffect(() => {
    let idleTimer: number | undefined;
    let cancelled = false;

    api<{ idleMinutes: number }>('/auth/config')
      .then(({ idleMinutes }) => {
        if (cancelled || !idleMinutes || idleMinutes <= 0) return;
        const IDLE_MS = idleMinutes * 60 * 1000;
        const reset = () => {
          window.clearTimeout(idleTimer);
          idleTimer = window.setTimeout(() => {
            sessionStorage.setItem('robles_logout_reason', 'Sesión cerrada por inactividad');
            api('/auth/logout', { method: 'POST' }).catch(() => {});
            logout();
            navigate('/login');
          }, IDLE_MS);
        };
        const events = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'];
        events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
        reset();
        return () => {
          events.forEach((e) => window.removeEventListener(e, reset));
          window.clearTimeout(idleTimer);
        };
      })
      .catch(() => {});

    return () => { cancelled = true; window.clearTimeout(idleTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = NAV.filter((n) => can(n.perm));

  const gpsVisible = gps.state === 'active' || gps.state === 'paused' || gps.state === 'starting';

  async function changePassword(current: string, next: string) {
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      toast.success('Contraseña actualizada');
      setPwOpen(false);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function doLogout() {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* sesión ya cerrada */ }
    logout();
    navigate('/login');
  }

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside
        className={`no-print fixed inset-y-0 left-0 z-40 flex w-60 flex-col bg-brand-900 text-white transition-transform lg:static lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-3 px-4 py-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-700 text-lg font-black text-amber-400">
            R
          </div>
          <div>
            <div className="font-bold leading-tight">Robles</div>
            <div className="text-xs text-brand-300">Pinturerías · Stock</div>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  isActive ? 'bg-brand-600 font-semibold text-white' : 'text-brand-100 hover:bg-brand-800'
                }`
              }
            >
              <span className="w-5 text-center text-base">{item.icon}</span>
              <span className="flex-1">{item.label}</span>
              {item.badge && alertsCount > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400 px-1.5 text-[11px] font-bold text-brand-900">
                  {alertsCount > 99 ? '99+' : alertsCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-brand-800 px-4 py-3 text-xs text-brand-300">
          <div className="font-semibold text-brand-100">{user?.fullName}</div>
          <div>{user ? ROLE_LABEL[user.role] : ''}</div>
          {gpsVisible && (
            <div className="mt-1.5 flex items-center gap-1.5 rounded-md bg-brand-800 px-2 py-1.5">
              <span className="relative flex h-2 w-2">
                <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${gps.state === 'paused' ? 'animate-pulse bg-amber-400' : 'animate-ping bg-emerald-400'}`} />
                <span className={`relative inline-flex h-2 w-2 rounded-full ${gps.state === 'paused' ? 'bg-amber-400' : 'bg-emerald-400'}`} />
              </span>
              <span className="flex-1 leading-tight text-brand-100">
                {gps.state === 'paused' ? 'GPS pausado (horario)' : 'GPS compartido'}
              </span>
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <button className="rounded px-2 py-1 hover:bg-brand-800 hover:text-white" onClick={() => setPwOpen(true)}>
              Cambiar clave
            </button>
            <button
              className="rounded px-2 py-1 hover:bg-brand-800 hover:text-white"
              onClick={doLogout}
            >
              Salir
            </button>
          </div>
        </div>
      </aside>

      {open && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setOpen(false)} />}

      {/* Contenido */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
          <button className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" onClick={() => setOpen(true)}>☰</button>
          <span className="font-bold text-brand-800">Robles Stock</span>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] lg:p-6">
          <Outlet />
        </main>
      </div>

      <ChangePasswordModal open={pwOpen} onClose={() => setPwOpen(false)} onSubmit={changePassword} />
    </div>
  );
}

function ChangePasswordModal({ open, onClose, onSubmit }: {
  open: boolean; onClose: () => void; onSubmit: (current: string, next: string) => Promise<void>;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (next.length < 6) return alert('La nueva contraseña debe tener al menos 6 caracteres');
    if (next !== next2) return alert('Las contraseñas nuevas no coinciden');
    setLoading(true);
    await onSubmit(current, next);
    setLoading(false);
    setCurrent(''); setNext(''); setNext2('');
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cambiar mi contraseña"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button loading={loading} onClick={submit}>Guardar</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Contraseña actual" required>
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label="Nueva contraseña" required hint="Mínimo 6 caracteres">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Repetir nueva contraseña" required>
          <Input type="password" value={next2} onChange={(e) => setNext2(e.target.value)} autoComplete="new-password" />
        </Field>
      </div>
    </Modal>
  );
}
