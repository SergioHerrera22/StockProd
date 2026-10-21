import { useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { Button, Input } from '../components/ui';

export default function Login() {
  const { user, login, loading, error } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [logoutReason, setLogoutReason] = useState<string | null>(null);

  useEffect(() => {
    const reason = sessionStorage.getItem('robles_logout_reason');
    if (reason) {
      setLogoutReason(reason);
      sessionStorage.removeItem('robles_logout_reason');
    }
  }, []);

  if (user) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await login(username.trim(), password);
    } catch {
      /* el store ya captura el error */
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-brand-900 via-brand-800 to-brand-950 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-700 text-3xl font-black text-amber-400 shadow-lg">
            R
          </div>
          <h1 className="text-2xl font-bold text-white">Robles Pinturerías</h1>
          <p className="text-sm text-brand-300">Sistema Integral de Stock</p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-2xl bg-white p-6 shadow-xl">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Usuario</label>
            <Input
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Tu usuario"
              autoComplete="username"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Contraseña</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>

          {logoutReason && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
              {logoutReason}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </div>
          )}

          <Button type="submit" className="w-full" size="lg" loading={loading}>
            Ingresar
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-brand-400">
          Acceso exclusivo para personal de Robles Pinturerías
        </p>
      </div>
    </div>
  );
}
