import {
  createContext, forwardRef, useContext, useEffect, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';

/* ============ Botón ============ */
type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success' | 'warning';

const btnStyles: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 hover:bg-brand-700 text-white shadow-sm',
  secondary: 'bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 shadow-sm',
  danger: 'bg-red-600 hover:bg-red-700 text-white shadow-sm',
  success: 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm',
  warning: 'bg-amber-500 hover:bg-amber-600 text-white shadow-sm',
  ghost: 'bg-transparent hover:bg-slate-200/70 text-slate-600',
};

export function Button({
  variant = 'primary', size = 'md', loading = false, children, className = '', disabled, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant; size?: 'sm' | 'md' | 'lg'; loading?: boolean;
}) {
  const sizes = { sm: 'px-2.5 py-1.5 text-xs', md: 'px-4 py-2 text-sm', lg: 'px-5 py-2.5 text-base' };
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors
        focus:outline-none focus:ring-2 focus:ring-brand-400 focus:ring-offset-1
        disabled:opacity-50 disabled:cursor-not-allowed ${btnStyles[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner size="sm" light />}
      {children}
    </button>
  );
}

/* ============ Inputs ============ */
const inputCls = `w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base sm:text-sm
  placeholder:text-slate-400 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200
  disabled:bg-slate-100 disabled:text-slate-500`;

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input(props, ref) {
    return <input ref={ref} {...props} className={`${inputCls} ${props.className ?? ''}`} />;
  }
);

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} ${props.className ?? ''}`} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputCls} ${props.className ?? ''}`} />;
}

export function Field({ label, hint, required, children, className = '' }: {
  label: string; hint?: string; required?: boolean; children: ReactNode; className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

/* ============ Card / Panel ============ */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl bg-white shadow-sm border border-slate-200 ${className}`}>{children}</div>;
}

export function CardHeader({ title, actions, subtitle }: { title: ReactNode; actions?: ReactNode; subtitle?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
      <div>
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

/* ============ Badge ============ */
type BadgeColor = 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'violet';
const badgeStyles: Record<BadgeColor, string> = {
  gray: 'bg-slate-100 text-slate-600 ring-slate-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  amber: 'bg-amber-50 text-amber-700 ring-amber-200',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
};

export function Badge({ color = 'gray', children, className = '' }: {
  color?: BadgeColor; children: ReactNode; className?: string;
}) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${badgeStyles[color]} ${className}`}>
      {children}
    </span>
  );
}

/* ============ Spinner ============ */
export function Spinner({ size = 'md', light = false }: { size?: 'sm' | 'md' | 'lg'; light?: boolean }) {
  const sizes = { sm: 'h-3.5 w-3.5', md: 'h-5 w-5', lg: 'h-8 w-8' };
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-solid border-current border-r-transparent ${sizes[size]} ${light ? 'text-white' : 'text-brand-600'}`}
      role="status"
    />
  );
}

/* ============ Estados vacíos y carga ============ */
export function EmptyState({ icon = '📦', title, hint, action }: {
  icon?: string; title: string; hint?: string; action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="text-4xl">{icon}</div>
      <p className="font-medium text-slate-600">{title}</p>
      {hint && <p className="max-w-sm text-sm text-slate-400">{hint}</p>}
      {action}
    </div>
  );
}

export function Loading({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 px-6 py-14 text-slate-400">
      <Spinner size="lg" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

/* ============ Encabezado de página ============ */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-slate-800">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ============ Tarjeta de indicador ============ */
export function StatCard({ label, value, hint, icon, tone = 'default', onClick }: {
  label: string; value: ReactNode; hint?: string; icon?: string;
  tone?: 'default' | 'warn' | 'danger' | 'good' | 'info'; onClick?: () => void;
}) {
  const tones: Record<string, string> = {
    default: 'text-brand-700',
    warn: 'text-amber-600',
    danger: 'text-red-600',
    good: 'text-emerald-600',
    info: 'text-slate-700',
  };
  return (
    <Card
      className={`p-4 ${onClick ? 'cursor-pointer transition-shadow hover:shadow-md' : ''}`}
    >
      <div onClick={onClick}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</span>
          {icon && <span className="text-xl">{icon}</span>}
        </div>
        <div className={`mt-1 text-2xl font-bold ${tones[tone]}`}>{value}</div>
        {hint && <div className="mt-0.5 text-xs text-slate-400">{hint}</div>}
      </div>
    </Card>
  );
}

/* ============ Modal ============ */
export function Modal({ open, onClose, title, children, footer, width = 'md' }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode;
  footer?: ReactNode; width?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    if (open) window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;
  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl' };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:p-8" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`w-full ${widths[width]} rounded-xl bg-white shadow-2xl`}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h3 className="font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Cerrar">✕</button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/* ============ Diálogo de confirmación ============ */
interface ConfirmState {
  title: string;
  message: string;
  danger?: boolean;
  confirmLabel?: string;
  onConfirm: () => void;
}

const ConfirmCtx = createContext<(c: ConfirmState) => void>(() => {});

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);
  const [busy, setBusy] = useState(false);
  // Guard de doble click: confirmaciones pesadas (anular/aplicar stock) son
  // async; sin este guard, dos clicks lanzaban dos veces la misma operación
  // sobre un documento ya cambiado de estado.
  const handleConfirm = async () => {
    if (!state || busy) return;
    setBusy(true);
    try { await state.onConfirm(); } finally { setBusy(false); setState(null); }
  };
  return (
    <ConfirmCtx.Provider value={setState}>
      {children}
      <Modal
        open={!!state}
        onClose={() => { if (!busy) setState(null); }}
        title={state?.title ?? ''}
        width="sm"
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setState(null)}>Cancelar</Button>
            <Button
              variant={state?.danger ? 'danger' : 'primary'}
              loading={busy}
              onClick={handleConfirm}
            >
              {state?.confirmLabel ?? 'Confirmar'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">{state?.message}</p>
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmCtx);
}

/* ============ Tabs ============ */
export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: { key: T; label: string; badge?: number }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-lg bg-slate-200/60 p-1">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            value === t.key ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          {t.label}
          {t.badge !== undefined && t.badge > 0 && (
            <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-700">{t.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ============ Fila de formulario ============ */
export function FormRow({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 }) {
  const gridCols = { 1: 'grid-cols-1', 2: 'grid-cols-1 sm:grid-cols-2', 3: 'grid-cols-1 sm:grid-cols-3' };
  return <div className={`grid gap-3 ${gridCols[cols]}`}>{children}</div>;
}
