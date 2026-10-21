import { create } from 'zustand';
import { api, setToken, setUnauthorizedHandler } from '../lib/api';
import { hasPermission, type Role, type Permission } from '../lib/permissions';

export interface AuthUser {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  locationId: number | null;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  can: (permission: Permission) => boolean;
}

export const useAuth = create<AuthState>((set, get) => {
  // Restaurar sesión previa
  const savedUser = localStorage.getItem('robles_user');
  const initialUser: AuthUser | null = savedUser ? JSON.parse(savedUser) : null;

  setUnauthorizedHandler(() => {
    set({ user: null });
    localStorage.removeItem('robles_user');
    window.location.hash = '';
    window.location.href = '/login';
  });

  return {
    user: initialUser,
    loading: false,
    error: null,

    login: async (username, password) => {
      set({ loading: true, error: null });
      try {
        const res = await api<{ token: string; user: AuthUser }>('/auth/login', {
          method: 'POST',
          body: { username, password },
        });
        setToken(res.token);
        localStorage.setItem('robles_user', JSON.stringify(res.user));
        set({ user: res.user, loading: false });
      } catch (err) {
        set({ loading: false, error: (err as Error).message });
        throw err;
      }
    },

    logout: () => {
      setToken(null);
      localStorage.removeItem('robles_user');
      set({ user: null });
    },

    can: (permission) => hasPermission(get().user?.role, permission),
  };
});
