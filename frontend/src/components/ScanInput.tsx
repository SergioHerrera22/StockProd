import { useEffect, useRef, useState } from 'react';
import { CameraScanner } from './CameraScanner';
import { Button, Input } from './ui';

/**
 * Campo de captura optimizado para lectores de códigos USB:
 * el lector "escribe" el código y dispara Enter. También soporta
 * cámara (teléfono/tablet) con foco continuo, zoom y linterna.
 */
export function ScanInput({ onScan, placeholder, autoFocus = false, compact = false }: {
  onScan: (code: string) => void | Promise<void>;
  placeholder?: string;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const [value, setValue] = useState('');
  const [camera, setCamera] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastScan = useRef<{ code: string; time: number }>({ code: '', time: 0 });

  // Lector USB: Enter al final de la cadena
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = value.trim();
      if (!code) return;
      const now = Date.now();
      if (code === lastScan.current.code && now - lastScan.current.time < 800) {
        setValue('');
        return; // ignora doble disparo del mismo lector
      }
      lastScan.current = { code, time: now };
      void Promise.resolve(onScan(code)).finally(() => setValue(''));
    }
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
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? 'Escanear o escribir código…'}
          autoFocus={autoFocus}
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
