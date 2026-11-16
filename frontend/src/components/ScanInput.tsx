import { useEffect, useRef, useState } from 'react';
import { CameraScanner } from './CameraScanner';
import { Button, Input } from './ui';

/** Campo de captura para lectores USB y búsqueda manual desde móviles. */
export function ScanInput({ onScan, onValueChange, placeholder, autoFocus = false, compact = false }: {
  onScan: (code: string) => void | Promise<void>;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const [value, setValue] = useState('');
  const [camera, setCamera] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastScan = useRef<{ code: string; time: number }>({ code: '', time: 0 });

  function handleChange(next: string) {
    setValue(next);
    onValueChange?.(next);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    const code = value.trim();
    if (!code) return;
    const now = Date.now();
    if (code === lastScan.current.code && now - lastScan.current.time < 800) return;
    lastScan.current = { code, time: now };
    void Promise.resolve(onScan(code));
  }

  useEffect(() => {
    if (!camera && autoFocus) inputRef.current?.focus();
  }, [camera, autoFocus]);

  return (
    <div>
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? 'Escanear o escribir código…'}
          autoFocus={autoFocus}
          autoComplete="off"
          inputMode="search"
          enterKeyHint="search"
          className={compact ? '' : 'py-2.5 text-base'}
        />
        <Button
          variant={camera ? 'danger' : 'secondary'}
          onClick={() => setCamera((v) => !v)}
          title="Escanear con cámara"
          type="button"
        >
          {camera ? '⏹' : '📷'}
        </Button>
      </div>
      {camera && (
        <CameraScanner
          hint="Escanear código"
          onScan={(code) => { void Promise.resolve(onScan(code)); }}
          onClose={() => setCamera(false)}
        />
      )}
    </div>
  );
}
