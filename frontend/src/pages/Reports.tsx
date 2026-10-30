import { useEffect, useState, type ReactNode } from 'react';
import { api, qs } from '../lib/api';
import { exportCSV, fmtDateTime, fmtQty, todayISO } from '../lib/format';
import type { Location } from '../types';
import { Button, Card, Input, PageHeader, Select } from '../components/ui';
import { Loading } from '../components/ui';
import { useToast } from '../components/Toast';

type ReportKey =
  | 'stock-by-location' | 'low-stock' | 'out-of-stock' | 'in-out-period'
  | 'movements-by-user' | 'deliveries-by-location' | 'pending-transfers'
  | 'inventory-differences' | 'rotation' | 'debts-customers' | 'low-stock-by-supplier';

interface ReportDef {
  key: ReportKey;
  title: string;
  icon: string;
  desc: string;
  needsPeriod?: boolean;
  needsLocation?: boolean;
  needsSupplier?: boolean;
  headers: (locs: Location[]) => string[];
  rowToCells: (row: Record<string, unknown>, locs: Location[]) => unknown[];
  renderCell?: (col: string, row: Record<string, unknown>) => ReactNode;
}

const REPORTS: ReportDef[] = [
  {
    key: 'stock-by-location',
    title: 'Stock por producto y ubicación',
    icon: '🏷️',
    desc: 'Existencias actuales por ubicación',
    needsLocation: true,
    headers: () => ['Código', 'Producto', 'Marca', 'Ubicación', 'Cantidad', 'Stock mín.'],
    rowToCells: (r) => [r.code, r.product_name, r.brand, r.location_name, fmtQty(Number(r.quantity)), fmtQty(Number(r.min_stock))],
  },
  {
    key: 'low-stock',
    title: 'Productos con bajo stock',
    icon: '⚠️',
    desc: 'Por debajo del mínimo configurado',
    needsLocation: true,
    headers: () => ['Código', 'Producto', 'Marca', 'Stock total', 'Mínimo'],
    rowToCells: (r) => [r.code, r.name, r.brand, Number(r.total_qty), r.min_stock],
  },
  {
    key: 'out-of-stock',
    title: 'Productos sin existencias',
    icon: '🚫',
    desc: 'Active products sin stock',
    needsLocation: true,
    headers: () => ['Código', 'Producto', 'Marca', 'Stock total', 'Mínimo'],
    rowToCells: (r) => [r.code, r.name, r.brand, Number(r.total_qty), r.min_stock],
  },
  {
    key: 'in-out-period',
    title: 'Entradas y salidas por período',
    icon: '🔄',
    desc: 'Unidades y cantidad de movimientos por ubicación',
    needsPeriod: true,
    headers: () => ['Ubicación', 'Entradas (u.)', 'Entradas (mov.)', 'Salidas (u.)', 'Salidas (mov.)'],
    rowToCells: (r) => [r.location_name, Number(r.entradas), Number(r.entradas_cant), Number(r.salidas), Number(r.salidas_cant)],
  },
  {
    key: 'movements-by-user',
    title: 'Movimientos por usuario',
    icon: '👤',
    desc: 'Quién registró cada operación',
    needsPeriod: true,
    headers: () => ['Usuario', 'Tipo', 'Movimientos', 'Unidades'],
    rowToCells: (r) => [r.user_name, r.type, Number(r.cant), Number(r.unidades)],
  },
  {
    key: 'deliveries-by-location',
    title: 'Entregas por sucursal',
    icon: '📦',
    desc: 'Confirmadas, borradores y unidades entregadas',
    needsPeriod: true,
    headers: () => ['Ubicación', 'Confirmadas', 'Borradores', 'Anuladas', 'Unidades entregadas'],
    rowToCells: (r) => [r.location_name, Number(r.confirmadas), Number(r.borradores), Number(r.anuladas), Number(r.unidades_entregadas)],
  },
  {
    key: 'pending-transfers',
    title: 'Transferencias pendientes',
    icon: '🚚',
    desc: 'Mercadería en tránsito sin recibir',
    headers: () => ['N°', 'Origen', 'Destino', 'Productos', 'Unidades', 'Enviada'],
    rowToCells: (r) => [r.number, r.origin_name, r.destination_name, Number(r.line_count), Number(r.units), fmtDateTime(r.created_at as string)],
  },
  {
    key: 'inventory-differences',
    title: 'Diferencias de inventario',
    icon: '📋',
    desc: 'Ajustes aplicados en recuentos físicos',
    needsPeriod: true,
    headers: () => ['Inventario', 'Ubicación', 'Fecha', 'Producto', 'Stock sistema', 'Contado'],
    rowToCells: (r) => [r.count_number, r.location_name, fmtDateTime(r.applied_at as string), r.product_name, Number(r.system_quantity), Number(r.counted_quantity)],
  },
  {
    key: 'rotation',
    title: 'Rotación de productos',
    icon: '📊',
    desc: 'Qué se mueve por sucursal (ventas y transferencias) para decidir traslados y compras',
    needsPeriod: true,
    headers: (locs) => [
      'Código', 'Producto',
      ...locs.map((l) => l.code || l.name),
      'Total', 'De venta', 'Transferido',
    ],
    rowToCells: (r, locs) => {
      const byLoc = new Map<string, number>(
        ((r.by_location as Array<{ loc: string; units: number }>) ?? []).map((x) => [x.loc, Number(x.units)])
      );
      return [
        r.code, r.name,
        ...locs.map((l) => byLoc.get(l.code || l.name) ?? 0),
        Number(r.total), Number(r.salidas_venta), Number(r.transferido),
      ];
    },
  },
  {
    key: 'low-stock-by-supplier',
    title: 'Stock bajo por proveedor',
    icon: '🏭',
    desc: 'Productos por debajo del stock mínimo, agrupados por última compra confirmada',
    needsLocation: true,
    needsSupplier: true,
    headers: () => ['Proveedor', 'Código', 'Producto', 'Marca', 'Ubicación', 'Stock disponible', 'Stock mínimo'],
    rowToCells: (r) => [r.supplier, r.code, r.name, r.brand, r.location_name, fmtQty(Number(r.total_qty)), fmtQty(Number(r.min_stock))],
  },
  {
    key: 'debts-customers',
    title: 'Deudas por cliente',
    icon: '🧾',
    desc: 'Órdenes de retiro activas agrupadas por cliente',
    headers: () => ['Cliente', 'Teléfono', 'Órdenes', 'Unidades pendientes', 'Más antigua'],
    rowToCells: (r) => [r.customer, r.customer_phone, Number(r.orders), Number(r.units_pending), fmtDateTime(r.oldest_created_at as string)],
  },
];

function escapeReportHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char] ?? char);
}

function writePrintableReport(
  target: Window,
  report: ReportDef,
  rows: Record<string, unknown>[],
  locations: Location[],
  filterSummary: string,
) {
  const headers = report.headers(locations);
  const body = rows.length
    ? rows.map((row) => {
        const cells = report.rowToCells(row, locations);
        return `<tr>${cells.map((cell) => `<td>${escapeReportHtml(cell)}</td>`).join('')}</tr>`;
      }).join('')
    : `<tr><td colspan="${headers.length}" class="empty">Sin datos para los filtros elegidos</td></tr>`;
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeReportHtml(report.title)}</title>
<style>
*{box-sizing:border-box}body{font:14px Arial,sans-serif;color:#1e293b;margin:28px}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:20px}
h1{font-size:21px;margin:0 0 6px}p{color:#64748b;margin:0}.meta{font-size:12px;color:#64748b;margin-top:8px}
button{border:0;border-radius:7px;background:#155e9a;color:white;padding:10px 16px;font-weight:600;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:9px 8px;border-bottom:1px solid #e2e8f0;text-align:left}
th{background:#f1f5f9;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
tr{break-inside:avoid}.empty{text-align:center;padding:30px;color:#64748b}
@media print{body{margin:12mm}button{display:none}header{margin-bottom:12px}}
</style></head><body>
<header><div><h1>${escapeReportHtml(report.title)}</h1><p>${escapeReportHtml(report.desc)}</p>
<div class="meta">Filtros: ${escapeReportHtml(filterSummary || 'Sin filtros')}<br>Generado: ${escapeReportHtml(new Date().toLocaleString('es-AR',{hourCycle:'h23'}))} · Registros: ${rows.length}</div></div>
<button onclick="window.print()">Imprimir reporte</button></header>
<table><thead><tr>${headers.map((h)=>`<th>${escapeReportHtml(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>
</body></html>`;
  target.document.open();
  target.document.write(html);
  target.document.close();
}

function writePrintableError(target: Window, message: string) {
  target.document.open();
  target.document.write(`<!doctype html><html lang="es"><meta charset="utf-8"><title>Error al generar reporte</title><body style="font:14px Arial;padding:32px"><h1>No se pudo generar el reporte</h1><p>${escapeReportHtml(message)}</p></body></html>`);
  target.document.close();
}

export default function Reports() {
  const toast = useToast();
  const [locations, setLocations] = useState<Location[]>([]);
  const [selected, setSelected] = useState<ReportDef | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [locationId, setLocationId] = useState('');
  const [suppliers, setSuppliers] = useState<{ id: number; name: string }[]>([]);
  const [supplier, setSupplier] = useState('');
  const [from, setFrom] = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 10); });
  const [to, setTo] = useState(todayISO);

  useEffect(() => {
    api<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations.filter((l) => l.is_active))).catch(() => {});
    api<{ suppliers: { id: number; name: string }[] }>('/reports/suppliers').then((r) => setSuppliers(r.suppliers)).catch(() => {});
  }, []);

  async function run(report: ReportDef) {
    // Abrimos la pestaña dentro del gesto del usuario para evitar bloqueadores de popups.
    const reportWindow = window.open('', '_blank');
    if (!reportWindow) toast.error('El navegador bloqueó la pestaña del reporte. Habilitá las ventanas emergentes para este sitio.');
    setSelected(report);
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (report.needsLocation && locationId) params.locationId = locationId;
      if (report.needsPeriod) { params.from = from; params.to = to; }
      if (report.needsSupplier && supplier) params.supplierId = supplier;
      const res = await api<{ rows: Record<string, unknown>[] }>(`/reports/${report.key}${qs(params)}`);
      setRows(res.rows);
      const filterSummary = [
        report.needsLocation ? `Ubicación: ${locations.find((l) => String(l.id) === locationId)?.name ?? 'Todas'}` : '',
        report.needsSupplier ? `Proveedor: ${suppliers.find((item) => String(item.id) === supplier)?.name ?? 'Todos'}` : '',
        report.needsPeriod ? `Período: ${from} a ${to}` : '',
      ].filter(Boolean).join(' · ');
      if (reportWindow) writePrintableReport(reportWindow, report, res.rows, locations, filterSummary);
    } catch (e) {
      const message = (e as Error).message;
      toast.error(message);
      if (reportWindow) writePrintableError(reportWindow, message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }

  function doExport() {
    if (!selected) return;
    exportCSV(
      `${selected.key}.csv`,
      selected.headers(locations),
      rows.map((r) => selected.rowToCells(r, locations))
    );
  }

  return (
    <div>
      <PageHeader title="Reportes" subtitle="Información para el control y la toma de decisiones" />

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((r) => (
          <button
            key={r.key}
            onClick={() => run(r)}
            className={`rounded-xl border p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-md ${
              selected?.key === r.key ? 'border-brand-500 bg-brand-50/60 ring-1 ring-brand-300' : 'border-slate-200 bg-white'
            }`}
          >
            <div className="text-2xl">{r.icon}</div>
            <div className="mt-1 font-semibold text-slate-700">{r.title}</div>
            <div className="text-xs text-slate-400">{r.desc}</div>
          </button>
        ))}
      </div>

      {selected && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
            <h3 className="font-semibold text-slate-700">{selected.icon} {selected.title}</h3>
            <div className="flex flex-wrap items-center gap-2">
              {selected.needsLocation && (
                <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="w-44">
                  <option value="">Todas las ubicaciones</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </Select>
              )}
              {selected.needsSupplier && (
                <Select value={supplier} onChange={(e) => setSupplier(e.target.value)} className="w-52">
                  <option value="">Todos los proveedores</option>
                  {suppliers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </Select>
              )}
              {selected.needsPeriod && (
                <div className="flex items-center gap-1 text-xs text-slate-400">
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" />
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" />
                </div>
              )}
              <Button size="sm" variant="secondary" onClick={() => run(selected)}>↻ Actualizar</Button>
              <Button size="sm" variant="secondary" onClick={doExport}>⬇ CSV</Button>
              <span className="text-xs text-slate-400">El reporte se abre en una pestaña independiente al generarlo.</span>
            </div>
          </div>

          {loading ? (
            <Loading />
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-400">Sin datos para los filtros elegidos</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                    {selected.headers(locations).map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      {selected!.headers(locations).map((h) => (
                        <td key={h} className="px-3 py-2">
                          {selected!.renderCell ? selected!.renderCell(h, r) : String(selected!.rowToCells(r, locations)[selected!.headers(locations).indexOf(h)] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
