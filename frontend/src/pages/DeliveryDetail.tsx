import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  api, getDeliveryPendingDeliveries, checkDeliveryAvailability, confirmDeliveryWithAlternatives,
  rederiveDeliveryShortfalls,
} from '../lib/api';
import { fmtDateTime, fmtQty } from '../lib/format';
import { useAuth } from '../store/auth';
import type { Delivery, DeliveryPendingOrder } from '../types';
import { Badge, Button, Card, Field, Input, Modal, Spinner, useConfirm } from '../components/ui';
import { DerivationModal } from '../components/DerivationModal';
import { deliveryStatusStyle } from './Deliveries';
import { useToast } from '../components/Toast';
import Barcode from '../components/Barcode';

export default function DeliveryDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const can = useAuth((s) => s.can);

  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [pendingOrders, setPendingOrders] = useState<DeliveryPendingOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [deriving, setDeriving] = useState(false);
  const [availabilityItems, setAvailabilityItems] = useState<import('../types').DeliveryAvailabilityItem[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ delivery: Delivery }>(`/deliveries/${id}`);
      setDelivery(res.delivery);
      // Órdenes pendientes derivadas de esta entrega (una por sucursal de retiro)
      setPendingOrders(await getDeliveryPendingDeliveries(id!));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Confirmación unificada (mismo flujo que Nueva entrega):
   * 1. Verifica disponibilidad de la entrega en borrador.
   * 2. Sin faltantes -> confirma directo.
   *    Con faltantes -> modal para elegir sucursal de derivación por producto.
   * Nunca deriva "solo" a la mejor sucursal sin preguntar (comportamiento anterior).
   */
  async function confirmDraft() {
    if (!delivery || !id) return;
    if (delivery.is_pending_delivery) {
      await doConfirmDirect();
      return;
    }
    setSaving(true);
    try {
      const avail = await checkDeliveryAvailability(delivery.id);
      setSaving(false);
      if (avail.hasShortfalls) {
        // Pedir elección de sucursales antes de confirmar
        setAvailabilityItems(avail.items);
        setDeriving(true);
        return;
      }
      await doConfirmDirect();
    } catch (e) {
      toast.error((e as Error).message);
      setSaving(false);
    }
  }

  async function doConfirmDirect() {
    if (!delivery) return;
    setSaving(true);
    try {
      const res = await api<import('../lib/api').DeliveryConfirmResponse>(
        `/deliveries/${delivery.id}/confirm`, { method: 'POST' }
      );
      if (res.pendingDeliveries.length > 0) {
        toast.success(`Entrega ${res.deliveryNumber} confirmada parcialmente: ${res.pendingDeliveries.length} retiro(s) creado(s)`);
      } else {
        toast.success('Entrega confirmada: stock descontado');
      }
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  /** Confirmación con las sucursales elegidas en el modal de derivación */
  async function handleConfirmWithChoices(choices: import('../types').UserAlternativeChoice[]) {
    if (!delivery) return;
    setDeriving(false);
    setSaving(true);
    try {
      const res = await confirmDeliveryWithAlternatives({ choices }, delivery.id);
      if (res.pendingDeliveries.length > 0) {
        toast.success(
          `Entrega ${res.deliveryNumber} confirmada parcialmente. Retiro(s): ` +
          res.pendingDeliveries.map(o => o.barcode).join(', ')
        );
      } else {
        toast.success(`Entrega ${res.deliveryNumber} confirmada`);
      }
      if (res.unresolvedShortfalls?.length) {
        toast.warn('Deuda sin derivar: ' + res.unresolvedShortfalls.map(u => `${u.productName} x${u.quantity}`).join(', '));
      }
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  /** Re-derivación de faltantes pendientes (tras cancelar un retiro o llegar stock) */
  async function rederiveOutstanding() {
    if (!delivery || !id) return;
    setSaving(true);
    try {
      const res = await rederiveDeliveryShortfalls(delivery.id);
      if (res.created.length > 0) {
        toast.success(`Re-derivados: ${res.created.length} retiro(s) creado(s)`);
      } else {
        toast.info(res.message ?? 'No hay stock existente en otras sucursales.');
      }
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

  const status = deliveryStatusStyle(delivery.status);
  const d = delivery; // captura para usar dentro de funciones (evita narrowing roto en closures)
  const totalUnits = delivery.items.reduce((acc, i) => acc + Number(i.quantity_delivered ?? i.quantity), 0);

  /** Lo efectivamente entregado de un ítem: al confirmarse la entrega se
   *  registra quantity_delivered; en borrador se muestra lo cargado. */
  function deliveredQtyOf(it: Delivery['items'][number]): number {
    if (d.status !== 'BORRADOR' && it.quantity_delivered != null) {
      return Number(it.quantity_delivered);
    }
    return Number(it.quantity);
  }

  // Deuda sin derivar: objetivo (cargado vs facturado) - entregado - lo que
  // sigue prometido vía órdenes de retiro. Solo aplica a entregas confirmadas.
  // El mapa también alimenta la columna/banner de "Faltan" del comprobante.
  const orderOwed = new Map<number, number>();
  if (delivery.status !== 'BORRADOR' && delivery.status !== 'ANULADO') {
    for (const order of pendingOrders) {
      for (const it of order.items) {
        const pending = Number(it.quantity_requested) - Number(it.quantity_delivered);
        if (pending > 0) {
          const prev = orderOwed.get(it.product_id) ?? 0;
          orderOwed.set(it.product_id, prev + pending);
        }
      }
    }
  }
  const underived = (() => {
    if (delivery.status === 'BORRADOR' || delivery.status === 'ANULADO') return [] as { name: string; qty: number }[];
    const rows: { name: string; qty: number }[] = [];
    for (const it of delivery.items) {
      const billed = it.requested_quantity == null ? null : Number(it.requested_quantity);
      const target = Math.max(Number(it.quantity), billed ?? 0);
      const delivered = deliveredQtyOf(it);
      const owed = target - delivered - (orderOwed.get(it.product_id) ?? 0);
      if (owed > 0) rows.push({ name: it.name ?? it.code ?? `Producto #${it.product_id}`, qty: owed });
    }
    return rows;
  })();

  // Faltantes por ítem: cuántas unidades del objetivo total quedaron sin
  // entregar en esta orden (derivadas a retiro o sin stock, ambas cuentan:
  // el cliente todavía no las tiene). En borrador/anulada no se computa.
  const itemShortfall: (number | null)[] = delivery.items.map((it) => {
    if (delivery.status !== 'PARCIAL' && delivery.status !== 'CONFIRMADO') return null;
    const billed = it.requested_quantity == null ? null : Number(it.requested_quantity);
    const target = Math.max(Number(it.quantity), billed ?? 0);
    const owe = target - deliveredQtyOf(it);
    return owe > 0 ? owe : null;
  });
  const shortfallSummary = (() => {
    let products = 0, units = 0, derivedUnits = 0, underivedUnits = 0;
    const hasUnits = delivery.status === 'PARCIAL' || delivery.status === 'CONFIRMADO';
    if (!hasUnits) return { products, units, derivedUnits, underivedUnits };
    delivery.items.forEach((it, idx) => {
      const owe = itemShortfall[idx];
      if (owe == null) return;
      products += 1;
      units += owe;
      const derived = orderOwed.get(it.product_id) ?? 0;
      derivedUnits += Math.min(derived, owe);
      underivedUnits += Math.max(0, owe - derived);
    });
    return { products, units, derivedUnits, underivedUnits };
  })();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex items-center justify-between">
        <Button variant="secondary" onClick={() => navigate('/entregas')}>← Volver</Button>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => window.print()}>🖨 Imprimir comprobante</Button>
          {delivery.status === 'BORRADOR' && can('deliveries.confirm') && (
            <Button variant="success" loading={saving} onClick={confirmDraft}>{delivery.is_pending_delivery ? '📦 Registrar entrega efectiva' : '✅ Confirmar entrega'}</Button>
          )}
          {(delivery.status === 'PARCIAL' || delivery.status === 'CONFIRMADO') && can('deliveries.confirm') && (
            <Button variant="secondary" loading={saving} onClick={rederiveOutstanding} title="Busca stock existente en otras sucursales para completar la entrega">
              🔄 Re-derivar entrega
            </Button>
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
          <div className="flex flex-col items-end text-right">
            <div className="font-mono text-lg font-bold text-brand-700">{delivery.number}</div>
            <Badge color={status.color}>{status.label}</Badge>
            {delivery.is_pending_delivery && delivery.status === 'BORRADOR' && <Badge color="amber">Pendiente · stock reservado</Badge>}
            <div className="mt-1 print:mt-2">
              <Barcode value={delivery.number} height={40} width={1.3} />
            </div>
            {/* Código de barras EAN-13 de la orden: el control del vendedor
                escanea este código y le sale toda la mercadería solicitada */}
            {delivery.barcode ? (
              <>
                <Barcode value={delivery.barcode} format="EAN13" height={40} className="mt-1" />
                <div className="text-[10px] text-slate-400">Código de la orden</div>
              </>
            ) : null}
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
              <th className="py-2 text-center">Faltan</th>
            </tr>
          </thead>
          <tbody>
            {delivery.items.map((it, idx) => (
              <tr key={it.id ?? it.product_id} className="border-b border-slate-100">
                <td className="py-2 font-mono text-xs">{it.code}</td>
                <td className="py-2 font-medium text-slate-700">{it.name}</td>
                <td className="py-2 text-center text-slate-400">{it.requested_quantity != null ? fmtQty(it.requested_quantity) : '—'}</td>
                <td className="py-2 text-right font-semibold">{fmtQty(deliveredQtyOf(it))} {(it.unit ?? '').toLowerCase()}</td>
                <td className="py-2 text-center">
                  {itemShortfall[idx] != null ? (
                    <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
                      Faltan {fmtQty(itemShortfall[idx]!)} {(it.unit ?? '').toLowerCase()}
                    </span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Resumen de faltantes del comprobante (se imprime con el comprobante) */}
        {shortfallSummary.units > 0 && (
          <div className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
            <div className="text-xs font-bold uppercase tracking-wide">⚠️ Faltantes en esta orden</div>
            <p>
              FALTAN ENTREGAR ({shortfallSummary.products}) PRODUCTO(S), NO EXISTE STOCK DISPONIBLE EN LAS SUCURSALES PARA LA ENTREGA. ({fmtQty(shortfallSummary.units)} UNIDAD(ES)).
              {shortfallSummary.derivedUnits > 0 && (
                <> De ellas, <strong>{fmtQty(shortfallSummary.derivedUnits)}</strong> u. quedaron derivadas
                para retiro en otra sucursal (ver Pendientes de entrega).</>
              )}
              {shortfallSummary.underivedUnits > 0 && (
                <> Además quedan <strong>{fmtQty(shortfallSummary.underivedUnits)}</strong> u. sin stock
                en ninguna sucursal (deuda sin derivar).</>
              )}
            </p>
          </div>
        )}

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

        {/* Pendientes de entrega: una orden de retiro por sucursal de retiro */}
        {pendingOrders.length > 0 && (
          <div className="mt-6 rounded-lg border border-dashed border-amber-400 bg-amber-50 p-4">
            <div className="mb-1 text-sm font-bold uppercase tracking-wide text-amber-800">
              ⏳ Pendientes de entrega
            </div>
            {pendingOrders.map((order) => {
              const rows = order.items
                .map((it) => ({ ...it, pendingQty: Number(it.quantity_reserved) - Number(it.quantity_delivered) }))
                .filter((it) => it.pendingQty > 0);
              if (rows.length === 0) return null;
              return (
                <div key={order.id} className="mb-4 last:mb-0">
                  <p className="mb-2 text-xs text-amber-700">
                    Se derivaron a <strong>{order.pickupLocationName ?? 'otra sucursal'}</strong>. El cliente
                    presenta este código para retirarlos:
                  </p>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-amber-300 text-left text-xs uppercase tracking-wide text-amber-700">
                        <th className="py-1">Producto</th>
                        <th className="py-1 text-right">Cantidad pendiente</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((it) => (
                        <tr key={`${order.id}-${it.product_id}-${it.source_location_id}`} className="border-b border-amber-200/60">
                          <td className="py-1.5 text-slate-700">
                            <span className="font-mono text-xs text-slate-400">{it.product_code}</span> · {it.product_name}
                          </td>
                          <td className="py-1.5 text-right font-semibold text-slate-800">
                            {fmtQty(it.pendingQty)} {(it.unit ?? '').toLowerCase()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="mt-3 flex flex-col items-center gap-1 rounded-lg bg-white p-3">
                    <Barcode value={order.barcode} format="EAN13" height={44} />
                    <div className="text-xs text-slate-500">
                      Orden de retiro <strong>{order.number}</strong>
                    </div>
                  </div>
                </div>
              );
            })}
            {/* Deuda sin derivar que convive con órdenes de retiro */}
            {underived.length > 0 && (
              <div className="mt-3 border-t border-amber-300 pt-2 text-xs text-amber-800">
                <strong>Sin derivar:</strong> estos montos no pudieron derivarse por falta de stock general.{' '}
                {underived.map((u) => `${u.name} x${fmtQty(u.qty)}`).join(' · ')}
              </div>
            )}
          </div>
        )}

        {/* Deuda sin derivar sin órdenes de retiro (entrega confirmada con deuda) */}
        {pendingOrders.length === 0 && underived.length > 0 && (
          <div className="mt-6 rounded-lg border border-dashed border-amber-400 bg-amber-50 p-4 text-sm text-amber-800">
            <div className="mb-1 font-bold uppercase tracking-wide">⏳ Pendiente sin derivar</div>
            Estos montos no pudieron derivarse por falta de stock en ninguna sucursal:{' '}
            <strong>{underived.map((u) => `${u.name} x${fmtQty(u.qty)}`).join(' · ')}</strong>.
            ESTOS PRODUCTOS NO SE PUDIERON DERIVAR A OTRA SUCURSAL POR FALTA DE STOCK EN LAS SUCURSALES. USÁ «RE-DERIVAR ENTREGA» CUANDO LLEGUE LA MERCADERÍA.
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

      {/* Modal de derivación (mismo componente que Nueva entrega) */}
      <DerivationModal
        open={deriving}
        onClose={() => setDeriving(false)}
        items={availabilityItems}
        onConfirm={handleConfirmWithChoices}
      />
    </div>
  );
}
