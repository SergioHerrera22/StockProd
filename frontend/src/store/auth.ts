import { create } from 'zustand';
import { api, getToken, setToken, setUnauthorizedHandler } from '../lib/api';
import { hasPermission, type Role, type Permission } from '../lib/permissions';
import { stopForLogout, clearSharePersistence } from '../lib/gpsShare';

export interface AuthUser {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  locationId: number | null;
  permissions?: Permission[] | null;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  authReady: boolean;
  error: string | null;
  refreshUser: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  can: (permission: Permission) => boolean;
}

export const useAuth = create<AuthState>((set, get) => {
  // Restaurar sesión previa
  const savedUser = localStorage.getItem('robles_user');
  const initialUser: AuthUser | null = savedUser ? JSON.parse(savedUser) : null;

  setUnauthorizedHandler(() => {
    stopForLogout(); // se corta el compartido GPS sin llamar al server (sin token)
    set({ user: null, authReady: true });
    localStorage.removeItem('robles_user');
    window.location.hash = '';
    window.location.href = '/login';
  });

  return {
    user: initialUser,
    loading: false,
    authReady: false,
    error: null,
    refreshUser: async () => {
      if (!getToken()) {
        localStorage.removeItem('robles_user');
        set({ user: null, authReady: true });
        return;
      }
      try {
        const res = await api<{ user: AuthUser }>('/auth/me');
        localStorage.setItem('robles_user', JSON.stringify(res.user));
        set({ user: res.user, authReady: true });
      } catch {
        // Si falla la validación inicial, no concedemos acceso usando permisos cacheados.
        set({ user: null, authReady: true });
        localStorage.removeItem('robles_user');
      }
    },

    login: async (username, password) => {
      set({ loading: true, error: null });
      try {
        const res = await api<{ token: string; user: AuthUser }>('/auth/login', {
          method: 'POST',
          body: { username, password },
        });
        setToken(res.token);
        localStorage.setItem('robles_user', JSON.stringify(res.user));
        clearSharePersistence();
        set({ user: res.user, loading: false, authReady: true });
      } catch (err) {
        set({ loading: false, error: (err as Error).message });
        throw err;
      }
    },

    logout: () => {
      // El compartido GPS dura hasta cerrar la sesión: cortarlo acá en frío
      // (sin esperar la request; el flag de localStorage se borra igual).
      stopForLogout();
      void api('/tracking/share/stop', { method: 'POST' }).catch(() => {});
      setToken(null);
      localStorage.removeItem('robles_user');
      set({ user: null, authReady: true });
    },

    can: (permission) => hasPermission(get().user?.role, permission, get().user?.permissions),
  };
});
