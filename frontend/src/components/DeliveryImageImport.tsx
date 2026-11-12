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
  // Acepta cantidades enteras o decimales (1,00 / 1.00 / 0,5).
  const normalized = value.replace(/[^0-9,.-]/g, '').replace(',', '.');
  if (!/^\\d+(\\.\\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 && number < 100000 ? number : null;
}

async function getImageWidth(file: File): Promise<number> {
  // No dependemos de imageSize/width de Tesseract: esas propiedades no están
  // garantizadas en todas las versiones ni en todos los formatos de respuesta.
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    const width = bitmap.width;
    bitmap.close();
    return width;
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image.naturalWidth);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo leer el tamaño de la captura.'));
    };
    image.src = url;
  });
}

function extractRows(words: any[], imageWidth: number): DeliveryImageRow[] {
  if (!imageWidth || !Number.isFinite(imageWidth)) return [];

  const grouped = new Map<string, any[]>();
  for (const word of words || []) {
    if (!word.text?.trim() || !word.bbox || Number(word.confidence ?? 0) < 20) continue;
    const key = [word.block_num, word.par_num, word.line_num].join('-');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(word);
  }

  const rows: DeliveryImageRow[] = [];
  for (const line of grouped.values()) {
    const sorted = line.sort((a, b) => a.bbox.x0 - b.bbox.x0);

    // En la grilla de Tiempo Gestión: Modelo está en el primer 22%,
    // Detalle ocupa el centro y Unidades aparece aproximadamente entre 50-68%.
    // El rango anterior (34-53%) caía dentro de Detalle y descartaba las filas.
    const codeWord = sorted.find((word) => {
      const x = word.bbox.x0 / imageWidth;
      const token = String(word.text).replace(/[^a-z0-9._/-]/gi, '');
      return x <= 0.24 && /^[A-Z0-9][A-Z0-9._/-]{2,24}$/i.test(token);
    });
    if (!codeWord) continue;

    const code = String(codeWord.text).replace(/[^a-z0-9._/-]/gi, '').toUpperCase();
    const qtyWord = sorted.find((word) => {
      const x = word.bbox.x0 / imageWidth;
      return word !== codeWord && x >= 0.50 && x <= 0.69 && parseQuantity(String(word.text)) !== null;
    });
    if (!qtyWord) continue;

    const quantity = parseQuantity(String(qtyWord.text));
    if (quantity === null) continue;

    const description = sorted
      .filter((word) => word.bbox.x0 >= codeWord.bbox.x1 - 2 && word.bbox.x1 <= qtyWord.bbox.x0 + 2)
      .filter((word) => word !== codeWord && word !== qtyWord)
      .map((word) => String(word.text))
      .join(' ')
      .replace(/\\s+/g, ' ')
      .trim();

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
      const [result, imageWidth] = await Promise.all([
        Tesseract.recognize(file, 'spa+eng', {
          logger: (message: any) => {
            if (message.status === 'recognizing text') setSourceName(`Reconociendo… ${Math.round((message.progress || 0) * 100)}%`);
          },
        }),
        getImageWidth(file),
      ]);
      const found = extractRows(result.data?.words || [], imageWidth);
      if (!found.length) {
        const rawText = String(result.data?.text || '').trim();
        setError(rawText
          ? `El OCR leyó el texto, pero no pudo separar las columnas de productos y cantidades. Texto detectado: ${rawText.slice(0, 280)}`
          : 'El motor OCR no pudo leer texto de la captura. Probá con una imagen más nítida y con la tabla completa.');
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
