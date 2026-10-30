import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader, type IBrowserCodeReaderOptions } from '@zxing/browser';
import { DecodeHintType, type Result } from '@zxing/library';
import { Spinner } from './ui';

/**
 * Escáner de códigos de barras optimizado para teléfonos (en especial Android):
 * - Fuerza la cámara trasera en alta resolución (la cámara "por defecto" suele ser
 *   la frontal, o una configuración de videollamada que enfoca de lejos).
 * - Pide foco CONTINUO desde las constraints iniciales (en Chrome/Android si no
 *   se pide así, muchos teléfonos dejan el foco fijo y el código se ve borroso).
 * - Si el dispositivo no soporta modo continuo: disparo pulsos de autofocus.
 * - Tocar la pantalla re-dispara el autofocus (como en la app de cámara nativa).
 * - Slider de foco manual (macro) cuando el hardware lo permite.
 * - Controles de zoom y linterna según capacidad del hardware.
 * - Overlay a pantalla completa con marco guía y línea de barrido.
 */

/* Capacidades opcionales de la pista (no tipadas en todas las versiones de TS) */
interface TrackCaps extends MediaTrackCapabilities {
  zoom?: { min: number; max: number; step: number };
  torch?: boolean;
  focusMode?: string[];
  focusDistance?: { min: number; max: number; step: number };
}

interface ZoomRange { min: number; max: number; step: number }
interface Range3 { min: number; max: number; step: number }

