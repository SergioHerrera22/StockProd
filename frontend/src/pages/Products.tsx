import { useCallback, useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { api, qs } from '../lib/api';
import { exportCSV, fmtMoney, fmtQty } from '../lib/format';
import { useAuth } from '../store/auth';
import type { Category, Product, ProductStockRow } from '../types';
import {
  Badge, Button, Card, Field, FormRow, Input, Modal, PageHeader, Select,
  Spinner, Textarea, useConfirm,
} from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';
import { CameraScanner } from '../components/CameraScanner';
import Barcode from '../components/Barcode';

const UNIT_LABELS: Record<string, string> = {
  UNIDAD: 'Unidad', LITRO: 'Litro', KG: 'Kilogramo', METRO: 'Metro', OTRO: 'Otro',
};

const IMPORT_FIELD_LABEL: Record<string, string> = {
  code: 'código', name: 'nombre', barcode: 'código de barras', brand: 'marca',
  category: 'categoría', unit: 'unidad', minStock: 'stock mín.', cost: 'costo',
  referencePrice: 'precio',
};

/** Limpia una celda: espacios invisibles de Excel (\u00A0, \u200B, BOM),
 *  colapsa espacios múltiples y recorta extremos. */
function cleanCell(v: unknown): string {
  return String(v ?? '')
    .replace(/[\u00A0\u200B\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Quita el relleno de puntos que agregan los exportes ("1L...." → "1L"). */
function stripDotPadding(s: string): string {
  return s.replace(/\.{2,}\s*$/, '').trim();
}

function cleanName(v: unknown): string {
  return stripDotPadding(cleanCell(v));
}

/** Quita TODOS los espacios de un código y su relleno de puntos. */
function cleanCodeCell(v: unknown): string {
  return stripDotPadding(String(v ?? '').replace(/\s+/g, '')).replace(/\.{2,}$/, '');
}

/** Clave de encabezado: sin acentos, sin espacios, en minúsculas. */
function normKey(s: string): string {
  return cleanCell(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Decide si un valor suelto parece un CÓDIGO de producto (y no un nombre). */
function isCodeLike(s: string): boolean {
  const compact = s.replace(/\s+/g, '');
  if (!compact) return false;
  if (/^\d+$/.test(compact)) return true;                       // solo números: 1234
  if (/^\d+\.0+$/.test(compact)) return true;                   // 1234.0 (Excel)
  return (
    compact.length <= 20 &&
    /^[A-Za-z0-9][A-Za-z0-9._\-\/]*$/.test(compact) &&
    /\d/.test(compact)                                          // alfanumérico corto con dígito: A12-3
  );
}

/** Detecta columnas de código y nombre por el CONTENIDO de las celdas.
 *  Rescata el caso de exportes con encabezados desplazados respecto a los datos. */
function detectColumnsByContent(grid: string[][], startRow: number): { code: number; name: number } | null {
  interface ColStat { codeLike: number; textLen: number; nonEmpty: number; }
  const stats: Record<number, ColStat> = {};

  for (let i = startRow; i < grid.length; i++) {
    for (let col = 0; col < grid[i].length; col++) {
      const c = grid[i][col];
      if (!c) continue;
      if (!stats[col]) stats[col] = { codeLike: 0, textLen: 0, nonEmpty: 0 };
      stats[col].nonEmpty++;
      if (isCodeLike(c)) stats[col].codeLike++;
      if (c.length >= 8 && /[A-Za-z]/.test(c)) stats[col].textLen += c.length;
    }
  }

  let codeCol = -1, nameCol = -1, bestCode = 0, bestText = 0;
  for (const [colStr, s] of Object.entries(stats)) {
    const col = Number(colStr);
    if (s.nonEmpty < 5) continue;
    if (s.codeLike / s.nonEmpty > 0.8 && s.codeLike > bestCode) { bestCode = s.codeLike; codeCol = col; }
    if (s.textLen > bestText) { bestText = s.textLen; nameCol = col; }
  }
  return codeCol >= 0 && nameCol >= 0 && codeCol !== nameCol ? { code: codeCol, name: nameCol } : null;
}

/** Busca la fila de encabezados y arma el mapeo columna → campo.
 *  Devuelve null si ninguna fila parece un encabezado de productos. */
function mapHeaders(header: string[]): Record<number, string> | null {
  const keys = header.map(normKey);
  const used = new Set<number>();
  const mapping: Record<number, string> = {};

  const find = (words: string[]): number => {
    for (let i = 0; i < keys.length; i++) {
      if (used.has(i) || !keys[i]) continue;
      if (words.some((w) => keys[i] === w || keys[i].includes(w))) return i;
    }
    return -1;
  };

  // El orden importa: "código de barras" también contiene "código"
  const barcode = find(['codigodebarras', 'codigobarras', 'codbarras', 'barras', 'barcode', 'ean']);
  if (barcode >= 0) { mapping[barcode] = 'barcode'; used.add(barcode); }

  const code = find(['codigo', 'cod', 'code', 'articulo']);
  if (code >= 0) { mapping[code] = 'code'; used.add(code); }

  const name = find(['descripcion', 'denominacion', 'detalle', 'nombre', 'articulo', 'producto', 'name']);
  if (name >= 0) { mapping[name] = 'name'; used.add(name); }

  const brand = find(['marca', 'brand', 'fabricante']);
  if (brand >= 0) { mapping[brand] = 'brand'; used.add(brand); }

  const category = find(['categoria', 'rubro', 'familia', 'linea', 'grupo', 'category']);
  if (category >= 0) { mapping[category] = 'category'; used.add(category); }

  const unit = find(['unidadmedida', 'unidad', 'umedida', 'unit']);
  if (unit >= 0) { mapping[unit] = 'unit'; used.add(unit); }

  const min = find(['stockminimo', 'stockmin', 'minimo', 'minstock']);
  if (min >= 0) { mapping[min] = 'minStock'; used.add(min); }

  const cost = find(['costo', 'coste', 'cost', 'preciocosto']);
  if (cost >= 0) { mapping[cost] = 'cost'; used.add(cost); }

  const price = find(['precioreferencia', 'referencia', 'precioventa', 'precio', 'preciovta']);
  if (price >= 0) { mapping[price] = 'referencePrice'; used.add(price); }

  // mapping usa claves numéricas (índice de columna) y valores de campo:
  // hay mapeo si al menos una columna fue reconocida.
  return Object.keys(mapping).length > 0 ? mapping : null;
}

const emptyForm = {
  id: 0,
  code: '',
  barcode: '',
  name: '',
  description: '',
  brand: '',
  categoryId: '',
  unit: 'UNIDAD',
  minStock: '0',
  cost: '',
  referencePrice: '',
  isActive: true,
};

export default function Products() {
  const can = useAuth((s) => s.can);
  const toast = useToast();
  const confirm = useConfirm();

  const [rows, setRows] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const loadRequestId = useRef(0);
  const [categoryId, setCategoryId] = useState('');
  const [active, setActive] = useState('true');
  const [categories, setCategories] = useState<Category[]>([]);

  const [form, setForm] = useState<typeof emptyForm>(emptyForm);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [duplicates, setDuplicates] = useState<{ id: number; code: string; name: string }[]>([]);
  const [detail, setDetail] = useState<{ product: Product; stock: ProductStockRow[] } | null>(null);

  const [importOpen, setImportOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importRows, setImportRows] = useState<Record<string, unknown>[]>([]);
  const [importInfo, setImportInfo] = useState<{ mapped: string; ignored: number; autoMode: boolean } | null>(null);
  const [importing, setImporting] = useState(false);

  // Escaneo con cámara y generación automática del código de barras
  const [scanOpen, setScanOpen] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  // Escaneo del buscador del listado: localizar/editar un producto leyendo su barras
  const [searchScanOpen, setSearchScanOpen] = useState(false);

  // ===== Etiquetas de código de barras (mejora 12) =====
  const [labelsTarget, setLabelsTarget] = useState<Product | null>(null);
  const [labelCopies, setLabelCopies] = useState('12');

  function openLabels(p: Product) {
    setLabelCopies('12');
    setLabelsTarget(p);
  }

  /** Imprime la hoja de etiquetas en un iframe aislado: usa estilos propios y
   *  no interfiere con el CSS de la aplicación. JsBarcode deja el contenido
   *  pintado en el SVG, así que clonando el markup del preview el lector
   *  escanea el código igual que en pantalla. */
  function printLabels() {
    const grid = document.getElementById('label-preview-grid');
    if (!grid || !labelsTarget) return;
    const copies = Math.max(1, Math.min(parseInt(labelCopies, 10) || 12, 120));
    // Los SVG de barras salen del preview ya renderizado (JsBarcode los genera on-mount)
    const svgHtml = grid.querySelector('svg')?.outerHTML ?? '';
    if (!svgHtml) { toast.error('El código de barras todavía no está listo, probá de nuevo'); return; }
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const sheet = Array.from({ length: copies }, () => `<div class="sticker">
        <div class="name">${esc(labelsTarget.name)}</div>
        ${labelsTarget.brand ? `<div class="meta">${esc(labelsTarget.brand)}</div>` : ''}
        <div class="meta">${esc(labelsTarget.code)}</div>
        ${svgHtml}
      </div>`).join('');
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    if (!doc) { document.body.removeChild(iframe); toast.error('El navegador bloqueó la impresión'); return; }
    doc.open();
    doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Etiquetas ${esc(labelsTarget.code)}</title>
      <style>
        @page { margin: 6mm; }
        body { margin: 0; font-family: Arial, Helvetica, sans-serif; }
        .sheet { display: flex; flex-wrap: wrap; gap: 2mm; }
        .sticker { box-sizing: border-box; width: 38mm; height: 21mm; border: 0.3mm dashed #cbd5e1;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          overflow: hidden; padding: 1mm; text-align: center; }
        .sticker .name { font-size: 8.5px; font-weight: bold; color: #0f172a; line-height: 1.15;
          max-height: 2.3em; overflow: hidden; }
        .sticker .meta { font-size: 7px; color: #334155; }
        .sticker svg { max-width: 34mm; }
      </style></head>
      <body><div class="sheet">${sheet}</div></body></html>`);
    doc.close();
    setTimeout(() => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      setTimeout(() => { document.body.removeChild(iframe); }, 750);
    }, 350);
  }

  async function generateBarcode() {
    setGenBusy(true);
    try {
      const res = await api<{ barcode: string }>('/products/barcode/new');
      setForm((f) => ({ ...f, barcode: res.barcode }));
      toast.success(`Código EAN-13 único generado: ${res.barcode}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGenBusy(false);
    }
  }

  // Espera a que termine la escritura antes de consultar el catálogo.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [q]);

  const load = useCallback(async () => {
    const requestId = ++loadRequestId.current;
    setLoading(true);
    try {
      const res = await api<{ products: Product[]; total: number }>(
        `/products${qs({ q: debouncedQ, categoryId, active, page, pageSize: 15 })}`
      );
      // Evita que una respuesta lenta de un filtro anterior pise la más reciente.
      if (requestId === loadRequestId.current) {
        setRows(res.products);
        setTotal(res.total);
      }
    } catch (e) {
      if (requestId === loadRequestId.current) toast.error((e as Error).message);
    } finally {
      if (requestId === loadRequestId.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ, categoryId, active, page]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api<{ categories: Category[] }>('/categories').then((r) => setCategories(r.categories)).catch(() => {});
  }, []);

  // Duplicados: se consulta mientras se completa el nombre/código
  useEffect(() => {
    if (!modalOpen || !form.name || form.id) return;
    const t = window.setTimeout(async () => {
      try {
        const res = await api<{ similar: { id: number; code: string; name: string }[] }>(
          `/products/duplicates${qs({ name: form.name, brand: form.brand, barcode: form.barcode })}`
        );
        setDuplicates(res.similar);
      } catch { /* silencioso */ }
    }, 350);
    return () => window.clearTimeout(t);
  }, [form.name, form.brand, form.barcode, modalOpen, form.id]);

  function openNew() {
    setForm(emptyForm);
    setDuplicates([]);
    setScanOpen(false);
    setModalOpen(true);
  }

  function openEdit(p: Product) {
    setForm({
      id: p.id,
      code: p.code,
      barcode: p.barcode ?? '',
      name: p.name,
      description: p.description ?? '',
      brand: p.brand ?? '',
      categoryId: p.category_id ? String(p.category_id) : '',
      unit: p.unit,
      minStock: String(p.min_stock ?? '0'),
      cost: p.cost === null || p.cost === undefined ? '' : String(p.cost),
      referencePrice: p.reference_price === null || p.reference_price === undefined ? '' : String(p.reference_price),
      isActive: p.is_active,
    });
    setDuplicates([]);
    setScanOpen(false);
    setModalOpen(true);
  }

  /**
   * Buscar por código de barras escaneado: traeme el/los productos que matchean
   * (el backend matchea también por p.barcode). Si hay UNO solo, lo abre en
   * edición directamente; si hay varios, solo filtra el listado.
   */
  async function handleScanFind(code: string) {
    const clean = code.trim();
    if (!clean) return;
    try {
      // active='': buscar en activos e inactivos para no ocultar match exactos
      const res = await api<{ products: Product[]; total: number }>(
        `/products${qs({ q: clean, active: '', page: 1, pageSize: 15 })}`
      );
      if (res.products.length === 0) {
        toast.error(`Ningún producto con el código "${clean}". Si está inactivo, abrilo desde el listado con filtro "Todos".`);
        return;
      }
      setSearchScanOpen(false);
      setQ(clean);
      setPage(1);
      if (res.products.length === 1) {
        const p = res.products[0];
        if (can('products.write')) {
          openEdit(p);
          toast.success(`Producto encontrado: ${p.name}`);
        } else {
          toast.success(`Producto encontrado: ${p.name} (sin permiso para editarlo)`);
        }
      } else {
        toast.success(`Se encontraron ${res.products.length} productos con ese código`);
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function save() {
    if (!form.code.trim() || !form.name.trim()) {
      toast.error('El código y el nombre son obligatorios');
      return;
    }
    setSaving(true);
    const body = {
      code: form.code.trim(),
      barcode: form.barcode.trim() || null,
      name: form.name.trim(),
      description: form.description.trim() || null,
      brand: form.brand.trim() || null,
      categoryId: form.categoryId ? Number(form.categoryId) : null,
      unit: form.unit,
      minStock: Number(form.minStock) || 0,
      cost: form.cost === '' ? null : Number(form.cost),
      referencePrice: form.referencePrice === '' ? null : Number(form.referencePrice),
      isActive: form.isActive,
    };
    try {
      if (form.id) {
        await api(`/products/${form.id}`, { method: 'PUT', body });
        toast.success('Producto actualizado');
      } else {
        await api('/products', { method: 'POST', body });
        toast.success('Producto creado');
      }
      setModalOpen(false);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function toggleActive(p: Product) {
    const action = p.is_active ? 'desactivar' : 'reactivar';
    confirm({
      title: `¿${p.is_active ? 'Desactivar' : 'Reactivar'} producto?`,
      message: `Vas a ${action} "${p.name}". El historial se conserva.`,
      danger: p.is_active,
      confirmLabel: p.is_active ? 'Desactivar' : 'Reactivar',
      onConfirm: async () => {
        try {
          if (p.is_active) await api(`/products/${p.id}`, { method: 'DELETE' });
          else await api(`/products/${p.id}`, { method: 'PUT', body: { isActive: true } });
          toast.success(`Producto ${p.is_active ? 'desactivado' : 'reactivado'}`);
          void load();
        } catch (e) {
          toast.error((e as Error).message);
        }
      },
    });
  }

  async function openDetail(p: Product) {
    try {
      const res = await api<{ product: Product; stock: ProductStockRow[] }>(`/products/${p.id}`);
      setDetail(res);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  // ---------- Importación ----------
  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const raw = ev.target?.result as ArrayBuffer;
        let wb: XLSX.WorkBook;

        if (/\.(csv|txt)$/i.test(file.name)) {
          // Los exportes de Tiempo Gestión vienen en ANSI (latin1), sin BOM:
          // probamos UTF-8 estricto y si falla decodificamos como Windows-1252.
          const bytes = new Uint8Array(raw);
          let text: string;
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            text = new TextDecoder('windows-1252').decode(bytes);
          }
          wb = XLSX.read(text, { type: 'string', raw: false });
        } else {
          wb = XLSX.read(raw, { type: 'array' });
        }

        const ws = wb.Sheets[wb.SheetNames[0]];
        // Leemos como matriz para poder detectar dónde está la fila de encabezados
        const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' });
        if (!matrix.length) {
          toast.error('El archivo está vacío');
          return;
        }
        const grid = matrix.map((r) => (Array.isArray(r) ? r.map((c) => cleanCell(c)) : []));

        // Arma filas a partir de un mapeo columna → campo
        const parseWithMapping = (map: Record<number, string>, startRow: number) => {
          const rows: Record<string, unknown>[] = [];
          let ignored = 0;
          for (let i = startRow; i < grid.length; i++) {
            const r = grid[i];
            const obj: Record<string, unknown> = {};
            let nonEmpty = 0;
            for (const [colStr, field] of Object.entries(map)) {
              const col = Number(colStr);
              obj[field] = r[col] ?? '';
              if (r[col]) nonEmpty++;
            }
            if (nonEmpty === 0) { ignored++; continue; }              // fila en blanco
            const codeLow = String(obj.code ?? '').toLowerCase();
            if (!obj.name && ['codigo', 'cod', 'code', 'articulo'].includes(codeLow)) { ignored++; continue; } // encabezado repetido
            // Normalización visible en la vista previa (el backend vuelve a limpiar)
            if (obj.code) obj.code = cleanCodeCell(obj.code);
            if (obj.barcode) obj.barcode = cleanCodeCell(obj.barcode);
            obj.name = obj.name ? cleanName(obj.name) : '';
            if (!obj.name && obj.code) obj.name = obj.code;           // sin columna de nombre: usa el código
            if (obj.name || obj.code) rows.push(obj);
            else ignored++;
          }
          return { rows, ignored };
        };

        // 1) Buscar fila de encabezados en las primeras 14 filas
        let headerIdx = -1;
        let mapping: Record<number, string> = {};
        for (let i = 0; i < Math.min(14, grid.length); i++) {
          const m = mapHeaders(grid[i]);
          if (m) { headerIdx = i; mapping = m; break; }
        }

        let parsed: Record<string, unknown>[] = [];
        let ignored = 0;
        let mappingDesc = '';
        let autoMode = false;

        if (headerIdx >= 0) {
          const attempt = parseWithMapping(mapping, headerIdx + 1);
          if (attempt.rows.length > 0) {
            parsed = attempt.rows;
            ignored = attempt.ignored;
            mappingDesc = Object.entries(mapping)
              .map(([col, field]) => `“${grid[headerIdx][Number(col)] || `columna ${Number(col) + 1}`}” → ${IMPORT_FIELD_LABEL[field] ?? field}`)
              .join(' · ');
          } else {
            // Los encabezados existen pero los datos están en otras columnas
            // (exportes con encabezado desplazado): detectamos por contenido.
            const det = detectColumnsByContent(grid, headerIdx + 1) ?? detectColumnsByContent(grid, 0);
            if (det) {
              mapping = { [det.code]: 'code', [det.name]: 'name' };
              const attempt2 = parseWithMapping(mapping, headerIdx + 1);
              if (attempt2.rows.length > 0) {
                parsed = attempt2.rows;
                ignored = attempt2.ignored;
                mappingDesc = `Encabezados desalineados: datos tomados por contenido (código → columna ${det.code + 1}, nombre → columna ${det.name + 1})`;
              }
            }
          }
        }

        if (parsed.length === 0) {
          // 2) Sin encabezados reconocibles: clasificar cada celda por contenido
          autoMode = true;
          for (const r of grid) {
            const cells = r.filter((c) => c !== '');
            if (cells.length === 0) { ignored++; continue; }
            const codeCell = cells.find(isCodeLike);
            const nameCell = cells.filter((c) => c !== codeCell).sort((a, b) => b.length - a.length)[0] ?? '';
            if (!codeCell && !nameCell) { ignored++; continue; }
            parsed.push({
              code: codeCell ? cleanCodeCell(codeCell) : '',
              name: nameCell ? cleanName(nameCell) : codeCell ?? '',
            });
          }
          mappingDesc = 'Detección automática por contenido (no se encontraron encabezados)';
        }

        if (parsed.length === 0) {
          toast.error('No se encontraron filas de productos en el archivo');
          return;
        }

        setImportRows(parsed);
        setImportInfo({ mapped: mappingDesc, ignored, autoMode });
        toast.info(`${parsed.length} filas listas · ${ignored} fila(s) vacía(s) ignorada(s)`);
      } catch {
        toast.error('No se pudo leer el archivo. Usá CSV o Excel.');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async function runImport(updateExisting: boolean) {
    if (!importRows.length) return;
    setImporting(true);
    try {
      const res = await api<{ created: number; updated: number; skipped: number; duplicatesInFile: number; errors: { row: number; code?: string; message: string }[] }>(
        '/products/import',
        { method: 'POST', body: { rows: importRows, updateExisting } }
      );
      const extra = [
        `${res.created} creados`,
        res.updated ? `${res.updated} actualizados` : '',
        res.errors.length ? `${res.errors.length} con error` : '',
        res.skipped ? `${res.skipped} filas vacías ignoradas` : '',
        res.duplicatesInFile ? `${res.duplicatesInFile} duplicados en el archivo omitidos` : '',
      ].filter(Boolean).join(', ');
      toast.success(`Importación: ${extra}`);
      if (res.errors.length > 0) {
        exportCSV('errores-importacion.csv', ['Fila', 'Código', 'Error'], res.errors.map((e) => [e.row, e.code ?? '', e.message]));
      }
      setImportOpen(false);
      setImportRows([]);
      setImportInfo(null);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  function doExport() {
    exportCSV(
      'productos.csv',
      ['Código', 'Barras', 'Nombre', 'Marca', 'Categoría', 'Unidad', 'Stock mín.', 'Costo', 'Precio ref.', 'Activo'],
      rows.map((p) => [p.code, p.barcode, p.name, p.brand, p.category_name, p.unit, p.min_stock, p.cost, p.reference_price, p.is_active ? 'SI' : 'NO'])
    );
  }

  const columns: Column<Product>[] = [
    { key: 'code', label: 'Código', sortable: true, render: (p) => <span className="font-mono text-xs font-semibold text-slate-600">{p.code}</span> },
    { key: 'name', label: 'Nombre', sortable: true, render: (p) => (
      <div>
        <div className="font-medium text-slate-700">{p.name}</div>
        {p.brand && <div className="text-xs text-slate-400">{p.brand}</div>}
      </div>
    ) },
    { key: 'barcode', label: 'Barras', render: (p) => <span className="font-mono text-xs text-slate-400">{p.barcode ?? '—'}</span> },
    { key: 'category_name', label: 'Categoría', sortable: true, render: (p) => p.category_name ?? '—' },
    { key: 'unit', label: 'Unidad', render: (p) => UNIT_LABELS[p.unit] ?? p.unit },
    { key: 'min_stock', label: 'Mín.', align: 'right', render: (p) => fmtQty(p.min_stock) },
    { key: 'cost', label: 'Costo', align: 'right', render: (p) => fmtMoney(p.cost) },
    { key: 'is_active', label: 'Estado', render: (p) =>
      p.is_active ? <Badge color="green">Activo</Badge> : <Badge color="gray">Inactivo</Badge>
    },
    { key: 'actions', label: '', align: 'right', render: (p) => (
      <div className="flex justify-end gap-1">
        <Button
          size="sm" variant="ghost"
          onClick={(e) => { e.stopPropagation(); openLabels(p); }}
          title={p.barcode ? 'Imprimir etiquetas de código de barras' : 'Sin EAN-13: generá uno en Editar producto'}
        >
          🖨
        </Button>
        {can('products.write') && (
          <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); openEdit(p); }}>Editar</Button>
        )}
        {can('products.write') && (
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); toggleActive(p); }}>
            {p.is_active ? 'Desactivar' : 'Activar'}
          </Button>
        )}
      </div>
    ) },
  ];

  return (
    <div>
      <PageHeader
        title="Productos"
        subtitle={`${total} productos en el catálogo`}
        actions={
          <>
            <Button variant="secondary" onClick={doExport}>⬇ Exportar CSV</Button>
            {can('products.write') && <Button variant="secondary" onClick={() => setImportOpen(true)}>⬆ Importar</Button>}
            {can('products.write') && <Button onClick={openNew}>+ Nuevo producto</Button>}
          </>
        }
      />

      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Buscar por nombre, código, marca o barras…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            className="min-w-[220px] flex-1"
          />
          <Button
            variant="secondary"
            onClick={() => setSearchScanOpen(true)}
            title="Escanear un código de barras con la cámara para localizar el producto"
            type="button"
          >
            📷
          </Button>
          <Select value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setPage(1); }} className="w-44">
            <option value="">Todas las categorías</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select value={active} onChange={(e) => { setActive(e.target.value); setPage(1); }} className="w-36">
            <option value="true">Activos</option>
            <option value="false">Inactivos</option>
            <option value="">Todos</option>
          </Select>
        </div>
      </Card>

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(p) => p.id}
          onRowClick={openDetail}
          loading={loading}
          pageSize={15}
          total={total}
          page={page}
          onPageChange={setPage}
          emptyTitle="No hay productos"
          emptyHint={q ? `Sin resultados para “${q}”` : 'Cargá tu catálogo manualmente o importá un archivo'}
          emptyAction={can('products.write') ? <Button size="sm" onClick={openNew}>+ Cargar producto</Button> : undefined}
        />
      </Card>

      {/* Escáner de búsqueda del listado: localiza el producto por sus barras */}
      {searchScanOpen && (
        <CameraScanner
          hint="Buscar producto por código de barras"
          onScan={(code) => void handleScanFind(code)}
          onClose={() => setSearchScanOpen(false)}
        />
      )}

      {/* Modal alta/edición */}
      <Modal
        open={modalOpen}
        onClose={() => { setScanOpen(false); setModalOpen(false); }}
        title={form.id ? `Editar producto ${form.code}` : 'Nuevo producto'}
        width="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button>
            <Button loading={saving} onClick={save}>{form.id ? 'Guardar cambios' : 'Crear producto'}</Button>
          </>
        }
      >
        {!form.id && duplicates.length > 0 && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <strong>Posibles duplicados:</strong> ya existen productos con nombre similar.
            <ul className="mt-1 list-inside list-disc text-xs">
              {duplicates.map((d) => <li key={d.id}>{d.code} — {d.name}</li>)}
            </ul>
          </div>
        )}
        <FormRow cols={2}>
          <Field label="Código interno" required>
            <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </Field>
          <Field label="Código de barras" hint="Opcional, para lector">
            <div className="flex gap-2">
              <Input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} />
              <Button
                variant="secondary"
                loading={genBusy}
                onClick={generateBarcode}
                title="Generar código de barras EAN-13 único"
                type="button"
              >
                ✨
              </Button>
              <Button
                variant="secondary"
                onClick={() => setScanOpen(true)}
                title="Escanear con cámara"
                type="button"
              >
                📷
              </Button>
            </div>
            {scanOpen && (
              <CameraScanner
                hint="Escanear código del producto"
                onScan={(code) => {
                  setForm((f) => ({ ...f, barcode: code }));
                  toast.success(`Código de barras leído: ${code}`);
                  setScanOpen(false);
                }}
                onClose={() => setScanOpen(false)}
              />
            )}
          </Field>
          <Field label="Nombre" required className="sm:col-span-2">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Marca">
            <Input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
          </Field>
          <Field label="Categoría">
            <Select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
              <option value="">Sin categoría</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Unidad de medida">
            <Select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
              {Object.entries(UNIT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Stock mínimo" hint="Dispara alertas de stock bajo">
            <Input type="number" min="0" step="0.001" value={form.minStock} onChange={(e) => setForm({ ...form, minStock: e.target.value })} />
          </Field>
          {can('products.write') && (
            <>
              <Field label="Costo" hint="Opcional">
                <Input type="number" min="0" step="0.01" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
              </Field>
              <Field label="Precio de referencia" hint="Opcional">
                <Input type="number" min="0" step="0.01" value={form.referencePrice} onChange={(e) => setForm({ ...form, referencePrice: e.target.value })} />
              </Field>
            </>
          )}
          <Field label="Descripción" className="sm:col-span-2">
            <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
        </FormRow>
      </Modal>

      {/* Modal detalle con stock por ubicación */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.product.name ?? ''} width="md">
        {detail && (
          <div>
            <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
              <div><span className="text-slate-400">Código:</span> <span className="font-mono">{detail.product.code}</span></div>
              <div><span className="text-slate-400">Marca:</span> {detail.product.brand ?? '—'}</div>
              <div><span className="text-slate-400">Unidad:</span> {UNIT_LABELS[detail.product.unit]}</div>
              <div><span className="text-slate-400">Stock mínimo:</span> {fmtQty(detail.product.min_stock)}</div>
            </div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Stock por ubicación</h4>
            <table className="w-full text-sm">
              <tbody>
                {detail.stock.map((s) => (
                  <tr key={s.location_id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 text-slate-600">{s.location_name}</td>
                    <td className="py-2 text-right font-semibold">{fmtQty(s.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      {/* Modal etiquetas de código de barras (mejora 12) */}
      <Modal
        open={!!labelsTarget}
        onClose={() => setLabelsTarget(null)}
        title={`Etiquetas de barras · ${labelsTarget?.name ?? ''}`}
        width="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setLabelsTarget(null)}>Cerrar</Button>
            <Button
              disabled={!labelsTarget?.barcode}
              onClick={printLabels}
              title="Manda la hoja completa a la impresora (etiquetas 38×21 mm)"
            >
              🖨 Imprimir hoja
            </Button>
          </>
        }
      >
        {labelsTarget && (
          <div>
            {!labelsTarget.barcode ? (
              <div className="rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
                <p className="font-semibold">Este producto no tiene código de barras interno (EAN-13).</p>
                <p className="mt-1 text-xs">
                  Entra a <strong>Editar</strong> en la fila y tocá el botón ✨ <em>Generar EAN-13</em>,
                  guardá el producto y volvé acá para imprimir las etiquetas. Así el código impreso
                  queda grabado en el sistema y confiable para escanear.
                </p>
              </div>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-end gap-3">
                  <Field label="Cantidad de etiquetas">
                    <Input
                      type="number" min="1" max="120" className="w-28"
                      value={labelCopies}
                      onChange={(e) => setLabelCopies(e.target.value)}
                    />
                  </Field>
                  <div className="text-xs text-slate-400">
                    Hoja de etiquetas 38×21 mm (11 por hoja A4 aprox.). Tocá Imprimir y elegí la impresora de etiquetas.
                  </div>
                </div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Vista previa</p>
                <div
                  id="label-preview-grid"
                  className="flex flex-wrap gap-1"
                  style={{ maxHeight: 320, overflow: 'auto' }}
                >
                  {Array.from({ length: Math.min(Math.max(parseInt(labelCopies, 10) || 12, 1), 120) }).map((_, i) => (
                    <div
                      key={i}
                      className="flex flex-col items-center justify-center overflow-hidden border border-dashed border-slate-300 p-1 text-center"
                      style={{ width: '38mm', height: '21mm' }}
                    >
                      <div className="truncate text-[10px] font-bold leading-tight text-slate-800">{labelsTarget.name}</div>
                      {labelsTarget.brand && <div className="text-[8px] text-slate-500">{labelsTarget.brand}</div>}
                      <div className="font-mono text-[8px] text-slate-500">{labelsTarget.code}</div>
                      {labelsTarget.barcode && (
                        <Barcode value={labelsTarget.barcode} format="EAN13" height={26} width={1.1} displayValue />
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      {/* Modal importación */}
      <Modal
        open={importOpen}
        onClose={() => { setImportOpen(false); setImportRows([]); setImportInfo(null); }}
        title="Importar productos"
        width="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => { setImportOpen(false); setImportRows([]); setImportInfo(null); }}>Cancelar</Button>
            <Button
              variant="secondary"
              disabled={importing || importRows.length === 0}
              onClick={() => runImport(true)}
            >
              Crear y actualizar
            </Button>
            <Button loading={importing} disabled={importRows.length === 0} onClick={() => runImport(false)}>
              Solo crear ({importRows.length})
            </Button>
          </>
        }
      >
        <div
          className="cursor-pointer rounded-xl border-2 border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 hover:border-brand-400 hover:text-brand-600"
          onClick={() => fileRef.current?.click()}
        >
          📄 Hacé clic para elegir un archivo <strong>Excel (.xlsx) o CSV</strong>
          <div className="mt-1 text-xs text-slate-400">
            Columnas reconocidas: codigo, nombre/descripción, barras, marca, categoria, unidad, stock minimo, costo, precio
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />
        </div>
        {importing && <div className="mt-3 flex justify-center"><Spinner /></div>}
        {importInfo && !importing && (
          <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
            <div>
              <strong>{importInfo.autoMode ? 'Clasificación automática' : 'Columnas detectadas'}:</strong> {importInfo.mapped}
            </div>
            {importInfo.ignored > 0 && (
              <div className="mt-1">{importInfo.ignored} fila(s) vacía(s) o de relleno fueron ignoradas.</div>
            )}
          </div>
        )}
        {importRows.length > 0 && !importing && (
          <div className="mt-3 max-h-56 overflow-auto rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-400">
                <tr>
                  <th className="px-2 py-1.5 text-left">#</th>
                  <th className="px-2 py-1.5 text-left">Código</th>
                  <th className="px-2 py-1.5 text-left">Nombre</th>
                  <th className="px-2 py-1.5 text-left">Marca</th>
                  <th className="px-2 py-1.5 text-left">Categoría</th>
                </tr>
              </thead>
              <tbody>
                {importRows.slice(0, 50).map((r, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-2 py-1 text-slate-400">{i + 1}</td>
                    <td className="px-2 py-1 font-mono">{String(r.code ?? '')}</td>
                    <td className="px-2 py-1">{String(r.name ?? '')}</td>
                    <td className="px-2 py-1">{String(r.brand ?? '')}</td>
                    <td className="px-2 py-1">{String(r.category ?? '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {importRows.length > 50 && <div className="px-2 py-1 text-center text-slate-400">… y {importRows.length - 50} filas más</div>}
          </div>
        )}
      </Modal>
    </div>
  );
}
