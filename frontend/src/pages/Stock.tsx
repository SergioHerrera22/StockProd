import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, qs } from '../lib/api';
import { exportCSV, fmtQty } from '../lib/format';
import { availableOf, type Location, type StockRow } from '../types';
import { Badge, Button, Card, Input, PageHeader, Select, Tabs, Modal } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';
import { useAuth } from '../store/auth';
import { useConfirm } from '../components/ui';


type Tab = 'all' | 'low' | 'out';

export default function StockPage() {
  const toast = useToast();
  const { user } = useAuth();
  const confirm = useConfirm();
  const isAdmin = user?.role === 'ADMIN';
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [locationId, setLocationId] = useState('');
  const [rows, setRows] = useState<StockRow[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dupOpen, setDupOpen] = useState(false);
  const [dupGroups, setDupGroups] = useState<Array<{ key: string; count: number; products: Array<{ id: number; code: string; name: string; brand: string | null; unit: string; is_active: boolean; total_qty: number }> }>>([]);
  const [dupLoading, setDupLoading] = useState(false);
  const [dupSelected, setDupSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);

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
  }, [q, locationId, tab]);

  useEffect(() => { void load(); }, [load]);

  const selectedLocation = locations.find((l) => String(l.id) === locationId);
  const showColumns = locationId === '' ? locations : locations.filter((l) => String(l.id) === locationId);

  const lowCount = rows.filter((p: StockRow) => p.total_qty > 0 && p.total_qty <= Number(p.min_stock)).length;
  const outCount = rows.filter((p: StockRow) => p.total_qty === 0).length;

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
      value: (p: StockRow) => availableOf(p, loc.code),
      render: (p: StockRow) => {
        const free = availableOf(p, loc.code);
        const phys = Number(p.by_location?.[loc.code] ?? 0);
        // Si hay stock prometido (reservado), la celda muestra lo LIBRE y
        // entre paréntesis lo reservado: el físico solo ya mentía.
        if (phys > free) {
          return (
            <span>
              <span className="font-semibold text-slate-800">{fmtQty(free)}</span>
              <span className="text-xs text-amber-600"> ({fmtQty(phys - free)} res.)</span>
            </span>
          );
        }
        return <span className={phys === 0 ? 'text-slate-300' : 'font-semibold text-slate-700'}>{fmtQty(phys)}</span>;
      },
    })),
    {
      key: 'total_qty',
      label: selectedLocation ? 'Stock' : 'Total',
      sortable: true,
      align: 'right' as const,
      render: (p) => {
        const total = selectedLocation
          ? Number(p.by_location?.[selectedLocation.code] ?? 0) - Number(p.by_reserved?.[selectedLocation.code] ?? 0)
          : availableOf(p);
        const min = Number(p.min_stock);
        return total <= 0
          ? <Badge color="red">Sin stock</Badge>
          : total <= min
            ? <Badge color="amber">{fmtQty(total)} · bajo</Badge>
            : <span className="font-semibold text-slate-700">{fmtQty(total)}</span>;
      },
    },
    { key: 'available', label: 'Físico', align: 'right', render: (p) => {
      const phys = selectedLocation
        ? Number(p.by_location?.[selectedLocation.code] ?? 0)
        : p.total_qty;
      const reserved = selectedLocation
        ? Number(p.by_reserved?.[selectedLocation.code] ?? 0)
        : Number(p.total_reserved ?? 0);
      if (phys > 0 && phys > reserved) {
        return (
          <span>
            <span className="text-slate-500">{fmtQty(phys)}</span>
            {reserved > 0 && <span className="text-xs text-amber-600"> ({fmtQty(reserved)} res.)</span>}
          </span>
        );
      }
      return <span className={phys === 0 ? 'text-slate-300' : 'text-slate-500'}>{fmtQty(phys)}</span>;
    } },
    { key: 'min_stock', label: 'Mín.', align: 'right', render: (p) => fmtQty(p.min_stock) },
    { key: 'unit', label: 'Unidad', render: (p) => p.unit?.toLowerCase() },
  ], [showColumns, selectedLocation]);

  async function scanDuplicates() {
    setDupLoading(true);
    try {
      const res = await api<{ groups: typeof dupGroups }>('/products/duplicates/scan');
      setDupGroups(res.groups);
      setDupSelected(new Set());
      setDupOpen(true);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDupLoading(false);
    }
  }

  async function bulkDelete() {
    if (!isAdmin || selected.size === 0) return;
    const ok = await confirm({
      title: 'Eliminar productos seleccionados',
      message: `Se eliminarán ${selected.size} producto(s). Solo se desactivarán (baja lógica) los que no tengan stock. Los productos con stock > 0 se omitirán.`,
      confirmLabel: 'Eliminar',
      danger: true,
    } as any);
    if (!(ok as any)) return;
    setDeleting(true);
    try {
      const res = await api<{ deleted: number; skipped: Array<{ id: number; reason: string }> }>('/products/bulk-delete', {
        method: 'POST',
        body: { ids: [...selected] },
      });
      const parts = [`${res.deleted} eliminado(s)`];
      if (res.skipped.length) parts.push(`${res.skipped.length} omitido(s) por stock o inexistente`);
      toast.success(parts.join(' · '));
      setSelected(new Set());
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  async function bulkDeleteFromDup() {
    if (!isAdmin || dupSelected.size === 0) return;
    const ok = await confirm({
      title: 'Eliminar duplicados seleccionados',
      message: `Se desactivarán los seleccionados (solo si no tienen stock). Los que tengan stock > 0 se omitirán.`,
      confirmLabel: 'Eliminar',
      danger: true,
    } as any);
    if (!(ok as any)) return;
    setDeleting(true);
    try {
      const res = await api<{ deleted: number; skipped: Array<{ id: number; reason: string }> }>('/products/bulk-delete', {
        method: 'POST',
        body: { ids: [...dupSelected] },
      });
      const parts = [`${res.deleted} eliminado(s)`];
      if (res.skipped.length) parts.push(`${res.skipped.length} omitido(s)`);
      toast.success(parts.join(' · '));
      setDupSelected(new Set());
      setDupOpen(false);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Stock"
        subtitle="Existencias por ubicación y consolidadas"
        actions={
          <>
            {isAdmin && (
              <Button variant="secondary" loading={dupLoading} onClick={() => void scanDuplicates()}>
                Detectar duplicados
              </Button>
            )}
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="w-48">
              <option value="">Consolidado (todas)</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
            <Button
              variant="secondary"
              onClick={() =>
                exportCSV(
                  'stock.csv',
                  ['Código', 'Producto', 'Marca', ...showColumns.map((l) => l.name), 'Disponible', 'Total', 'Mínimo'],
                  rows.map((p) => [
                    p.code, p.name, p.brand,
                    ...showColumns.map((l) => availableOf(p, l.code)),
                    availableOf(p), p.total_qty, p.min_stock,
                  ])
                )
              }
            >
              ⬇ Exportar
            </Button>
          </>
        }
      />

      {isAdmin && selected.size > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm">
          <span className="text-amber-800">{selected.size} producto(s) seleccionado(s)</span>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={deleting} onClick={() => setSelected(new Set())}>Cancelar</Button>
            <Button variant="danger" loading={deleting} onClick={() => void bulkDelete()}>Eliminar seleccionados</Button>
          </div>
        </div>
      )}

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
          selectable={isAdmin}
          selectedKeys={selected}
          onSelect={(keys) => setSelected(keys as Set<number>)}
        />
      </Card>

      <Modal
        open={dupOpen}
        onClose={() => { if (deleting) return; setDupOpen(false); }}
        title="Duplicados detectados por nombre"
        width="xl"
        footer={
          <>
            <Button variant="secondary" disabled={deleting} onClick={() => setDupOpen(false)}>Cerrar</Button>
            {isAdmin && (
              <Button variant="danger" loading={deleting} disabled={dupSelected.size === 0} onClick={() => void bulkDeleteFromDup()}>
                Eliminar seleccionados ({dupSelected.size})
              </Button>
            )}
          </>
        }
      >
        {dupGroups.length === 0 ? (
          <p className="text-sm text-slate-500">No se encontraron duplicados activos.</p>
        ) : (
          <div className="space-y-4">
            {dupGroups.map((g) => (
              <div key={g.key} className="rounded-lg border border-slate-200">
                <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
                  <div className="text-sm font-medium text-slate-700">Duplicados · {g.count} productos</div>
                </div>
                <div className="divide-y divide-slate-100">
                  {g.products.map((p) => (
                    <label key={p.id} className="flex items-center gap-3 px-3 py-2 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={dupSelected.has(p.id)}
                        onChange={() => {
                          const next = new Set(dupSelected);
                          if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                          setDupSelected(next);
                        }}
                        className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                        disabled={!isAdmin}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-slate-700 truncate">{p.name}</div>
                        <div className="text-xs text-slate-400">{p.code}{p.brand ? ` · ${p.brand}` : ''} · {p.unit.toLowerCase()}</div>
                      </div>
                      <div className="text-xs text-slate-500">
                        Stock: <span className={p.total_qty > 0 ? 'text-amber-600' : 'text-slate-400'}>{p.total_qty}</span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <p className="text-xs text-slate-400">Solo se pueden eliminar productos sin stock. Los que tienen stock &gt; 0 serán omitidos.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
