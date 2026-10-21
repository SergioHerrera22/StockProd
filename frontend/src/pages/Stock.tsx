import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, qs } from '../lib/api';
import { exportCSV, fmtMoney, fmtQty } from '../lib/format';
import type { Location, StockRow } from '../types';
import { Badge, Button, Card, Input, PageHeader, Select, Tabs } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';

type Tab = 'all' | 'low' | 'out';

export default function StockPage() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [locationId, setLocationId] = useState('');
  const [rows, setRows] = useState<StockRow[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const filter = tab === 'all' ? 'all' : tab === 'low' ? 'low' : 'out';
      const res = await api<{ products: StockRow[]; locations: Location[] }>(
        `/stock${qs({ q, locationId, filter, limit: 300 })}`
      );
      setRows(res.products);
      setLocations(res.locations);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, locationId, tab]);

  useEffect(() => { void load(); }, [load]);

  const selectedLocation = locations.find((l) => String(l.id) === locationId);
  const showColumns = locationId === '' ? locations : locations.filter((l) => String(l.id) === locationId);

  const columns: Column<StockRow>[] = useMemo(() => [
    {
      key: 'name',
      label: 'Producto',
      sortable: true,
      render: (p) => (
        <div>
          <div className="font-medium text-slate-700">{p.name}</div>
          <div className="text-xs text-slate-400">{p.code}{p.brand ? ` · ${p.brand}` : ''}</div>
        </div>
      ),
    },
    ...showColumns.map((loc) => ({
      key: `loc_${loc.id}`,
      label: loc.code,
      align: 'right' as const,
      value: (p: StockRow) => Number(p.by_location?.[loc.code] ?? 0),
      render: (p: StockRow) => {
        const qty = Number(p.by_location?.[loc.code] ?? 0);
        return <span className={qty === 0 ? 'text-slate-300' : 'font-semibold text-slate-700'}>{fmtQty(qty)}</span>;
      },
    })),
    {
      key: 'total_qty',
      label: selectedLocation ? 'Stock' : 'Total',
      sortable: true,
      align: 'right' as const,
      render: (p) => {
        const total = selectedLocation ? Number(p.by_location?.[selectedLocation.code] ?? 0) : p.total_qty;
        const min = Number(p.min_stock);
        return total <= 0
          ? <Badge color="red">Sin stock</Badge>
          : total <= min
            ? <Badge color="amber">{fmtQty(total)} · bajo</Badge>
            : <span className="font-semibold text-slate-700">{fmtQty(total)}</span>;
      },
    },
    { key: 'min_stock', label: 'Mín.', align: 'right', render: (p) => fmtQty(p.min_stock) },
    { key: 'unit', label: 'Unidad', render: (p) => p.unit?.toLowerCase() },
    ...(selectedLocation
      ? []
      : [{
          key: 'cost',
          label: 'Valor',
          align: 'right' as const,
          render: (p: StockRow) => (p.cost ? fmtMoney(Number(p.cost) * p.total_qty) : '—'),
        }]),
  ], [showColumns, selectedLocation]);

  const lowCount = rows.filter((p) => p.total_qty > 0 && p.total_qty <= Number(p.min_stock)).length;
  const outCount = rows.filter((p) => p.total_qty === 0).length;

  return (
    <div>
      <PageHeader
        title="Stock"
        subtitle="Existencias por ubicación y consolidadas"
        actions={
          <>
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="w-48">
              <option value="">Consolidado (todas)</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
            <Button
              variant="secondary"
              onClick={() =>
                exportCSV(
                  'stock.csv',
                  ['Código', 'Producto', 'Marca', ...showColumns.map((l) => l.name), 'Total', 'Mínimo'],
                  rows.map((p) => [
                    p.code, p.name, p.brand,
                    ...showColumns.map((l) => Number(p.by_location?.[l.code] ?? 0)),
                    p.total_qty, p.min_stock,
                  ])
                )
              }
            >
              ⬇ Exportar
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Tabs
          value={tab}
          onChange={(t) => setTab(t)}
          tabs={[
            { key: 'all', label: 'Todos' },
            { key: 'low', label: 'Stock bajo', badge: lowCount },
            { key: 'out', label: 'Sin stock', badge: outCount },
          ]}
        />
        <Input
          placeholder="Buscar producto…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="min-w-[200px] flex-1 sm:max-w-xs"
        />
      </div>

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(p) => p.id}
          loading={loading}
          pageSize={25}
          emptyTitle="No hay productos"
          emptyHint="Probá cambiar los filtros o cargá productos en el catálogo"
        />
      </Card>
    </div>
  );
}
