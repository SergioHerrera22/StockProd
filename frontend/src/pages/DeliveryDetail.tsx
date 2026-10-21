import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDateTime, fmtQty } from '../lib/format';
import { useAuth } from '../store/auth';
import type { Delivery } from '../types';
import { Badge, Button, Card, Field, Input, Modal, Spinner, useConfirm } from '../components/ui';
import { DELIVERY_STATUS } from './Deliveries';
import { useToast } from '../components/Toast';

export default function DeliveryDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const can = useAuth((s) => s.can);

  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [loading, setLoading] = useState(true);
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ delivery: Delivery }>(`/deliveries/${id}`);
      setDelivery(res.delivery);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function confirmDraft() {
    if (!delivery) return;
    setSaving(true);
    try {
      await api(`/deliveries/${delivery.id}/confirm`, { method: 'POST' });
      toast.success('Entrega confirmada: stock descontado');
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function voidDelivery() {
    if (!delivery) return;
    setSaving(true);
    try {
      await api(`/deliveries/${delivery.id}/void`, { method: 'POST', body: { reason } });
      toast.success('Entrega anulada con movimientos compensatorios');
      setVoidOpen(false);
      setReason('');
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="flex justify-center py-16"><Spinner size="lg" /></div>;
  }
  if (!delivery) {
    return <p className="py-16 text-center text-slate-400">Entrega no encontrada</p>;
  }

  const status = DELIVERY_STATUS[delivery.status];
  const totalUnits = delivery.items.reduce((acc, i) => acc + Number(i.quantity), 0);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex items-center justify-between">
        <Button variant="secondary" onClick={() => navigate('/entregas')}>← Volver</Button>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => window.print()}>🖨 Imprimir comprobante</Button>
          {delivery.status === 'BORRADOR' && (
            <Button variant="success" loading={saving} onClick={confirmDraft}>✅ Confirmar entrega</Button>
          )}
          {delivery.status !== 'ANULADO' && can('deliveries.void') && (
            <Button variant="danger" onClick={() => setVoidOpen(true)}>Anular</Button>
          )}
        </div>
      </div>

      {/* Comprobante */}
      <Card className="print-area p-6">
        <div className="mb-4 flex items-start justify-between border-b border-slate-200 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-800 font-black text-amber-400">R</div>
              <div>
                <div className="font-bold text-brand-900">Robles Pinturerías</div>
                <div className="text-xs text-slate-400">Comprobante de entrega de mercadería</div>
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-lg font-bold text-brand-700">{delivery.number}</div>
            <Badge color={status.color}>{status.label}</Badge>
          </div>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <div><span className="text-slate-400">Fecha:</span> {fmtDateTime(delivery.created_at)}</div>
          <div><span className="text-slate-400">Sale de:</span> <strong>{delivery.location_name}</strong></div>
          <div><span className="text-slate-400">Factura ref.:</span> {delivery.invoice_number ?? '—'}</div>
          <div><span className="text-slate-400">Registró:</span> {delivery.created_by_name}</div>
          {delivery.confirmed_at && (
            <div><span className="text-slate-400">Confirmó:</span> {delivery.confirmed_by_name} · {fmtDateTime(delivery.confirmed_at)}</div>
          )}
          <div><span className="text-slate-400">Unidades:</span> <strong>{fmtQty(totalUnits)}</strong></div>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-y border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="py-2">Código</th>
              <th className="py-2">Producto</th>
              <th className="py-2 text-center">Facturado</th>
              <th className="py-2 text-right">Entregado</th>
            </tr>
          </thead>
          <tbody>
            {delivery.items.map((it) => (
              <tr key={it.id ?? it.product_id} className="border-b border-slate-100">
                <td className="py-2 font-mono text-xs">{it.code}</td>
                <td className="py-2 font-medium text-slate-700">{it.name}</td>
                <td className="py-2 text-center text-slate-400">{it.requested_quantity != null ? fmtQty(it.requested_quantity) : '—'}</td>
                <td className="py-2 text-right font-semibold">{fmtQty(it.quantity)} {(it.unit ?? '').toLowerCase()}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {delivery.notes && (
          <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
            <strong>Observaciones:</strong> {delivery.notes}
          </div>
        )}

        {delivery.status === 'ANULADO' && (
          <div className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            Entrega anulada. Los ajustes correspondientes quedaron registrados en el historial.
          </div>
        )}

        <div className="mt-8 hidden justify-between text-xs text-slate-400 print:flex">
          <span>Firma quien entrega: ____________________</span>
          <span>Firma quien recibe: ____________________</span>
        </div>
      </Card>

      {/* Anulación */}
      <Modal
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        title="Anular entrega"
        footer={
          <>
            <Button variant="secondary" onClick={() => setVoidOpen(false)}>Cancelar</Button>
            <Button variant="danger" loading={saving} disabled={reason.trim().length < 5} onClick={voidDelivery}>
              Anular con movimientos compensatorios
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-slate-500">
          La entrega <strong>{delivery.number}</strong> no se elimina: se marca como anulada y, si estaba confirmada,
          se generan movimientos compensatorios auditados que reponen el stock.
        </p>
        <Field label="Motivo" required hint="Mínimo 5 caracteres — queda registrado en auditoría">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej: error de carga, devolución total…" />
        </Field>
      </Modal>
    </div>
  );
}
