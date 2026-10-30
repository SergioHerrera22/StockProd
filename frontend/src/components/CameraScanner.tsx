import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader, type IBrowserCodeReaderOptions } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType, type Result } from '@zxing/library';
import { Spinner } from './ui';

interface TrackCaps extends MediaTrackCapabilities {
  zoom?: { min: number; max: number; step: number };
  torch?: boolean;
  focusMode?: string[];
}

interface ZoomRange { min: number; max: number; step: number }

/**
 * Escáner de códigos para Android y escritorio.
 *
 * Criterios:
 * - Solicita la cámara trasera y resolución HD/FHD sin imponer una resolución
 *   obligatoria que pueda dejar fuera cámaras Android más antiguas.
 * - No aplica zoom digital automáticamente: puede reducir el detalle de las barras.
 * - Prioriza autofocus continuo cuando el dispositivo lo soporta.
 * - Decodifica formatos habituales de productos y limita el trabajo por fotograma.
 * - Evita lecturas repetidas mientras el mismo código permanece delante de la cámara.
 */
export function CameraScanner({ onScan, onClose, hint = 'Apuntá al código de barras' }: {
  onScan: (code: string) => void | Promise<void>;
  onClose: () => void;
  hint?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [zoomRange, setZoomRange] = useState<ZoomRange | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [torch, setTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [focusModeLive, setFocusModeLive] = useState('');
  const [resolutionLabel, setResolutionLabel] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const lastScan = useRef<{ code: string; time: number }>({ code: '', time: 0 });
  const focusPulseRef = useRef<number | null>(null);
  const onScanRef = useRef(onScan);

  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  useEffect(() => {
    let cancelled = false;
    setStarting(true);
    setError(null);
    setZoom(null);
    setZoomRange(null);
    setTorch(false);
    setTorchOn(false);
    setFocusModeLive('');
    setResolutionLabel('');
    lastScan.current = { code: '', time: 0 };

    const stopStream = () => {
      try { controlsRef.current?.stop(); } catch { /* noop */ }
      try { streamRef.current?.getTracks().forEach((track) => track.stop()); } catch { /* noop */ }
      controlsRef.current = null;
      streamRef.current = null;
    };

    const open = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Este navegador no permite usar la cámara. Abrí StockProd desde Chrome y mediante HTTPS.');
        }

        // Ideal, no exact: Android elige la mejor combinación que soporte el hardware.
        // 1920x1080 conserva detalle para EAN/Code128; el límite de 30 fps evita
        // solicitar una captura innecesariamente exigente en teléfonos modestos.
        const cameraConstraints: MediaTrackConstraints = {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, max: 30 },
        };

        let stream: MediaStream;
        if (deviceId) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: { ...cameraConstraints, deviceId: { exact: deviceId } },
            });
          } catch {
            // Un deviceId puede quedar obsoleto después de cambiar permisos/cámaras.
            stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: cameraConstraints });
          }
        } else {
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: cameraConstraints });
        }

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;

        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error('El dispositivo no entregó una pista de video.');

        // Señala al navegador que el contenido requiere detalle fino (si lo soporta).
        try { track.contentHint = 'detail'; } catch { /* no soportado */ }

        const caps = track.getCapabilities?.() as TrackCaps | undefined;

        // Autofocus: primero continuo. Si no existe, usar single-shot periódico.
        if (caps?.focusMode?.includes('continuous')) {
          try {
            await track.applyConstraints({
              advanced: [{ focusMode: 'continuous' } as unknown as MediaTrackConstraintSet],
            });
          } catch { /* el navegador puede anunciar y no implementar la capacidad */ }
        }

        let settings = track.getSettings() as MediaTrackSettings & {
          focusMode?: string;
          zoom?: number;
        };
        setFocusModeLive(settings.focusMode ?? '');
        if (settings.width && settings.height) {
          setResolutionLabel(`${settings.width} × ${settings.height}`);
        }

        if (caps?.focusMode?.includes('single-shot') && settings.focusMode !== 'continuous') {
          focusPulseRef.current = window.setInterval(() => {
            const activeTrack = streamRef.current?.getVideoTracks()[0];
            if (!activeTrack || cancelled) return;
            void activeTrack.applyConstraints({
              advanced: [{ focusMode: 'single-shot' } as unknown as MediaTrackConstraintSet],
            }).catch(() => undefined);
          }, 2500);
        }

        if (caps?.zoom) {
          setZoomRange({
            min: caps.zoom.min,
            max: caps.zoom.max,
            step: caps.zoom.step || 0.1,
          });
          // No iniciar con zoom digital: se mantiene el campo visual y la nitidez original.
          setZoom(settings.zoom ?? caps.zoom.min);
        }
        if (caps?.torch) setTorch(true);

        const hints = new Map<DecodeHintType, unknown>();
        hints.set(DecodeHintType.TRY_HARDER, true);
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8,
          BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E,
          BarcodeFormat.CODE_128,
          BarcodeFormat.CODE_39,
          BarcodeFormat.ITF,
          BarcodeFormat.CODABAR,
        ]);

        const readerOptions: IBrowserCodeReaderOptions = {
          // 200 ms equivale a ~5 intentos/s: suficiente para un código quieto,
          // con menos carga térmica/CPU que intentar decodificar cada 120 ms.
          delayBetweenScanAttempts: 200,
          delayBetweenScanSuccess: 700,
        };
        const reader = new BrowserMultiFormatReader(hints, readerOptions);
        const video = videoRef.current;
        if (!video) throw new Error('No se pudo inicializar la vista previa de la cámara.');

        await reader.decodeFromStream(stream, video, (result: Result | undefined, _decodeError, controls) => {
          if (controls) controlsRef.current = controls as unknown as { stop: () => void };
          if (cancelled) return;
          const now = Date.now();

          if (!result) {
            // ZXing informa intentos sin lectura. Si el código dejó de estar
            // visible durante 900 ms, habilitamos volver a escanear el mismo.
            if (now - lastScan.current.time > 900) {
              lastScan.current = { code: '', time: 0 };
            }
            return;
          }

          const code = result.getText().trim();
          if (!code) return;

          if (code === lastScan.current.code) {
            // Mientras el mismo código siga en cuadro, no repetir la operación.
            lastScan.current.time = now;
            return;
          }

          lastScan.current = { code, time: now };
          void Promise.resolve(onScanRef.current(code)).catch(() => {
            // El formulario que consume el código gestiona y muestra su propio error.
          });
        });

        if (cancelled) return;
        setStarting(false);

        try {
          const cams = (await navigator.mediaDevices.enumerateDevices())
            .filter((device) => device.kind === 'videoinput');
          if (!cancelled) setDevices(cams.length > 1 ? cams : []);
        } catch { /* el selector de cámara es opcional */ }
      } catch (err) {
        if (cancelled) return;
        stopStream();
        const e = err as Error;
        setError(
          e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError'
            ? 'No diste permiso para usar la cámara. Habilitalo en Chrome (ícono de candado) y volvé a intentar.'
            : e.name === 'NotFoundError' || e.name === 'OverconstrainedError'
              ? 'No se encontró una cámara compatible. Probá cambiar de cámara o revisar los permisos.'
              : `No se pudo abrir la cámara: ${e.message || e.name}`,
        );
      }
    };

    void open();

    return () => {
      cancelled = true;
      if (focusPulseRef.current !== null) {
        window.clearInterval(focusPulseRef.current);
        focusPulseRef.current = null;
      }
      stopStream();
    };
  }, [deviceId]);

  async function applyZoom(value: number) {
    setZoom(value);
    try {
      const track = streamRef.current?.getVideoTracks()[0];
      if (track) {
        await track.applyConstraints({
          advanced: [{ zoom: value } as unknown as MediaTrackConstraintSet],
        });
      }
    } catch { /* zoom no soportado o rechazado */ }
  }

  async function toggleTorch() {
    const next = !torchOn;
    try {
      const track = streamRef.current?.getVideoTracks()[0];
      if (!track) return;
      await track.applyConstraints({
        advanced: [{ torch: next } as unknown as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch { /* linterna no soportada o rechazada */ }
  }

  function cycleCamera() {
    if (devices.length < 2) return;
    const currentIndex = devices.findIndex((device) => device.deviceId === deviceId);
    setDeviceId(devices[(currentIndex + 1) % devices.length].deviceId);
  }

  async function tapFocus() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      const caps = track.getCapabilities?.() as TrackCaps | undefined;
      if (caps?.focusMode?.includes('single-shot')) {
        await track.applyConstraints({
          advanced: [{ focusMode: 'single-shot' } as unknown as MediaTrackConstraintSet],
        });
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        if (caps.focusMode.includes('continuous')) {
          await track.applyConstraints({
            advanced: [{ focusMode: 'continuous' } as unknown as MediaTrackConstraintSet],
          });
        }
        const settings = track.getSettings() as MediaTrackSettings & { focusMode?: string };
        setFocusModeLive(settings.focusMode ?? '');
      }
    } catch { /* autofocus táctil no soportado */ }
  }

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black">
      <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] text-white">
        <div className="min-w-0">
          <span className="block truncate text-sm font-semibold">{hint}</span>
          {resolutionLabel && !starting && (
            <span className="text-[10px] text-white/60">Cámara: {resolutionLabel}</span>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded-full bg-white/15 px-3 py-1.5 leading-none active:bg-white/30"
          aria-label="Cerrar escáner"
        >
          ✕
        </button>
      </div>

      <div
        className="relative min-h-0 flex-1 touch-manipulation overflow-hidden"
        onClick={() => { void tapFocus(); }}
      >
        {/* contain evita recortar el sensor en vertical: lo que se ve coincide con lo que se escanea. */}
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          className="absolute inset-0 h-full w-full bg-black object-contain"
        />

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
            <button onClick={onClose} className="rounded-lg bg-white/15 px-4 py-2 text-sm active:bg-white/30">
              Cerrar
            </button>
          </div>
        )}

        {!error && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            style={{ padding: '0 max(1rem, env(safe-area-inset-left))' }}
          >
            <div className="scan-frame relative h-[24%] w-[88%] max-w-xl rounded-2xl border-[3px] border-white/70">
              <div className="absolute -left-2 -top-2 h-6 w-6 rounded-tl-xl border-l-4 border-t-4 border-amber-400" />
              <div className="absolute -right-2 -top-2 h-6 w-6 rounded-tr-xl border-r-4 border-t-4 border-amber-400" />
              <div className="absolute -bottom-2 -left-2 h-6 w-6 rounded-bl-xl border-b-4 border-l-4 border-amber-400" />
              <div className="absolute -bottom-2 -right-2 h-6 w-6 rounded-br-xl border-b-4 border-r-4 border-amber-400" />
            </div>
          </div>
        )}

        {!starting && !error && (
          <p className="pointer-events-none absolute inset-x-0 bottom-3 px-6 text-center text-xs leading-relaxed text-white/90 sm:text-sm">
            Centrá el código dentro del marco. Si se ve borroso, tocá sobre el código para reenfocar.
            {focusModeLive === 'continuous' ? ' · Autofocus activo' : ''}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 text-white">
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
          <div className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-2">
            <span className="text-xs">Zoom</span>
            <input
              type="range"
              aria-label="Zoom"
              min={zoomRange.min}
              max={zoomRange.max}
              step={zoomRange.step}
              value={zoom ?? zoomRange.min}
              onChange={(event) => void applyZoom(Number(event.target.value))}
              className="w-32 accent-amber-400"
            />
          </div>
        )}
      </div>
    </div>
  );
}
