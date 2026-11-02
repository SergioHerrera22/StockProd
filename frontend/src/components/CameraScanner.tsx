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
interface NativeDetection { rawValue?: string; format?: string }
interface NativeDetector {
  detect(source: HTMLVideoElement): Promise<NativeDetection[]>;
}
interface NativeDetectorConstructor {
  new(options?: { formats?: string[] }): NativeDetector;
  getSupportedFormats?: () => Promise<string[]>;
}

/**
 * Escáner de cámara:
 * - Usa BarcodeDetector nativo de Chrome/Android cuando está disponible.
 * - Mantiene ZXing como fallback para navegadores sin BarcodeDetector.
 * - Escanea el video real, sin recortar ni reducirlo a una imagen de baja calidad.
 * - Prioriza cámara trasera, autofocus continuo, linterna y zoom óptico/digital manual.
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
  const [resolutionLabel, setResolutionLabel] = useState('');
  const [engine, setEngine] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const animationRef = useRef<number | null>(null);
  const detectorRef = useRef<NativeDetector | null>(null);
  const onScanRef = useRef(onScan);
  const lastScanRef = useRef({ code: '', seenAt: 0 });
  const detectingRef = useRef(false);

  useEffect(() => { onScanRef.current = onScan; }, [onScan]);

  useEffect(() => {
    let cancelled = false;
    setStarting(true);
    setError(null);
    setZoom(null);
    setZoomRange(null);
    setTorch(false);
    setTorchOn(false);
    setResolutionLabel('');
    setEngine('');
    lastScanRef.current = { code: '', seenAt: 0 };
    detectingRef.current = false;

    const stop = () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
      try { controlsRef.current?.stop(); } catch { /* noop */ }
      controlsRef.current = null;
      try { streamRef.current?.getTracks().forEach(track => track.stop()); } catch { /* noop */ }
      streamRef.current = null;
      detectorRef.current = null;
    };

    const open = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Este navegador no permite usar la cámara. Abrí StockProd desde Chrome y mediante HTTPS.');
        }

        const videoConstraints: MediaTrackConstraints = {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, max: 30 },
        };
        let stream: MediaStream;
        if (deviceId) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: false, video: { ...videoConstraints, deviceId: { exact: deviceId } },
            });
          } catch {
            stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
          }
        } else {
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
        }

        if (cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error('El dispositivo no entregó una pista de video.');
        try { track.contentHint = 'detail'; } catch { /* opcional */ }

        const caps = track.getCapabilities?.() as TrackCaps | undefined;
        if (caps?.focusMode?.includes('continuous')) {
          try {
            await track.applyConstraints({
              advanced: [{ focusMode: 'continuous' } as unknown as MediaTrackConstraintSet],
            });
          } catch { /* autofocus administrado por el navegador */ }
        }

        const settings = track.getSettings() as MediaTrackSettings & { zoom?: number };
        if (settings.width && settings.height) {
          setResolutionLabel(`${settings.width} × ${settings.height}`);
        }
        if (caps?.zoom) {
          setZoomRange({ min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 });
          setZoom(settings.zoom ?? caps.zoom.min);
        }
        if (caps?.torch) setTorch(true);

        const video = videoRef.current;
        if (!video) throw new Error('No se encontró el visor de la cámara.');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();
        if (cancelled) return;

        const BarcodeDetectorClass = (window as unknown as { BarcodeDetector?: NativeDetectorConstructor }).BarcodeDetector;
        let nativeDetector: NativeDetector | null = null;
        if (BarcodeDetectorClass) {
          try {
            const supported = BarcodeDetectorClass.getSupportedFormats
              ? await BarcodeDetectorClass.getSupportedFormats()
              : ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'];
            const preferred = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'];
            const formats = preferred.filter(format => supported.includes(format));
            if (formats.length) nativeDetector = new BarcodeDetectorClass({ formats });
          } catch { nativeDetector = null; }
        }

        if (nativeDetector) {
          detectorRef.current = nativeDetector;
          setEngine('Motor nativo del teléfono');
          let lastAttempt = 0;
          const scanFrame = async (time: number) => {
            if (cancelled || !detectorRef.current || !videoRef.current) return;
            animationRef.current = requestAnimationFrame(scanFrame);
            if (time - lastAttempt < 120 || detectingRef.current || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
            lastAttempt = time;
            detectingRef.current = true;
            try {
              const detections = await detectorRef.current.detect(video);
              if (cancelled) return;
              const code = detections.map(item => item.rawValue?.trim()).find(value => Boolean(value));
              const now = Date.now();
              if (code) {
                if (code !== lastScanRef.current.code) {
                  lastScanRef.current = { code, seenAt: now };
                  void Promise.resolve(onScanRef.current(code)).catch(() => undefined);
                } else {
                  lastScanRef.current.seenAt = now;
                }
              } else if (now - lastScanRef.current.seenAt > 900) {
                lastScanRef.current = { code: '', seenAt: 0 };
              }
            } catch {
              // Un fotograma borroso no debe detener el escáner.
            } finally {
              detectingRef.current = false;
            }
          };
          animationRef.current = requestAnimationFrame(scanFrame);
        } else {
          setEngine('Motor de compatibilidad');
          const hints = new Map<DecodeHintType, unknown>();
          hints.set(DecodeHintType.TRY_HARDER, true);
          hints.set(DecodeHintType.POSSIBLE_FORMATS, [
            BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A,
            BarcodeFormat.UPC_E, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
            BarcodeFormat.ITF, BarcodeFormat.CODABAR,
          ]);
          const readerOptions: IBrowserCodeReaderOptions = {
            delayBetweenScanAttempts: 120,
            delayBetweenScanSuccess: 500,
          };
          const reader = new BrowserMultiFormatReader(hints, readerOptions);
          await reader.decodeFromStream(stream, video, (result: Result | undefined, _decodeError, controls) => {
            if (controls) controlsRef.current = controls as unknown as { stop: () => void };
            if (cancelled) return;
            const now = Date.now();
            const code = result?.getText().trim();
            if (code) {
              if (code !== lastScanRef.current.code) {
                lastScanRef.current = { code, seenAt: now };
                void Promise.resolve(onScanRef.current(code)).catch(() => undefined);
              } else {
                lastScanRef.current.seenAt = now;
              }
            } else if (now - lastScanRef.current.seenAt > 900) {
              lastScanRef.current = { code: '', seenAt: 0 };
            }
          });
        }

        if (cancelled) return;
        setStarting(false);
        try {
          const cams = (await navigator.mediaDevices.enumerateDevices()).filter(item => item.kind === 'videoinput');
          if (!cancelled) setDevices(cams.length > 1 ? cams : []);
        } catch { /* selector opcional */ }
      } catch (err) {
        if (cancelled) return;
        stop();
        const e = err as Error;
        setError(
          e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError'
            ? 'No diste permiso para usar la cámara. Habilitalo en Chrome y volvé a intentar.'
            : e.name === 'NotFoundError' || e.name === 'OverconstrainedError'
              ? 'No se encontró una cámara compatible. Revisá los permisos o cambiá de cámara.'
              : `No se pudo abrir la cámara: ${e.message || e.name}`,
        );
      }
    };

    void open();
    return () => {
      cancelled = true;
      stop();
    };
  }, [deviceId]);

  async function applyZoom(value: number) {
    setZoom(value);
    try {
      await streamRef.current?.getVideoTracks()[0]?.applyConstraints({
        advanced: [{ zoom: value } as unknown as MediaTrackConstraintSet],
      });
    } catch { /* zoom no disponible */ }
  }

  async function toggleTorch() {
    const next = !torchOn;
    try {
      const track = streamRef.current?.getVideoTracks()[0];
      if (!track) return;
      await track.applyConstraints({ advanced: [{ torch: next } as unknown as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch { /* linterna no disponible */ }
  }

  async function tapFocus() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      const caps = track.getCapabilities?.() as TrackCaps | undefined;
      if (caps?.focusMode?.includes('single-shot')) {
        await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' } as unknown as MediaTrackConstraintSet] });
        if (caps.focusMode.includes('continuous')) {
          window.setTimeout(() => {
            void track.applyConstraints({
              advanced: [{ focusMode: 'continuous' } as unknown as MediaTrackConstraintSet],
            }).catch(() => undefined);
          }, 700);
        }
      }
    } catch { /* el dispositivo puede gestionar el foco automáticamente */ }
  }

  function cycleCamera() {
    if (devices.length < 2) return;
    const index = devices.findIndex(device => device.deviceId === deviceId);
    setDeviceId(devices[(index + 1) % devices.length].deviceId);
  }

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black">
      <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] text-white">
        <div className="min-w-0">
          <span className="block truncate text-sm font-semibold">{hint}</span>
          <span className="block text-[10px] text-white/60">
            {resolutionLabel ? `Cámara: ${resolutionLabel}` : 'Preparando cámara…'}
            {engine ? ` · ${engine}` : ''}
          </span>
        </div>
        <button onClick={onClose} className="rounded-full bg-white/15 px-3 py-1.5 leading-none active:bg-white/30" aria-label="Cerrar escáner">✕</button>
      </div>

      <div className="relative min-h-0 flex-1 touch-manipulation overflow-hidden" onClick={() => { void tapFocus(); }}>
        <video ref={videoRef} muted playsInline autoPlay className="absolute inset-0 h-full w-full bg-black object-contain" />
        {starting && !error && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/60 text-white">
            <Spinner light size="lg" /><span className="text-sm text-white/80">Iniciando cámara…</span>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/85 p-8 text-center text-white">
            <div className="text-4xl">📷</div><p className="max-w-sm text-sm leading-relaxed">{error}</p>
            <button onClick={onClose} className="rounded-lg bg-white/15 px-4 py-2 text-sm">Cerrar</button>
          </div>
        )}
        {!error && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center" style={{ padding: '0 max(1rem, env(safe-area-inset-left))' }}>
            <div className="relative h-[24%] w-[92%] max-w-2xl rounded-2xl border-[3px] border-white/70">
              <div className="absolute -left-2 -top-2 h-6 w-6 rounded-tl-xl border-l-4 border-t-4 border-amber-400" />
              <div className="absolute -right-2 -top-2 h-6 w-6 rounded-tr-xl border-r-4 border-t-4 border-amber-400" />
              <div className="absolute -bottom-2 -left-2 h-6 w-6 rounded-bl-xl border-b-4 border-l-4 border-amber-400" />
              <div className="absolute -bottom-2 -right-2 h-6 w-6 rounded-br-xl border-b-4 border-r-4 border-amber-400" />
            </div>
          </div>
        )}
        {!starting && !error && <p className="pointer-events-none absolute inset-x-0 bottom-3 px-6 text-center text-xs leading-relaxed text-white/90">Acercá el código hasta que las barras se vean nítidas. Tocá la pantalla para reenfocar.</p>}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 text-white">
        {torch && <button onClick={() => void toggleTorch()} className={`rounded-full px-4 py-2.5 text-sm active:scale-95 ${torchOn ? 'bg-amber-400 text-black' : 'bg-white/15 text-white'}`}>🔦 Luz</button>}
        <button onClick={cycleCamera} disabled={devices.length < 2} className="rounded-full bg-white/15 px-4 py-2.5 text-sm active:bg-white/30 disabled:opacity-40">🔄 Cámara</button>
        {zoomRange && (
          <div className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-2">
            <span className="text-xs">Zoom</span>
            <input type="range" aria-label="Zoom" min={zoomRange.min} max={zoomRange.max} step={zoomRange.step} value={zoom ?? zoomRange.min} onChange={event => void applyZoom(Number(event.target.value))} className="w-32 accent-amber-400" />
          </div>
        )}
      </div>
    </div>
  );
}
