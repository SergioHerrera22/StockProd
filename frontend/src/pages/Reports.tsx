import { useEffect, useState, type ReactNode } from 'react';
import { api, qs } from '../lib/api';
import { exportCSV, fmtDate, fmtDateTime, fmtMoney, fmtQty, todayISO } from '../lib/format';
import type { Location } from '../types';
import { Badge, Button, Card, Input, PageHeader, Select } from '../components/ui';
import { Loading } from '../components/ui';
import { useToast } from '../components/Toast';

type ReportKey =
  | 'stock-by-location' | 'low-stock' | 'out-of-stock' | 'in-out-period'
  | 'movements-by-user' | 'deliveries-by-location' | 'pending-transfers'
  | 'inventory-differences' | 'inventory-value';

interface ReportDef {
  key: ReportKey;
  title: string;
  icon: string;
  desc: string;
  needsPeriod?: boolean;
  needsLocation?: boolean;
  headers: (locs: Location[]) => string[];
  rowToCells: (row: Record<string, unknown>, locs: Location[]) => unknown[];
  renderCell?: (col: string, row: Record<string, unknown>) => ReactNode;
}

const REPORTS: ReportDef[] = [
  {
    key: 'stock-by-location',
    title: 'Stock por producto y ubicación',
    icon: '🏷️',
    desc: 'Existencias actuales con valorización por costo',
    needsLocation: true,
    headers: () => ['Código', 'Producto', 'Marca', 'Ubicación', 'Cantidad', 'Stock mín.', 'Valor'],
    rowToCells: (r) => [r.code, r.product_name, r.brand, r.location_name, Number(r.quantity), r.min_stock, Number(r.value)],
    renderCell: (col, row) => (col === 'Valor' ? fmtMoney(Number(row.value)) : col === 'Cantidad' || col === 'Stock mín.' ? fmtQty(Number(row[col === 'Cantidad' ? 'quantity' : 'min_stock'])) : String(row[col === 'Producto' ? 'product_name' : col === 'Marca' ? 'brand' : col === 'Ubicación' ? 'location_name' : 'code'] ?? '')),
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
    headers: () => ['N°', 'Origen', 'Destino', 'Líneas', 'Unidades', 'Enviada'],
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
    key: 'inventory-value',
    title: 'Valorización del inventario',
    icon: '💰',
    desc: 'Valor total según costos cargados',
    headers: () => ['Ubicación', 'Unidades', 'Valor'],
    rowToCells: (r) => [r.location_name, Number(r.units), Number(r.value)],
    renderCell: (col, row) => (col === 'Valor' ? fmtMoney(Number(row.value)) : col === 'Unidades' ? fmtQty(Number(row.units)) : String(row.location_name)),
  },
];

export default function Reports() {
  const toast = useToast();
  const [locations, setLocations] = useState<Location[]>([]);
  const [selected, setSelected] = useState<ReportDef | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [locationId, setLocationId] = useState('');
  const [from, setFrom] = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 10); });
  const [to, setTo] = useState(todayISO);

  useEffect(() => {
    api<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations.filter((l) => l.is_active))).catch(() => {});
  }, []);

  async function run(report: ReportDef) {
    setSelected(report);
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (report.needsLocation && locationId) params.locationId = locationId;
      if (report.needsPeriod) { params.from = from; params.to = to; }
      const res = await api<{ rows: Record<string, unknown>[] }>(`/reports/${report.key}${qs(params)}`);
      setRows(res.rows);
    } catch (e) {
      toast.error((e as Error).message);
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
              {selected.needsPeriod && (
                <div className="flex items-center gap-1 text-xs text-slate-400">
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" />
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" />
                </div>
              )}
              <Button size="sm" variant="secondary" onClick={() => run(selected)}>↻ Actualizar</Button>
              <Button size="sm" variant="secondary" onClick={doExport}>⬇ CSV</Button>
              <Button size="sm" variant="secondary" onClick={() => window.print()}>🖨 Imprimir</Button>
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
