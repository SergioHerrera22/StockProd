import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type ToastType = 'success' | 'error' | 'warn' | 'info';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  warn: (message: string) => void;
  info: (message: string) => void;
}

// Nuevo: interfaz para notificaciones con sonido
interface NotificationOptions {
  sound?: boolean;
  title?: string;
  body?: string;
}

const ToastCtx = createContext<ToastApi>({ success: () => {}, error: () => {}, warn: () => {}, info: () => {} });

const STYLES: Record<ToastType, { icon: string; cls: string }> = {
  success: { icon: '✔', cls: 'border-l-emerald-500' },
  error: { icon: '✖', cls: 'border-l-red-500' },
  warn: { icon: '⚠', cls: 'border-l-amber-500' },
  info: { icon: 'ℹ', cls: 'border-l-blue-500' },
};

/** Genera un breve "beep" usando la Web Audio API del navegador */
function playBeep(frequency: number = 440, duration: number = 300): void {
  try {
    // Si ya existe un contexto, reutilízalo; de lo contrario, crear uno nuevo
    let ctx: AudioContext | null = null;
    // Intentar obtener contexto existente o crear uno nuevo
    if ((window as any)._beepContext) {
      ctx = (window as any)._beepContext;
    } else {
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      (window as any)._beepContext = ctx;
    }

    // Crear oscilador
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    // Atacar y liberar
    gainNode.gain.value = 0.3;
    oscillator.start();
    setTimeout(() => {
      oscillator.stop();
    }, duration);
    setTimeout(() => {
      gainNode.disconnect();
    }, duration + 100);
  } catch (e) {
    // Silenciosamente ignorar errores de audio (contexto ya cerrado, permisos, etc.)
    console.debug('Beep skipped:', e);
  }
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const push = useCallback((type: ToastType, message: string, options?: { sound?: boolean }) => {
    const id = ++counter.current;
    setToasts((prev) => [...prev.slice(-4), { id, type, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, type === 'error' ? 6000 : 4000);

    // Emitir sonido si está habilitado y el usuario lo tiene activado
    if (options?.sound !== false) {
      // Pequeño delay para asegurar que el DOM esté listo
      setTimeout(() => playBeep(600, 200), 50);
    }
  }, []);

  const api: ToastApi = {
    success: (m) => push('success', m),
    error: (m) => push('error', m),
    warn: (m) => push('warn', m),
    info: (m) => push('info', m),
  };

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2 rounded-lg border border-slate-200 border-l-4 bg-white p-3 shadow-lg ${STYLES[t.type].cls}`}
          >
            <span>{STYLES[t.type].icon}</span>
            <span className="flex-1 text-sm text-slate-700">{t.message}</span>
            <button
              className="text-slate-300 hover:text-slate-500"
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}