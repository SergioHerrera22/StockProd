import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { Button, Input } from './ui';

/**
 * Campo de captura optimizado para lectores de códigos USB:
 * el lector "escribe" el código y dispara Enter. También soporta
 * cámara (teléfono/tablet) mediante @zxing/browser.
 */
export function ScanInput({ onScan, placeholder, autoFocus = false, compact = false }: {
  onScan: (code: string) => void | Promise<void>;
  placeholder?: string;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const [value, setValue] = useState('');
  const [camera, setCamera] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
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

  // Cámara
  useEffect(() => {
    if (!camera) return;
    const reader = new BrowserMultiFormatReader();
    let controls: { stop: () => void } | null = null;
    let cancelled = false;

    reader
      .decodeFromVideoDevice(undefined, videoRef.current!, (result, err, ctrl) => {
        controls = ctrl as unknown as { stop: () => void };
        if (result && !cancelled) {
          const code = result.getText();
          const now = Date.now();
          if (code === lastScan.current.code && now - lastScan.current.time < 1500) return;
          lastScan.current = { code, time: now };
          void Promise.resolve(onScan(code));
        }
      })
      .then((ctrl) => { controls = ctrl as unknown as { stop: () => void }; })
      .catch(() => setCameraError('No se pudo abrir la cámara. Revisá permisos del navegador.'));

    return () => {
      cancelled = true;
      try { controls?.stop(); } catch { /* noop */ }
    };
  }, [camera, onScan]);

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
          onClick={() => { setCameraError(null); setCamera((v) => !v); }}
          title="Escanear con cámara"
        >
          {camera ? '⏹' : '📷'}
        </Button>
      </div>
      {camera && (
        <div className="mt-2 overflow-hidden rounded-lg border border-slate-200">
          <video ref={videoRef} className="w-full" style={{ maxHeight: 260 }} muted playsInline />
        </div>
      )}
      {cameraError && <p className="mt-1 text-xs text-red-500">{cameraError}</p>}
    </div>
  );
}
