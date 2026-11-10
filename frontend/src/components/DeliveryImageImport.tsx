import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card } from './ui';

export interface DeliveryImageRow {
  code: string;
  description: string;
  quantity: number;
  confidence: number;
}

interface Props {
  onImport: (rows: DeliveryImageRow[]) => Promise<void> | void;
  disabled?: boolean;
}

declare global {
  interface Window { Tesseract?: any; }
}

let tesseractPromise: Promise<any> | null = null;

function loadTesseract(): Promise<any> {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!tesseractPromise) {
    tesseractPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      script.async = true;
      script.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('No se pudo iniciar el motor OCR'));
      script.onerror = () => { tesseractPromise = null; reject(new Error('No se pudo descargar el motor OCR. Revisá la conexión a Internet.')); };
      document.head.appendChild(script);
    });
  }
  return tesseractPromise;
}

function parseQuantity(value: string): number | null {
  const normalized = value.replace(/[^0-9,.-]/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 && number < 100000 ? number : null;
}

function extractRows(words: any[], imageWidth: number): DeliveryImageRow[] {
  const grouped = new Map<string, any[]>();
  for (const word of words || []) {
    if (!word.text?.trim() || Number(word.confidence ?? 0) < 25) continue;
    const key = [word.block_num, word.par_num, word.line_num].join('-');
    grouped.set(key, [...(grouped.get(key) || []), word]);
  }

  const rows: DeliveryImageRow[] = [];
  for (const line of grouped.values()) {
    const sorted = line.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    // La grilla de Tiempo Gestión ubica Modelo a la izquierda y Unidades
    // aproximadamente en el 35-50% del ancho de la captura.
    const codeWord = sorted.find((w) =>
      w.bbox.x0 / imageWidth < 0.34 &&
      /^[A-Z0-9][A-Z0-9._/-]{3,19}$/i.test(w.text.replace(/[^a-z0-9._/-]/gi, ''))
    );
    if (!codeWord) continue;

    const code = codeWord.text.replace(/[^a-z0-9._/-]/gi, '').toUpperCase();
    const qtyWord = sorted.find((w) => {
      const x = w.bbox.x0 / imageWidth;
      return w !== codeWord && x >= 0.34 && x <= 0.53 && parseQuantity(w.text) !== null;
    });
    if (!qtyWord) continue;

    const quantity = parseQuantity(qtyWord.text);
    if (quantity === null) continue;
    const description = sorted
      .filter((w) => w.bbox.x0 > codeWord.bbox.x1 && w.bbox.x1 < qtyWord.bbox.x0)
      .map((w) => w.text)
      .join(' ')
      .trim();

    // Excluir encabezados y líneas sin descripción; conservar códigos repetidos.
    if (!description || /^(MODELO|DETALLE|UNIDADES|PRECIO)$/i.test(description)) continue;
    rows.push({
      code,
      description,
      quantity,
      confidence: Math.round(Math.min(Number(codeWord.confidence || 0), Number(qtyWord.confidence || 0))),
    });
  }
  return rows;
}

export function DeliveryImageImport({ onImport, disabled = false }: Props) {
  const [processing, setProcessing] = useState(false);
  const [rows, setRows] = useState<DeliveryImageRow[]>([]);
  const [error, setError] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [adding, setAdding] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const processImage = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('El portapapeles no contiene una imagen.');
      return;
    }
    setProcessing(true);
    setError('');
    setRows([]);
    setSourceName(file.name || 'Captura pegada');
    try {
      const Tesseract = await loadTesseract();
      const result = await Tesseract.recognize(file, 'spa+eng', {
        logger: (message: any) => {
          if (message.status === 'recognizing text') setSourceName(`Reconociendo… ${Math.round((message.progress || 0) * 100)}%`);
        },
      });
      const width = result.data?.imageSize?.width || result.data?.width || 0;
      const found = extractRows(result.data?.words || [], width);
      if (!found.length) {
        setError('No se detectaron filas con código y cantidad. Probá con una captura donde la tabla se vea completa y nítida.');
      } else {
        setRows(found);
      }
    } catch (e) {
      setError((e as Error).message || 'No se pudo procesar la captura.');
    } finally {
      setProcessing(false);
    }
  }, []);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, [contenteditable="true"]'))) return;
      const image = Array.from(event.clipboardData?.items || [])
        .find((item) => item.type.startsWith('image/'))?.getAsFile();
      if (image) {
        event.preventDefault();
        void processImage(image);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [processImage]);

  async function confirmImport() {
    setAdding(true);
    try {
      await onImport(rows);
      setRows([]);
      setSourceName('');
    } finally {
      setAdding(false);
    }
  }

  return (
    <Card className="mb-4 border-dashed border-indigo-200 bg-indigo-50/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <span aria-hidden="true">▧</span> Importar productos desde captura
          </h3>
          <p className="mt-1 text-xs text-slate-500">Copiá la pantalla de Tiempo Gestión y pegala con Ctrl + V. El reconocimiento comienza automáticamente.</p>
        </div>
        <div className="flex gap-2">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void processImage(file);
            e.currentTarget.value = '';
          }} />
          <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} disabled={disabled || processing}>Elegir imagen</Button>
        </div>
      </div>

      {processing && <div className="mt-3 rounded-lg bg-white p-3 text-sm text-indigo-700">Procesando captura automáticamente… {sourceName}</div>}
      {error && <div role="alert" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{error}</div>}

      {rows.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <div className="text-sm font-semibold text-slate-700">{rows.length} línea(s) reconocida(s)</div>
            <button type="button" className="text-xs text-slate-500 underline" onClick={() => setRows([])}>Descartar</button>
          </div>
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
                <tr><th className="px-3 py-2">Código</th><th className="px-3 py-2">Descripción leída</th><th className="px-3 py-2 text-right">Cantidad</th><th className="px-3 py-2 text-right">Confianza</th></tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-mono font-semibold">{row.code}</td>
                    <td className="px-3 py-2">{row.description}</td>
                    <td className="px-3 py-2 text-right font-semibold">{row.quantity}</td>
                    <td className="px-3 py-2 text-right">{row.confidence}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 p-3">
            <p className="text-xs text-slate-500">Revisá las líneas antes de incorporarlas. Los códigos repetidos se mantienen como líneas reconocidas.</p>
            <Button size="sm" onClick={confirmImport} loading={adding} disabled={disabled || adding}>Agregar productos a la entrega</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
