/** Cliente HTTP del frontend. Adjunta el token, normaliza errores y
 *  reacciona a sesiones vencidas. */

const BASE = (import.meta as { env?: Record<string, string> }).env?.VITE_API_URL ?? '/api';

let token: string | null = localStorage.getItem('robles_token');

export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem('robles_token', t);
  else localStorage.removeItem('robles_token');
}

export function getToken() {
  return token;
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
}

export async function api<T = unknown>(path: string, options: Options = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  let json: { error?: string; details?: unknown } & Record<string, unknown> = {} as never;
  try {
    json = await res.json();
  } catch {
    /* respuesta sin cuerpo */
  }

  if (res.status === 401) {
    setToken(null);
    // Guarda el motivo (inactividad, expulsada por admin, vencida…) para mostrarlo en el login
    try { sessionStorage.setItem('robles_logout_reason', (json.error as string) ?? 'Sesión cerrada'); } catch { /* noop */ }
    onUnauthorized();
    throw new ApiError(401, (json.error as string) ?? 'Sesión vencida. Volvé a ingresar.');
  }

  if (!res.ok) {
    throw new ApiError(res.status, (json.error as string) ?? `Error ${res.status}`, json.details);
  }
  return json as T;
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}
