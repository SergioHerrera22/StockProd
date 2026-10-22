import { useCallback, useEffect, useState } from 'react';
import { api, qs } from '../lib/api';
import { fmtDateTime, fmtQty } from '../lib/format';
import { useAuth } from '../store/auth';
import type { Location, StockCount } from '../types';
import {
  Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Textarea, useConfirm,
} from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';

const COUNT_STATUS: Record<StockCount['status'], { label: string; color: 'amber' | 'green' | 'red' }> = {
  ABIERTO: { label: 'Abierto', color: 'amber' },
  APLICADO: { label: 'Aplicado', color: 'green' },
  ANULADO: { label: 'Anulado', color: 'red' },
};

export default function Counts() {
  const can = useAuth((s) => s.can);
  const toast = useToast();
  const confirm = useConfirm();

  const [rows, setRows] = useState<StockCount[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [locations, setLocations] = useState<Location[]>([]);

  const [detail, setDetail] = useState<StockCount | null>(null);
  const [counted, setCounted] = useState<Record<number, string>>({});
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyReason, setApplyReason] = useState('');
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [saving, setSaving] = useState(false);

  // Nuevo inventario
  const [newOpen, setNewOpen] = useState(false);
  const [newLocation, setNewLocation] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ counts: StockCount[]; total: number }>(`/counts${qs({ page, pageSize: 15 })}`);
      setRows(res.counts);
      setTotal(res.total);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations.filter((l) => l.is_active))).catch(() => {});
  }, []);

  async function openDetail(c: StockCount) {
    try {
      const res = await api<{ count: StockCount }>(`/counts/${c.id}`);
      setDetail(res.count);
      const map: Record<number, string> = {};
      for (const it of res.count.items ?? []) {
        map[it.id] = it.counted_quantity === null ? '' : String(it.counted_quantity);
      }
      setCounted(map);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function createCount() {
    if (!newLocation) { toast.error('Elegí la ubicación'); return; }
    setCreating(true);
    try {
      const res = await api<{ id: number; number: string }>('/counts', {
        method: 'POST',
        body: { locationId: Number(newLocation), notes: newNotes.trim() || null },
      });
      toast.success(`Inventario ${res.number} creado`);
      setNewOpen(false);
      setNewNotes('');
      void load();
      void openDetail({ id: res.id } as StockCount);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function saveItems() {
    if (!detail) return;
    const items = (detail.items ?? [])
      .filter((it) => counted[it.id] !== '' && counted[it.id] !== undefined)
      .map((it) => ({ itemId: it.id, countedQuantity: Number(counted[it.id]) }));
    if (!items.length) { toast.warn('No hay cantidades cargadas para guardar'); return; }
    setSaving(true);
    try {
      await api(`/counts/${detail.id}/items`, { method: 'PUT', body: { items } });
      toast.success('Conteo guardado');
      void openDetail(detail);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function applyCount() {
    if (!detail) return;
    setSaving(true);
    try {
      const res = await api<{ adjustments: number }>(`/counts/${detail.id}/apply`, {
        method: 'POST',
        body: { reason: applyReason },
      });
      toast.success(`Inventario aplicado: ${res.adjustments} ajuste(s) generados`);
      setApplyOpen(false);
      setApplyReason('');
      setDetail(null);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function voidCount() {
    if (!detail) return;
    setSaving(true);
    try {
      await api(`/counts/${detail.id}/void`, { method: 'POST', body: { reason: voidReason.trim() } });
      toast.success('Inventario anulado');
      setVoidOpen(false);
      setVoidReason('');
      setDetail(null);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const columns: Column<StockCount>[] = [
    { key: 'number', label: 'N°', render: (c) => <span className="font-mono font-semibold text-brand-700">{c.number}</span> },
    { key: 'created_at', label: 'Fecha', render: (c) => fmtDateTime(c.created_at) },
    { key: 'location_name', label: 'Ubicación', render: (c) => c.location_name },
    { key: 'line_count', label: 'Productos', align: 'right', render: (c) => c.line_count ?? '—' },
    { key: 'counted_lines', label: 'Contados', align: 'right', render: (c) => c.counted_lines ?? '—' },
    { key: 'adjusted_lines', label: 'Ajustados', align: 'right', render: (c) => c.adjusted_lines ?? '—' },
    { key: 'status', label: 'Estado', render: (c) => {
      const s = COUNT_STATUS[c.status];
      return <Badge color={s.color}>{s.label}</Badge>;
    } },
    { key: 'created_by_name', label: 'Usuario', render: (c) => c.created_by_name },
  ];

  return (
    <div>
      <PageHeader
        title="Inventarios físicos"
        subtitle="Recuentos y ajustes auditados de stock"
        actions={can('counts.write') && <Button onClick={() => setNewOpen(true)}>+ Nuevo recuento</Button>}
      />

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(c) => c.id}
          onRowClick={openDetail}
          loading={loading}
          pageSize={15}
          total={total}
          page={page}
          onPageChange={setPage}
          emptyTitle="No hay inventarios"
          emptyHint="Creá un recuento físico para corregir diferencias"
        />
      </Card>

      {/* Nuevo inventario */}
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="Nuevo recuento de inventario"
        footer={
          <>
            <Button variant="secondary" onClick={() => setNewOpen(false)}>Cancelar</Button>
            <Button loading={creating} onClick={createCount}>Crear recuento</Button>
          </>
        }
      >
        <Field label="Ubicación" required>
          <Select value={newLocation} onChange={(e) => setNewLocation(e.target.value)}>
            <option value="">Elegir…</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <Field label="Notas" className="mt-3">
          <Textarea rows={2} value={newNotes} onChange={(e) => setNewNotes(e.target.value)} placeholder="Ej: recuento mensual de estantería A" />
        </Field>
        <p className="mt-2 text-xs text-slate-400">
          Se toma una fotografía del stock del sistema por producto. Luego cargás lo contado y, al aplicar,
          se generan los ajustes con motivo obligatorio.
        </p>
      </Modal>

      {/* Detalle / conteo */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail ? `Inventario ${detail.number} · ${detail.location_name}` : ''}
        width="xl"
        footer={
          detail?.status === 'ABIERTO' ? (
            <>
              {can('counts.write') && <Button variant="secondary" onClick={() => { setVoidReason(''); setVoidOpen(true); }}>Anular</Button>}
              {can('counts.write') && <Button variant="secondary" loading={saving} onClick={saveItems}>💾 Guardar conteo</Button>}
              {can('counts.apply') && <Button variant="success" onClick={() => { setApplyReason(''); setApplyOpen(true); }}>✅ Aplicar ajustes</Button>}
            </>
          ) : undefined
        }
      >
        {!detail ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : (
          <div className="max-h-[55vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                  <th className="py-1.5">Producto</th>
                  <th className="py-1.5 text-right">Sistema</th>
                  <th className="py-1.5 text-center">Contado</th>
                  <th className="py-1.5 text-right">Diferencia</th>
                </tr>
              </thead>
              <tbody>
                {(detail.items ?? []).map((it) => {
                  const val = counted[it.id];
                  const countedVal = val === undefined || val === '' ? null : Number(val);
                  const sys = Number(it.system_quantity);
                  const diff = countedVal === null ? null : countedVal - sys;
                  return (
                    <tr key={it.id} className="border-b border-slate-100">
                      <td className="py-1.5">
                        <div className="font-medium text-slate-700">{it.name}</div>
                        <div className="font-mono text-xs text-slate-400">{it.code}</div>
                      </td>
                      <td className="py-1.5 text-right text-slate-500">{fmtQty(sys)}</td>
                      <td className="py-1.5 text-center">
                        {detail.status === 'ABIERTO' ? (
                          <Input
                            type="number" min="0" step="0.001"
                            value={val ?? ''}
                            onChange={(e) => setCounted((prev) => ({ ...prev, [it.id]: e.target.value }))}
                            className="w-24 text-center"
                          />
                        ) : (
                          countedVal === null ? <span className="text-slate-300">—</span> : fmtQty(countedVal)
                        )}
                      </td>
                      <td className="py-1.5 text-right">
                        {diff === null
                          ? <span className="text-slate-300">—</span>
                          : diff === 0
                            ? <span className="text-slate-400">=</span>
                            : <span className={diff > 0 ? 'font-semibold text-emerald-600' : 'font-semibold text-red-600'}>
                                {diff > 0 ? '+' : ''}{fmtQty(diff)}
                              </span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      {/* Aplicar */}
      <Modal
        open={applyOpen}
        onClose={() => setApplyOpen(false)}
        title="Aplicar ajustes de inventario"
        width="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setApplyOpen(false)}>Cancelar</Button>
            <Button variant="success" loading={saving} disabled={applyReason.trim().length < 5} onClick={applyCount}>
              Aplicar y generar movimientos
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-slate-500">
          Los productos con diferencia se ajustarán al valor contado mediante movimientos auditados
          (saldo anterior y posterior registrados). Esta acción no se puede deshacer.
        </p>
        <Field label="Motivo del ajuste" required hint="Obligatorio, queda registrado">
          <Input value={applyReason} onChange={(e) => setApplyReason(e.target.value)} placeholder="Ej: roturas, faltantes de reposición…" />
        </Field>
      </Modal>

      {/* Anular */}
      <Modal
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        title="Anular inventario"
        width="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setVoidOpen(false)}>Cancelar</Button>
            <Button variant="danger" loading={saving} disabled={voidReason.trim().length < 5} onClick={voidCount}>
              Anular recuento
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-slate-500">
          El recuento quedará anulado y no generará ajustes de stock.
        </p>
        <Field label="Motivo de la anulación" required hint="Obligatorio, queda registrado">
          <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="Ej: se recounta en otra sucursal…" />
        </Field>
      </Modal>
    </div>
  );
}
