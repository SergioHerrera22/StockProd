import { useCallback, useEffect, useState } from 'react';
import { api, qs } from '../lib/api';
import { fmtDateTime, fmtQty } from '../lib/format';
import { useAuth } from '../store/auth';
import type { Entry, EntryItem, Location, StockRow } from '../types';
import {
  Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Textarea, useConfirm,
} from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { ProductPicker } from '../components/ProductPicker';
import { useToast } from '../components/Toast';

const ENTRY_STATUS: Record<Entry['status'], { label: string; color: 'amber' | 'green' | 'red' }> = {
  BORRADOR: { label: 'Borrador', color: 'amber' },
  CONFIRMADO: { label: 'Confirmada', color: 'green' },
  ANULADO: { label: 'Anulada', color: 'red' },
};

interface DraftLine {
  productId: number;
  code: string;
  name: string;
  quantity: number;
}

export default function Entries() {
  const can = useAuth((s) => s.can);
  const toast = useToast();
  const confirm = useConfirm();

  const [rows, setRows] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [locations, setLocations] = useState<Location[]>([]);

  const [detail, setDetail] = useState<Entry | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  // Nueva entrada
  const [newOpen, setNewOpen] = useState(false);
  const [newLocation, setNewLocation] = useState('');
  const [newType, setNewType] = useState('COMPRA');
  const [supplier, setSupplier] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ entries: Entry[]; total: number }>(
        `/entries${qs({ status, page, pageSize: 15 })}`
      );
      setRows(res.entries);
      setTotal(res.total);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, page]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations)).catch(() => {});
  }, []);

  function openNew() {
    setNewOpen(true);
    setLines([]);
    setSupplier(''); setNotes('');
    setNewLocation(String(locations[0]?.id ?? ''));
  }

  async function saveNew(confirmNow: boolean) {
    if (!newLocation) { toast.error('Elegí la ubicación de destino'); return; }
    if (!lines.length) { toast.error('Agregá al menos un producto'); return; }
    setCreating(true);
    try {
      const res = await api<{ id: number; number: string }>(`/entries${confirmNow ? '?confirm=true' : ''}`, {
        method: 'POST',
        body: {
          locationId: Number(newLocation),
          type: newType,
          supplier: supplier.trim() || null,
          notes: notes.trim() || null,
          items: lines.map((l) => ({
            productId: l.productId,
            quantity: l.quantity,
          })),
        },
      });
      toast.success(confirmNow ? `Entrada ${res.number} confirmada: stock actualizado` : `Borrador ${res.number} guardado`);
      setNewOpen(false);
      setLines([]);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function confirmDraft(entry: Entry) {
    setSaving(true);
    try {
      await api(`/entries/${entry.id}/confirm`, { method: 'POST' });
      toast.success(`Entrada ${entry.number} confirmada`);
      setDetail(null);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function voidEntry() {
    if (!detail) return;
    setSaving(true);
    try {
      await api(`/entries/${detail.id}/void`, { method: 'POST', body: { reason } });
      toast.success('Entrada anulada');
      setVoidOpen(false);
      setReason('');
      setDetail(null);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(entry: Entry) {
    try {
      const res = await api<{ entry: Entry }>(`/entries/${entry.id}`);
      setDetail(res.entry);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const columns: Column<Entry>[] = [
    { key: 'number', label: 'N°', render: (e) => <span className="font-mono font-semibold text-brand-700">{e.number}</span> },
    { key: 'created_at', label: 'Fecha', render: (e) => fmtDateTime(e.created_at) },
    { key: 'location_name', label: 'Destino', render: (e) => e.location_name },
    { key: 'type', label: 'Tipo', render: (e) => <Badge color="blue">{e.type}</Badge> },
    { key: 'supplier', label: 'Proveedor', render: (e) => e.supplier ?? '—' },
    { key: 'line_count', label: 'Productos', align: 'right', render: (e) => e.line_count ?? '—' },
    { key: 'status', label: 'Estado', render: (e) => {
      const s = ENTRY_STATUS[e.status];
      return <Badge color={s.color}>{s.label}</Badge>;
    } },
    { key: 'created_by_name', label: 'Usuario', render: (e) => e.created_by_name },
  ];

  return (
    <div>
      <PageHeader
        title="Entradas de mercadería"
        subtitle="Compras a proveedores, devoluciones y otros ingresos autorizados"
        actions={can('entries.write') && <Button onClick={openNew}>+ Nueva entrada</Button>}
      />

      <Card className="mb-4 p-3">
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-44">
          <option value="">Todos los estados</option>
          <option value="BORRADOR">Borradores</option>
          <option value="CONFIRMADO">Confirmadas</option>
          <option value="ANULADO">Anuladas</option>
        </Select>
      </Card>

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(e) => e.id}
          onRowClick={openDetail}
          loading={loading}
          pageSize={15}
          total={total}
          page={page}
          onPageChange={setPage}
          emptyTitle="No hay entradas"
          emptyHint="Registrá el primer ingreso de mercadería"
        />
      </Card>

      {/* Nueva entrada */}
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="Nueva entrada de mercadería"
        width="xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setNewOpen(false)}>Cancelar</Button>
            <Button variant="secondary" disabled={creating || !lines.length} onClick={() => saveNew(false)}>💾 Guardar borrador</Button>
            <Button variant="success" loading={creating} disabled={!lines.length} onClick={() => saveNew(true)}>
              ✅ Confirmar e ingresar stock
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Ubicación de destino" required>
            <Select value={newLocation} onChange={(e) => setNewLocation(e.target.value)}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          <Field label="Tipo de movimiento" required>
            <Select value={newType} onChange={(e) => setNewType(e.target.value)}>
              <option value="COMPRA">Compra a proveedor</option>
              <option value="DEVOLUCION">Devolución recibida</option>
              <option value="OTRO">Otro ingreso autorizado</option>
            </Select>
          </Field>
          <Field label="Proveedor / referencia">
            <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Opcional" />
          </Field>
        </div>

        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-semibold text-slate-600">Productos</h4>
            <Button size="sm" variant="secondary" onClick={() => setPickerOpen(true)}>+ Agregar producto</Button>
          </div>
          {lines.length === 0 ? (
            <p className="rounded-lg bg-slate-50 py-6 text-center text-sm text-slate-400">Sin productos todavía</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                  <th className="py-1.5">Producto</th>
                  <th className="py-1.5 text-center">Cantidad</th>
                  <th className="py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.productId} className="border-b border-slate-100">
                    <td className="py-1.5">
                      <div className="font-medium text-slate-700">{l.name}</div>
                      <div className="font-mono text-xs text-slate-400">{l.code}</div>
                    </td>
                    <td className="py-1.5 text-center">
                      <Input
                        type="number" min="0.001" step="0.001"
                        value={l.quantity}
                        onChange={(e) => setLines((prev) => prev.map((x) => x.productId === l.productId ? { ...x, quantity: Number(e.target.value) } : x))}
                        className="w-24 text-center"
                      />
                    </td>
                    <td className="py-1.5 text-right">
                      <Button size="lg" variant="ghost" className="!h-10 !w-10 !min-w-10 !p-0 text-xl leading-none" aria-label="Eliminar producto de la entrada" title="Eliminar producto" onClick={() => setLines((prev) => prev.filter((x) => x.productId !== l.productId))}>🗑</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <Field label="Observaciones" className="mt-4">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </Modal>

      <ProductPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        locationId={Number(newLocation)}
        onPick={(p: StockRow) =>
          setLines((prev) =>
            prev.some((l) => l.productId === p.id)
              ? prev.map((l) => l.productId === p.id ? { ...l, quantity: l.quantity + 1 } : l)
              : [...prev, { productId: p.id, code: p.code, name: p.name, quantity: 1 }]
          )
        }
      />

      {/* Detalle */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={`Entrada ${detail?.number ?? ''}`}
        width="lg"
        footer={
          detail?.status === 'BORRADOR' && can('entries.write') ? (
            <Button variant="success" loading={saving} onClick={() => confirmDraft(detail)}>✅ Confirmar e ingresar stock</Button>
          ) : detail?.status !== 'ANULADO' && can('entries.write') ? (
            <Button variant="danger" onClick={() => { setReason(''); setVoidOpen(true); }}>Anular</Button>
          ) : undefined
        }
      >
        {detail && (
          <div>
            <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
              <div><span className="text-slate-400">Destino:</span> <strong>{detail.location_name}</strong></div>
              <div><span className="text-slate-400">Tipo:</span> {detail.type}</div>
              <div><span className="text-slate-400">Proveedor:</span> {detail.supplier ?? '—'}</div>
              <div><span className="text-slate-400">Fecha:</span> {fmtDateTime(detail.created_at)}</div>
              <div className="col-span-2"><span className="text-slate-400">Registró:</span> {detail.created_by_name}</div>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-slate-200 text-left text-xs uppercase text-slate-400">
                  <th className="py-1.5">Producto</th>
                  <th className="py-1.5 text-right">Cantidad</th>
                </tr>
              </thead>
              <tbody>
                {(detail.items ?? []).map((it: EntryItem) => (
                  <tr key={it.id} className="border-b border-slate-100">
                    <td className="py-1.5">
                      <div className="font-medium text-slate-700">{it.name}</div>
                      <div className="font-mono text-xs text-slate-400">{it.code}</div>
                    </td>
                    <td className="py-1.5 text-right font-semibold">{fmtQty(it.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail.notes && <p className="mt-3 text-sm text-slate-500"><strong>Obs.:</strong> {detail.notes}</p>}
          </div>
        )}
      </Modal>

      {/* Anular */}
      <Modal
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        title="Anular entrada"
        width="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setVoidOpen(false)}>Cancelar</Button>
            <Button variant="danger" loading={saving} disabled={reason.trim().length < 5} onClick={voidEntry}>Anular</Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-slate-500">
          Si la entrada estaba confirmada, se generan movimientos compensatorios para revertir el stock.
        </p>
        <Field label="Motivo" required>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Modal>
    </div>
  );
}