export function CameraScanner({ onScan, onClose, hint = 'Apuntá al código de barras' }: {
  /** Se llama con el texto decodificado. El cooldown antirrebote lo maneja el componente. */
  onScan: (code: string) => void | Promise<void>;
  onClose: () => void;
  hint?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState(''); // '' = cámara trasera (facingMode: environment)
  const [zoomRange, setZoomRange] = useState<ZoomRange | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [torch, setTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  // Foco
  const [hasTapFocus, setHasTapFocus] = useState(false);
  const [fdRange, setFdRange] = useState<Range3 | null>(null);
  const [focusFrac, setFocusFrac] = useState<number | null>(null);
  const [focusModeLive, setFocusModeLive] = useState<string>(''); // 'continuous' | 'manual' | 'single-shot' | ''

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const lastScan = useRef<{ code: string; time: number }>({ code: '', time: 0 });
  const focusPulseRef = useRef<number | null>(null);

  const onScanRef = useRef(onScan);
  useEffect(() => { onScanRef.current = onScan; });

  useEffect(() => {
    let cancelled = false;
    setStarting(true);
    setError(null);
    setZoom(null);
    setZoomRange(null);
    setTorch(false);
    setTorchOn(false);
    setHasTapFocus(false);
    setFdRange(null);
    setFocusFrac(null);
    setFocusModeLive('');

    const open = async () => {
      try {
        const baseVideo = {
          facingMode: { ideal: 'environment' }, // cámara trasera (ésta enfoca de cerca)
          width: { ideal: 1920 },               // alta resolución = barras más definidas
          height: { ideal: 1080 },
        };
        const videoById = deviceId ? { ...baseVideo, deviceId: { exact: deviceId } } : baseVideo;

        let stream: MediaStream;
        try {
          // 1er intento: con foco continuo desde las constraints iniciales
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { ...videoById, advanced: [{ focusMode: 'continuous' }] },
          } as unknown as MediaStreamConstraints);
        } catch {
          // 2do intento: sin advanced (por si el teléfono no lo acepta)
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoById } as unknown as MediaStreamConstraints);
        }
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;

        const track = stream.getVideoTracks()[0];
        const caps: TrackCaps | undefined = track.getCapabilities?.() as TrackCaps | undefined;

        // Re-afirmar foco continuo si la constraint inicial no pegó
        const settings = track.getSettings() as MediaTrackSettings & { focusMode?: string; zoom?: number };
        if (caps?.focusMode?.includes('continuous') && settings.focusMode !== 'continuous') {
          try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as unknown as MediaTrackConstraints); } catch { /* noop */ }
          const again = track.getSettings() as MediaTrackSettings & { focusMode?: string };
          setFocusModeLive(again.focusMode ?? '');
        } else {
          setFocusModeLive(settings.focusMode ?? '');
        }

        // Si el teléfono no reporta modo de foco aplicado pero sí single-shot:
        // pulso de AF cada 3 s (sin esto el foco queda fijo y el código se ve borroso)
        if (!settings.focusMode && caps?.focusMode?.includes('single-shot')) {
          focusPulseRef.current = window.setInterval(() => {
            void (async () => {
              try {
                const tr = streamRef.current?.getVideoTracks()[0];
                if (!tr) return;
                await tr.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] } as unknown as MediaTrackConstraints);
              } catch { /* noop */ }
            })();
          }, 3000);
        }

        // Tocar la pantalla re-enfoca (si el hw lo permite)
        setHasTapFocus(!!caps?.focusMode);

        // Foco manual (macro) cuando el dispositivo soporta focusDistance
        const fd = caps?.focusDistance;
        if (fd && fd.max > 0) {
          setFdRange({ min: fd.min, max: fd.max, step: fd.step || 0.1 });
          setFocusFrac(0.25); // arrancar un poco cerca (Chrome usa dioptrías: mayor = más cerca)
        }

        // Zoom / linterna según hardware
        if (caps?.zoom) {
          setZoomRange({ min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 });
          setZoom(settings.zoom ?? Math.min(caps.zoom.max, caps.zoom.min + (caps.zoom.max - caps.zoom.min) * 0.35));
        }
        if (caps?.torch) setTorch(true);

        // TRY_HARDER: más intentos sobre cuadros grises/borrosos, útil de cerca.
        const hints = new Map<DecodeHintType, unknown>();
        hints.set(DecodeHintType.TRY_HARDER, true);
        const readerOptions: IBrowserCodeReaderOptions = {
          delayBetweenScanAttempts: 120,    // intenta más seguido (default 500 ms)
          delayBetweenScanSuccess: 2000,    // evita re-leer el mismo código
        };
        const reader = new BrowserMultiFormatReader(hints, readerOptions);

        await reader.decodeFromStream(stream, videoRef.current!, (result: Result | undefined, _err, controls) => {
          controlsRef.current = controls as unknown as { stop: () => void };
          if (cancelled || !result) return;
          const code = result.getText().trim();
          if (!code) return;
          const now = Date.now();
          if (code === lastScan.current.code && now - lastScan.current.time < 1500) return;
          lastScan.current = { code, time: now };
          void Promise.resolve(onScanRef.current(code));
        });

        if (cancelled) return;
        setStarting(false);

        // Listamos cámaras para permitir alternar entre ellas.
        try {
          const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
          setDevices(cams.length > 1 ? cams : []);
        } catch { /* sin selector */ }
      } catch (err) {
        if (cancelled) return;
        const e = err as Error;
        setError(
          e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError'
            ? 'No diste permiso para usar la cámara. Habilitalo en el navegador (ícono de candado en la barra de direcciones) y volvé a intentar.'
            : e.name === 'NotFoundError'
              ? 'No se encontró una cámara en este dispositivo.'
              : `No se pudo abrir la cámara: ${e.message || e.name}`,
        );
      }
    };

    void open();

    return () => {
      cancelled = true;
      if (focusPulseRef.current) { clearInterval(focusPulseRef.current); focusPulseRef.current = null; }
      try { controlsRef.current?.stop(); } catch { /* noop */ }
      try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
      controlsRef.current = null;
      streamRef.current = null;
    };
  }, [deviceId]);

  /* ---- Controles de cámara ---- */

  async function applyZoom(value: number) {
    setZoom(value);
    try {
      const track = streamRef.current?.getVideoTracks()[0];
      if (track) await track.applyConstraints({ advanced: [{ zoom: value }] } as unknown as MediaTrackConstraints);
    } catch { /* noop */ }
  }

  async function toggleTorch() {
    const next = !torchOn;
    try {
      const track = streamRef.current?.getVideoTracks()[0];
      if (!track) return;
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setTorchOn(next);
    } catch { /* noop */ }
  }

  function cycleCamera() {
    if (devices.length < 2) return;
    const idx = devices.findIndex((d) => d.deviceId === deviceId);
    setDeviceId(devices[(idx + 1) % devices.length].deviceId);
  }

  /** Tap en la pantalla: re-dispara el autofocus (pulso single-shot) y vuelve a continuo. */
  async function tapFocus() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    // focusFrac activo = foco manual; un tap vuelve a automático y limpia el slider
    if (focusFrac !== null) { setFocusFrac(null); setFocusModeLive(''); }
    try {
      await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] } as unknown as MediaTrackConstraints);
      await new Promise((r) => window.setTimeout(r, 1200)); // dar tiempo al ciclo de AF
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as unknown as MediaTrackConstraints);
      setFocusModeLive('continuous');
    } catch { /* noop */ }
  }

  /** Slider de foco manual. Chrome expone focusDistance en dioptrías (mayor = más cerca). */
  async function applyManualFocus(frac: number) {
    setFocusFrac(frac);
    if (!fdRange) return;
    const value = fdRange.max - frac * (fdRange.max - fdRange.min);
    try {
      const track = streamRef.current?.getVideoTracks()[0];
      if (!track) return;
      await track.applyConstraints({
        advanced: [{ focusMode: 'manual', focusDistance: value }],
      } as unknown as MediaTrackConstraints);
      setFocusModeLive('manual');
    } catch { /* noop */ }
  }

  const zoomFallback = zoomRange ? zoomRange.min + (zoomRange.max - zoomRange.min) * 0.35 : 1;

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black">
      {/* Barra superior */}
      <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] text-white">
        <span className="truncate text-sm font-semibold">{hint}</span>
        <button
          onClick={onClose}
          className="rounded-full bg-white/15 px-3 py-1.5 leading-none active:bg-white/30"
          aria-label="Cerrar escáner"
        >
          ✕
        </button>
      </div>

      {/* Video a pantalla completa + marco guía + tap-to-focus */}
      <div
        className="relative min-h-0 flex-1 touch-none overflow-hidden"
        onClick={() => { if (hasTapFocus) void tapFocus(); }}
      >
        <video ref={videoRef} muted playsInline autoPlay className="absolute inset-0 h-full w-full object-cover" />

        {starting && !error && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/60 text-white">
            <Spinner light size="lg" />
            <span className="text-sm text-white/80">Iniciando cámara…</span>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/85 p-8 text-center text-white">
            <div className="text-4xl">📷</div>
            <p className="max-w-sm text-sm leading-relaxed">{error}</p>
            <div className="flex gap-2">
              <button onClick={onClose} className="rounded-lg bg-white/15 px-4 py-2 text-sm active:bg-white/30">Cerrar</button>
            </div>
          </div>
        )}

        {/* Marco guía: acercar el código hasta llenarlo */}
        {!error && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            style={{ padding: '0 max(1rem, env(safe-area-inset-left))' }}
          >
            <div className="scan-frame relative h-[32%] w-[88%] max-w-xl rounded-2xl border-[3px] border-white/70">
              <div className="absolute -top-2 -left-2 h-6 w-6 rounded-tl-xl border-t-4 border-l-4 border-amber-400" />
              <div className="absolute -top-2 -right-2 h-6 w-6 rounded-tr-xl border-t-4 border-r-4 border-amber-400" />
              <div className="absolute -bottom-2 -left-2 h-6 w-6 rounded-bl-xl border-b-4 border-l-4 border-amber-400" />
              <div className="absolute -bottom-2 -right-2 h-6 w-6 rounded-br-xl border-b-4 border-r-4 border-amber-400" />
              {focusModeLive === 'manual' && (
                <span className="absolute -top-8 left-1/2 -translate-x-1/2 rounded bg-amber-400/85 px-2 py-0.5 text-[11px] font-semibold text-black">
                  Foco manual
                </span>
              )}
            </div>
          </div>
        )}

        {!starting && !error && (
          <p className="pointer-events-none absolute inset-x-0 bottom-2 px-6 text-center text-xs leading-relaxed text-white/90 sm:text-sm">
            Acercá el código hasta que llene el marco
            {hasTapFocus && ' · Tocá la pantalla si se ve borroso'}
          </p>
        )}
      </div>

      {/* Controles inferiores */}
      <div className="flex flex-wrap items-center justify-center gap-3 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 text-white">
        {fdRange && focusFrac !== null && (
          <input
            type="range"
            aria-label="Foco manual"
            min={0}
            max={1}
            step={0.02}
            value={focusFrac}
            onChange={(e) => void applyManualFocus(Number(e.target.value))}
            className="w-40 accent-amber-400"
          />
        )}
        {torch && (
          <button
            onClick={() => void toggleTorch()}
            className={`rounded-full px-4 py-2.5 text-sm active:scale-95 ${torchOn ? 'bg-amber-400 text-black' : 'bg-white/15 text-white'}`}
          >
            🔦 Luz
          </button>
        )}
        <button
          onClick={cycleCamera}
          disabled={devices.length < 2}
          className="rounded-full bg-white/15 px-4 py-2.5 text-sm active:bg-white/30 disabled:opacity-40"
        >
          🔄 Cámara
        </button>
        {zoomRange && (
          <input
            type="range"
            aria-label="Zoom"
            min={zoomRange.min}
            max={zoomRange.max}
            step={zoomRange.step}
            value={zoom ?? zoomFallback}
            onChange={(e) => void applyZoom(Number(e.target.value))}
            className="w-40 accent-amber-400"
          />
        )}
      </div>
    </div>
  );
}
