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

async function getImageWidth(file: File): Promise<number> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    const width = bitmap.width;
    bitmap.close();
    return width;
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image.naturalWidth); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer el tamaño de la captura.')); };
    image.src = url;
  });
}

function extractRows(words: any[], imageWidth: number): DeliveryImageRow[] {
  if (!imageWidth || !Number.isFinite(imageWidth)) return [];
  const valid = (words || []).filter((w) => String(w.text || '').trim() && w.bbox);
  if (!valid.length) return [];
  const unitsHeader = valid.find((w) => /^(unidades|unidad|cant\.?|cantidad)$/i.test(String(w.text).trim()));
  const unitsX = unitsHeader ? (Number(unitsHeader.bbox.x0) + Number(unitsHeader.bbox.x1)) / 2 : imageWidth * 0.405;
  const modelHeader = valid.find((w) => /^(modelo|c[oó]digo)$/i.test(String(w.text).trim()));
  const modelX = modelHeader ? (Number(modelHeader.bbox.x0) + Number(modelHeader.bbox.x1)) / 2 : imageWidth * 0.12;

  // Agrupa cajas por cercanía vertical, independientemente de los IDs de línea de Tesseract.
  const lines: any[][] = [];
  for (const word of [...valid].sort((a,b) => a.bbox.y0-b.bbox.y0)) {
    const cy = (Number(word.bbox.y0)+Number(word.bbox.y1))/2;
    const h = Math.max(1,Number(word.bbox.y1)-Number(word.bbox.y0));
    let line = lines.find(items => {
      const ys=items.map(w => (Number(w.bbox.y0)+Number(w.bbox.y1))/2);
      const avg=ys.reduce((a,b)=>a+b,0)/ys.length;
      const ah=items.reduce((s,w)=>s+Math.max(1,Number(w.bbox.y1)-Number(w.bbox.y0)),0)/items.length;
      return Math.abs(cy-avg)<=Math.max(7,Math.min(h,ah)*0.65);
    });
    if (!line) { line=[]; lines.push(line); }
    line.push(word);
  }

  const rows: DeliveryImageRow[]=[];
  for (const line of lines) {
    const sorted=line.sort((a,b)=>a.bbox.x0-b.bbox.x0);
    const codes=sorted.filter(w => {
      const x=(Number(w.bbox.x0)+Number(w.bbox.x1))/2;
      const t=String(w.text).replace(/[^a-z0-9._/-]/gi,'');
      return x<unitsX-12 && /^[A-Z0-9][A-Z0-9._/-]{2,24}$/i.test(t) && !/^(MODELO|CODIGO|DETALLE|UNIDADES|UNIDAD|CANTIDAD|PRECIO)$/i.test(t);
    });
    if (!codes.length) continue;
    const codeWord=codes.sort((a,b)=>{
      const ax=(Number(a.bbox.x0)+Number(a.bbox.x1))/2, bx=(Number(b.bbox.x0)+Number(b.bbox.x1))/2;
      return Math.abs(ax-modelX)-Math.abs(bx-modelX);
    })[0];
    const quantities=sorted.filter(w=>w!==codeWord && Number(w.bbox.x0)>Number(codeWord.bbox.x0) && parseQuantity(String(w.text))!==null);
    if (!quantities.length) continue;
    const qtyWord=quantities.sort((a,b)=>{
      const ax=(Number(a.bbox.x0)+Number(a.bbox.x1))/2, bx=(Number(b.bbox.x0)+Number(b.bbox.x1))/2;
      return Math.abs(ax-unitsX)-Math.abs(bx-unitsX);
    })[0];
    const quantity=parseQuantity(String(qtyWord.text));
    const code=String(codeWord.text).replace(/[^a-z0-9._/-]/gi,'').toUpperCase();
    const description=sorted.filter(w=>Number(w.bbox.x0)>Number(codeWord.bbox.x1)+1 && Number(w.bbox.x1)<Number(qtyWord.bbox.x0)-1)
      .map(w=>String(w.text).trim()).filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
    if (!code || !description || quantity===null) continue;
    rows.push({code,description,quantity,confidence:Math.round(Math.min(Number(codeWord.confidence??0),Number(qtyWord.confidence??0)))});
  }
  const unique=new Map<string,DeliveryImageRow>();
  for (const row of rows) unique.set(`${row.code}|${row.quantity}`,row);
  return [...unique.values()];
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
