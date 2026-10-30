import { useCallback, useEffect, useState } from 'react';
import { api, qs, getDrivers } from '../lib/api';
import { fmtDateTime, fmtQty } from '../lib/format';
import { useAuth } from '../store/auth';
import type { Location, StockRow, Transfer, TransferItem } from '../types';
import {
  Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Textarea, useConfirm,
} from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { ProductPicker } from '../components/ProductPicker';
import { useToast } from '../components/Toast';

const TRANSFER_STATUS: Record<Transfer['status'], { label: string; color: 'blue' | 'green' | 'amber' | 'red' }> = {
  EN_TRANSITO: { label: 'En tránsito', color: 'blue' },
  RECIBIDO: { label: 'Recibida', color: 'green' },
  RECIBIDO_CON_DIF: { label: 'Con diferencias', color: 'amber' },
  ANULADO: { label: 'Anulada', color: 'red' },
};

interface DraftLine {
  productId: number;
  code: string;
  name: string;
  quantity: number;
  stockOrigin: number;
}

export default function Transfers() {
  const can = useAuth((s) => s.can);
  const toast = useToast();
  const confirm = useConfirm();

  const [rows, setRows] = useState<Transfer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [locations, setLocations] = useState<Location[]>([]);

  const [detail, setDetail] = useState<Transfer | null>(null);
  const [receiveQty, setReceiveQty] = useState<Record<number, string>>({});
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  // Nueva transferencia
  const [newOpen, setNewOpen] = useState(false);
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const [drivers, setDrivers] = useState<any[]>([]);
  const [driverUserId, setDriverUserId] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [deliveryObservations, setDeliveryObservations] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ transfers: Transfer[]; total: number }>(
        `/transfers${qs({ status, page, pageSize: 15 })}`
      );
      setRows(res.transfers);
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
    api<{ locations: Location[] }>('/locations')
      .then((r) => {
        setLocations(r.locations.filter((l) => l.is_active));
        setOrigin(String(r.locations.find((l) => l.type === 'DEPOSITO')?.id ?? r.locations[0]?.id ?? ''));
      })
      .catch(() => {});
    getDrivers().then((d) => setDrivers(d || [])).catch(() => {});
  }, []);

  function openNew() {
    setLines([]);
    setNotes('');
    setDriverUserId('');
    setDeliveryAddress('');
    setDueAt('');
    setDeliveryObservations('');
    setNewOpen(true);
  }

  async function createTransfer() {
    if (!origin || !destination) { toast.error('Elegí origen y destino'); return; }
    if (origin === destination) { toast.error('El origen y el destino deben ser distintos'); return; }
    if (!lines.length) { toast.error('Agregá al menos un producto'); return; }
    for (const l of lines) {
      if (l.quantity > l.stockOrigin) {
        toast.error(`Stock insuficiente de "${l.name}" en el origen (disponible ${fmtQty(l.stockOrigin)})`);
        return;
      }
    }
    setCreating(true);
    try {
      const res = await api<{ id: number; number: string }>('/transfers', {
        method: 'POST',
        body: {
          originLocationId: Number(origin),
          destinationLocationId: Number(destination),
          notes: notes.trim() || null,
          items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
          driverUserId: driverUserId ? Number(driverUserId) : null,
          deliveryAddress: deliveryAddress.trim() || null,
          dueAt: dueAt ? new Date(dueAt).toISOString() : null,
          deliveryObservations: deliveryObservations.trim() || null,
        },
      });
      toast.success(`Transferencia ${res.number} enviada: mercadería en tránsito`);
      setNewOpen(false);
      setLines([]);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function openDetail(t: Transfer) {
    try {
      const res = await api<{ transfer: Transfer }>(`/transfers/${t.id}`);
      setDetail(res.transfer);
      const map: Record<number, string> = {};
      for (const it of res.transfer.items ?? []) {
        map[it.id] = String(it.quantity_received ?? it.quantity_sent);
      }
      setReceiveQty(map);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function receive() {
    if (!detail) return;
    setSaving(true);
    try {
      const items = (detail.items ?? []).map((it) => ({
        itemId: it.id,
        quantityReceived: Number(receiveQty[it.id] ?? '0') || 0,
      }));
      const res = await api<{ status: string }>(`/transfers/${detail.id}/receive`, { method: 'POST', body: { items } });
      toast.success(res.status === 'RECIBIDO' ? 'Transferencia recibida completa' : 'Recepción registrada con diferencias');
      setDetail(null);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function voidTransfer() {
    if (!detail) return;
    setSaving(true);
    try {
      await api(`/transfers/${detail.id}/void`, { method: 'POST', body: { reason } });
      toast.success('Transferencia anulada: stock devuelto al origen');
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

  const columns: Column<Transfer>[] = [
    { key: 'number', label: 'N°', render: (t) => <span className="font-mono font-semibold text-brand-700">{t.number}</span> },
    { key: 'created_at', label: 'Fecha', render: (t) => fmtDateTime(t.created_at) },
    { key: 'origin_name', label: 'Origen', render: (t) => t.origin_name },
    { key: 'destination_name', label: 'Destino', render: (t) => t.destination_name },
    { key: 'line_count', label: 'Productos', align: 'right', render: (t) => t.line_count ?? '—' },
    { key: 'status', label: 'Estado', render: (t) => {
      const s = TRANSFER_STATUS[t.status];
      return <Badge color={s.color}>{s.label}</Badge>;
    } },
    { key: 'received_at', label: 'Recibida', render: (t) => (t.received_at ? fmtDateTime(t.received_at) : '—') },
  ];

  return (
    <div>
      <PageHeader
        title="Transferencias"
        subtitle="Movimientos entre sucursales y depósito, con trazabilidad completa"
        actions={can('transfers.write') && <Button onClick={openNew}>+ Nueva transferencia</Button>}
      />

      <Card className="mb-4 p-3">
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-48">
          <option value="">Todos los estados</option>
          <option value="EN_TRANSITO">En tránsito</option>
          <option value="RECIBIDO">Recibidas</option>
          <option value="RECIBIDO_CON_DIF">Con diferencias</option>
          <option value="ANULADO">Anuladas</option>
        </Select>
      </Card>

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(t) => t.id}
          onRowClick={openDetail}
          loading={loading}
          pageSize={15}
          total={total}
          page={page}
          onPageChange={setPage}
          emptyTitle="No hay transferencias"
          emptyHint="Registrá el primer envío entre ubicaciones"
        />
      </Card>

      {/* Nueva transferencia */}
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="Nueva transferencia"
        width="xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setNewOpen(false)}>Cancelar</Button>
            <Button loading={creating} disabled={!lines.length} onClick={createTransfer}>🚚 Enviar (descontar del origen)</Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Ubicación de origen" required>
            <Select value={origin} onChange={(e) => setOrigin(e.target.value)}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          <Field label="Ubicación de destino" required>
            <Select value={destination} onChange={(e) => setDestination(e.target.value)}>
              <option value="">Elegir…</option>
              {locations.filter((l) => String(l.id) !== origin).map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Chofer asignado">
            <Select value={driverUserId} onChange={(e) => setDriverUserId(e.target.value)}>
              <option value="">Sin asignar</option>
              {drivers.map((d: any) => (
                <option key={d.id} value={d.id}>{d.full_name || d.username}</option>
              ))}
            </Select>
          </Field>
          <Field label="Dirección / Destino entrega">
            <Input value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} placeholder="Opcional" />
          </Field>
          <Field label="Vencimiento">
            <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </Field>
        </div>
        <Field label="Observaciones para repartidor" className="mt-3">
          <Textarea rows={2} value={deliveryObservations} onChange={(e) => setDeliveryObservations(e.target.value)} />
        </Field>

        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-semibold text-slate-600">Productos (validados contra el stock del origen)</h4>
            <Button size="sm" variant="secondary" disabled={!destination} onClick={() => setPickerOpen(true)}>+ Agregar producto</Button>
          </div>
          {lines.length === 0 ? (
            <p className="rounded-lg bg-slate-50 py-6 text-center text-sm text-slate-400">Sin productos todavía</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                  <th className="py-1.5">Producto</th>
                  <th className="py-1.5 text-right">Stock origen</th>
                  <th className="py-1.5 text-center">Cantidad</th>
                  <th className="py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.productId} className={`border-b border-slate-100 ${l.quantity > l.stockOrigin ? 'bg-red-50' : ''}`}>
                    <td className="py-1.5">
                      <div className="font-medium text-slate-700">{l.name}</div>
                      <div className="font-mono text-xs text-slate-400">{l.code}</div>
                    </td>
                    <td className={`py-1.5 text-right ${l.quantity > l.stockOrigin ? 'font-bold text-red-600' : 'text-slate-500'}`}>
                      {fmtQty(l.stockOrigin)}
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
                      <Button size="lg" variant="ghost" className="!h-10 !w-10 !min-w-10 !p-0 text-xl leading-none" aria-label="Eliminar producto de la transferencia" title="Eliminar producto" onClick={() => setLines((prev) => prev.filter((x) => x.productId !== l.productId))}>🗑</Button>
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
        <p className="mt-2 text-xs text-slate-400">
          Al enviar se descuenta del origen. El destino recién suma el stock cuando confirma la recepción.
        </p>
      </Modal>

      <ProductPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        locationId={Number(origin)}
        onPick={(p: StockRow) =>
          setLines((prev) =>
            prev.some((l) => l.productId === p.id)
              ? prev.map((l) => l.productId === p.id ? { ...l, quantity: l.quantity + 1 } : l)
              : [...prev, { productId: p.id, code: p.code, name: p.name, quantity: 1, stockOrigin: Number(p.total_qty ?? 0) }]
          )
        }
      />

      {/* Detalle + recepción */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={`Transferencia ${detail?.number ?? ''}`}
        width="lg"
        footer={
          detail?.status === 'EN_TRANSITO' && can('transfers.receive') ? (
            <>
              {can('transfers.write') && (
                <Button variant="secondary" onClick={() => { setReason(''); setVoidOpen(true); }}>Anular</Button>
              )}
              <Button variant="success" loading={saving} onClick={receive}>✅ Confirmar recepción</Button>
            </>
          ) : undefined
        }
      >
        {detail && (
          <div>
            <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
              <div><span className="text-slate-400">Origen:</span> {detail.origin_name}</div>
              <div><span className="text-slate-400">Destino:</span> {detail.destination_name}</div>
              <div><span className="text-slate-400">Envió:</span> {detail.created_by_name} · {fmtDateTime(detail.created_at)}</div>
              <div><span className="text-slate-400">Estado:</span> <Badge color={TRANSFER_STATUS[detail.status].color}>{TRANSFER_STATUS[detail.status].label}</Badge></div>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-slate-200 text-left text-xs uppercase text-slate-400">
                  <th className="py-1.5">Producto</th>
                  <th className="py-1.5 text-right">Enviado</th>
                  <th className="py-1.5 text-right">Recibido</th>
                  {detail.status === 'EN_TRANSITO' && <th className="py-1.5 text-center">Recibe ahora</th>}
                </tr>
              </thead>
              <tbody>
                {(detail.items ?? []).map((it: TransferItem) => {
                  const sent = Number(it.quantity_sent);
                  const rec = it.quantity_received === null ? null : Number(it.quantity_received);
                  return (
                    <tr key={it.id} className="border-b border-slate-100">
                      <td className="py-1.5">
                        <div className="font-medium text-slate-700">{it.name}</div>
                        <div className="font-mono text-xs text-slate-400">{it.code}</div>
                      </td>
                      <td className="py-1.5 text-right">{fmtQty(sent)}</td>
                      <td className={`py-1.5 text-right ${rec !== null && rec < sent ? 'font-bold text-amber-600' : ''}`}>
                        {rec === null ? '—' : fmtQty(rec)}
                      </td>
                      {detail.status === 'EN_TRANSITO' && (
                        <td className="py-1.5 text-center">
                          <Input
                            type="number" min="0" max={sent} step="0.001"
                            value={receiveQty[it.id] ?? ''}
                            onChange={(e) => setReceiveQty((prev) => ({ ...prev, [it.id]: e.target.value }))}
                            className="w-24 text-center"
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {detail.status === 'EN_TRANSITO' && (
              <p className="mt-2 text-xs text-slate-400">
                Si recibís menos de lo enviado, la diferencia queda documentada y la transferencia pasa a "Con diferencias".
              </p>
            )}
            {detail.notes && <p className="mt-3 text-sm text-slate-500"><strong>Obs.:</strong> {detail.notes}</p>}
          </div>
        )}
      </Modal>

      {/* Anular */}
      <Modal
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        title="Anular transferencia"
        width="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setVoidOpen(false)}>Cancelar</Button>
            <Button variant="danger" loading={saving} disabled={reason.trim().length < 5} onClick={voidTransfer}>Anular</Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-slate-500">
          Solo se anulan transferencias en tránsito. El stock regresa a la ubicación de origen mediante movimientos auditados.
        </p>
        <Field label="Motivo" required>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Modal>
    </div>
  );
}
