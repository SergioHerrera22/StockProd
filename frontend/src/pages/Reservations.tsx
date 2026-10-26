import { useCallback, useEffect, useState } from 'react';
import { api, listPendingDeliveries, scanPendingDelivery, confirmPendingDeliveryPickup, cancelPendingDeliveryOrder } from '../lib/api';
import type { PendingDelivery, PendingDeliveryStatus, PendingDeliveryItem, ScanPendingDeliveryResult } from '../types';
import { DataTable } from '../components/DataTable';
import { Card } from '../components/ui';
import Barcode from '../components/Barcode';
import { useToast } from '../components/Toast';
import { ScanInput } from '../components/ScanInput';
import { fmtDateTime, fmtQty } from '../lib/format';
import { hasPermission } from '../lib/permissions';
import { useAuth } from '../store/auth';

const STATUS_LABELS: Record<PendingDeliveryStatus, string> = {
  PENDIENTE: 'Pendiente retiro',
  EN_PREPARACION: 'En preparación',
  LISTO_RETIRO: 'Listo para retiro',
  // PARCIAL: el cliente ya retiró parte; queda mercadería por entregar
  PARCIAL: 'Retiro parcial',
  ENTREGADO: 'Entregado',
  CANCELADO: 'Cancelado',
};

const STATUS_COLORS: Record<PendingDeliveryStatus, string> = {
  PENDIENTE: 'bg-amber-100 text-amber-800',
  EN_PREPARACION: 'bg-blue-100 text-blue-800',
  LISTO_RETIRO: 'bg-sky-100 text-sky-800',
  PARCIAL: 'bg-orange-100 text-orange-800',
  ENTREGADO: 'bg-emerald-100 text-emerald-800',
  CANCELADO: 'bg-slate-100 text-slate-600',
};

const ACTIVE_STATUSES: PendingDeliveryStatus[] = ['PENDIENTE', 'EN_PREPARACION', 'LISTO_RETIRO', 'PARCIAL'];

export default function ReservationsPage() {
  const { user } = useAuth();
  const toast = useToast();

  const [rows, setRows] = useState<PendingDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<PendingDeliveryStatus | ''>('');
  const [q, setQ] = useState('');

  // Modal escanear
  const [scanOpen, setScanOpen] = useState(false);
  // Modal confirmar retiro (tras escanear)
  const [scanned, setScanned] = useState<ScanPendingDeliveryResult | null>(null);
  const [confirmQty, setConfirmQty] = useState<Record<number, string>>({});
  const [confirming, setConfirming] = useState(false);
  // Modal cancelar
  const [cancelTarget, setCancelTarget] = useState<PendingDelivery | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  // Modal extender plazo
  const [extendTarget, setExtendTarget] = useState<PendingDelivery | null>(null);
  const [extendDays, setExtendDays] = useState('7');
  const [extendNote, setExtendNote] = useState('');
  const [extending, setExtending] = useState(false);
  // Nota de retiro imprimible (trae el detalle completo con items)
  const [printOrder, setPrintOrder] = useState<PendingDelivery | null>(null);
  const [printLoading, setPrintLoading] = useState(false);

  // Sucursal de retiro: usuario restringido ve solo la suya; admin puede elegir "todas"
  const myLocationId = user?.locationId ?? null;
  const isAdmin = user?.role === 'ADMIN';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listPendingDeliveries({
        pickupLocationId: isAdmin ? undefined : (myLocationId ?? undefined),
        status: statusFilter || undefined,
        q: q.trim() || undefined,
        page,
        pageSize,
      });
      setRows(res.data);
      setTotal(res.pagination.total);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, myLocationId, statusFilter, q, page, pageSize]);

  useEffect(() => { void load(); }, [load]);

  // ===== Resumen (tarjetas) calculado de la página actual de órdenes activas =====
  const summary = {
    pendientes: rows.filter((r) => r.status === 'PENDIENTE').length,
    preparacion: rows.filter((r) => r.status === 'EN_PREPARACION').length,
    listos: rows.filter((r) => r.status === 'LISTO_RETIRO').length,
    unidadesPendientes: rows
      .filter((r) => ACTIVE_STATUSES.includes(r.status))
      .reduce((acc, r) => acc + Number(r.total_qty_reserved ?? 0) - Number(r.total_qty_delivered ?? 0), 0),
  };

  // ===== Escanear código de barras =====
  const [lastBarcode, setLastBarcode] = useState('');
  const handleScan = useCallback(async (code: string) => {
    try {
      const result = await scanPendingDelivery(code.trim());
      setScanOpen(false);
      setLastBarcode(code.trim());
      setScanned(result);
      // Precargar cantidades pendientes por item
      const initial: Record<number, string> = {};
      for (const it of result.items ?? []) {
        const pending = Number(it.quantity_reserved) - Number(it.quantity_delivered);
        if (pending > 0) initial[it.product_id] = String(pending);
      }
      setConfirmQty(initial);
    } catch (e) {
      toast.error((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== Confirmar retiro =====
  async function handleConfirmPickup() {
    if (!scanned) return;
    const items = (scanned.items ?? [])
      .map((it) => ({
        productId: it.product_id,
        quantityDelivered: Number(confirmQty[it.product_id] ?? 0),
      }))
      .filter((it) => it.quantityDelivered > 0);

    if (!items.length) {
      toast.error('Ingresá al menos una cantidad a entregar');
      return;
    }
    setConfirming(true);
    try {
      await confirmPendingDeliveryPickup({ barcode: lastBarcode, items });
      toast.success('Retiro confirmado: stock descontado de esta sucursal');
      setScanned(null);
      setConfirmQty({});
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setConfirming(false);
    }
  }

  // ===== Cancelar orden pendiente =====
  async function handleCancel() {
    if (!cancelTarget || cancelReason.trim().length < 3) return;
    try {
      await cancelPendingDeliveryOrder(cancelTarget.id, cancelReason.trim());
      toast.success('Orden cancelada: reservas liberadas');
      setCancelTarget(null);
      setCancelReason('');
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  // ===== Extender plazo de retiro (B2) =====
  async function handleExtend() {
    if (!extendTarget) return;
    setExtending(true);
    try {
      await api(`/pending-deliveries/${extendTarget.id}/extend`, {
        method: 'POST',
        body: { days: Number(extendDays), note: extendNote.trim() || null },
      });
      toast.success(`Plazo de ${extendTarget.number} extendido ${extendDays} días`);
      setExtendTarget(null);
      setExtendNote('');
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExtending(false);
    }
  }

  // ===== Nota de retiro imprimible (B3) =====
  async function openPrintNota(row: PendingDelivery) {
    setPrintLoading(true);
    try {
      const detail = await api<PendingDelivery>(`/pending-deliveries/${row.id}`);
      setPrintOrder(detail);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPrintLoading(false);
    }
  }

  const columns = [
    { key: 'number', label: 'Orden', className: 'font-mono' },
    {
      key: 'barcode',
      label: 'Código de barras',
      render: (row: PendingDelivery) => (
        <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">{row.barcode}</code>
      ),
    },
    {
      key: 'customer_name',
      label: 'Cliente',
      render: (row: PendingDelivery) => (
        <div>
          <div className="font-medium text-slate-700">{row.customer_name || '—'}</div>
          {row.customer_phone && <div className="text-xs text-slate-400">{row.customer_phone}</div>}
        </div>
      ),
    },
    { key: 'sale_location_name', label: 'Suc. venta' },
    { key: 'pickup_location_name', label: 'Suc. retiro' },
    {
      key: 'items_count',
      label: 'Ítems',
      align: 'center' as const,
      render: (row: PendingDelivery) => row.items_count ?? '—',
    },
    {
      key: 'total_qty_reserved',
      label: 'Reservado',
      align: 'right' as const,
      render: (row: PendingDelivery) => fmtQty(row.total_qty_reserved ?? 0),
    },
    {
      key: 'total_qty_delivered',
      label: 'Entregado',
      align: 'right' as const,
      render: (row: PendingDelivery) => fmtQty(row.total_qty_delivered ?? 0),
    },
    {
      key: 'status',
      label: 'Estado',
      render: (row: PendingDelivery) => (
        <span className={`rounded px-2 py-1 text-xs font-medium ${STATUS_COLORS[row.status]}`}>
          {STATUS_LABELS[row.status]}
        </span>
      ),
    },
    {
      key: 'created_at',
      label: 'Creada',
      render: (row: PendingDelivery) => fmtDateTime(row.created_at),
    },
    {
      key: 'expires_at',
      label: 'Vence',
      render: (row: PendingDelivery) => {
        if (!ACTIVE_STATUSES.includes(row.status) || !row.expires_at) {
          return <span className="text-xs text-slate-300">—</span>;
        }
        const vencida = new Date(row.expires_at).getTime() <= Date.now();
        return (
          <span className={vencida ? 'text-xs font-semibold text-red-600' : 'text-xs text-slate-500'}>
            {vencida ? '⚠ Vencida · ' : ''}{fmtDateTime(row.expires_at)}
          </span>
        );
      },
    },
    {
      key: 'actions',
      label: 'Acciones',
      align: 'right' as const,
      render: (row: PendingDelivery) =>
        ACTIVE_STATUSES.includes(row.status) ? (
          <div className="flex justify-end gap-2">
            <button
              className="rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700"
              onClick={() => { void handleScan(row.barcode); }}
            >
              Entregar
            </button>
            <button
              className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              onClick={() => { void openPrintNota(row); }}
              disabled={printLoading}
            >
              🖨 Nota
            </button>
            <button
              className="rounded-lg border border-amber-200 px-2.5 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-50"
              onClick={() => {
                setExtendTarget(row);
                setExtendDays('7');
                setExtendNote('');
              }}
            >
              ⏳ Extender
            </button>
            {hasPermission(user?.role, 'deliveries.void') && (
              <button
                className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50"
                onClick={() => {
                  setCancelTarget(row);
                  setCancelReason('');
                }}
              >
                Cancelar
              </button>
            )}
          </div>
        ) : (
          <span className="text-xs text-slate-300">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-5">
      {/* Encabezado + resumen */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Reservas / Retiros pendientes</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Mercadería derivada a tu sucursal: escaneá el código de barras del comprobante para entregar.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryCard color="amber" value={summary.pendientes} label="Pendientes" />
          <SummaryCard color="blue" value={summary.preparacion} label="En preparación" />
          <SummaryCard color="sky" value={summary.listos} label="Listos p/ retiro" />
          <SummaryCard color="slate" value={fmtQty(summary.unidadesPendientes)} label="Unid. reservadas" />
        </div>
      </div>

      {/* Acciones + filtros */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-white p-4 shadow-sm">
        <button
          className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          onClick={() => setScanOpen(true)}
        >
          📷 Escanear código de retiro
        </button>
        <select
          className="input w-48"
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value as PendingDeliveryStatus | ''); setPage(1); }}
        >
          <option value="">Todos los estados</option>
          <option value="PENDIENTE">Pendiente retiro</option>
          <option value="EN_PREPARACION">En preparación</option>
          <option value="LISTO_RETIRO">Listo para retiro</option>
          <option value="PARCIAL">Retiro parcial</option>
          <option value="ENTREGADO">Entregado</option>
          <option value="CANCELADO">Cancelado</option>
        </select>
        <input
          className="input w-64"
          placeholder="Buscar por orden, código o cliente…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
        />
      </div>

      {/* Tabla */}
      <div className="rounded-xl bg-white shadow-sm">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          emptyTitle="Sin retiros pendientes"
          emptyHint="Cuando un vendedor derive mercadería a esta sucursal, aparecerá acá."
        />
      </div>

      {/* Modal escanear */}
      {scanOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-800">Escanear código de retiro</h2>
              <button className="text-slate-400 hover:text-slate-600" onClick={() => setScanOpen(false)}>✕</button>
            </div>
            <p className="mb-3 text-sm text-slate-500">
              Escaneá con el lector USB o cámara el código EAN-13 del comprobante del cliente.
            </p>
            <ScanInput onScan={handleScan} autoFocus placeholder="Código EAN-13 (ej: 779800123456)" />
          </div>
        </div>
      )}

      {/* Modal confirmar retiro */}
      {scanned && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-800">Confirmar retiro {scanned.number}</h2>
                <p className="mt-0.5 text-sm text-slate-500">
                  Vendida en <strong>{scanned.sale_location_name}</strong> · Retira en{' '}
                  <strong>{scanned.pickup_location_name}</strong>
                  {scanned.customer_name && <> · Cliente: <strong>{scanned.customer_name}</strong></>}
                </p>
              </div>
              <button className="text-slate-400 hover:text-slate-600" onClick={() => setScanned(null)}>✕</button>
            </div>

            <table className="mb-4 w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-2 py-2">Producto</th>
                  <th className="px-2 py-2 text-right">Pedido</th>
                  <th className="px-2 py-2 text-right">Entregado</th>
                  <th className="px-2 py-2 text-right">Pendiente</th>
                  <th className="px-2 py-2 text-center">Entregar ahora</th>
                </tr>
              </thead>
              <tbody>
                {(scanned.items ?? []).map((it: PendingDeliveryItem) => {
                  const pending = Number(it.quantity_reserved) - Number(it.quantity_delivered);
                  return (
                    <tr key={`${it.product_id}-${it.source_location_id}`} className="border-b border-slate-100 last:border-0">
                      <td className="px-2 py-2">
                        <div className="font-medium text-slate-700">{it.product_name}</div>
                        <div className="font-mono text-xs text-slate-400">{it.product_code}</div>
                      </td>
                      <td className="px-2 py-2 text-right">{fmtQty(it.quantity_requested)}</td>
                      <td className="px-2 py-2 text-right">{fmtQty(it.quantity_delivered)}</td>
                      <td className={`px-2 py-2 text-right font-semibold ${pending > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                        {fmtQty(pending)}
                      </td>
                      <td className="px-2 py-2 text-center">
                        {pending > 0 ? (
                          <input
                            type="number"
                            min="0"
                            max={pending}
                            step="0.001"
                            value={confirmQty[it.product_id] ?? ''}
                            onChange={(e) => setConfirmQty((prev) => ({ ...prev, [it.product_id]: e.target.value }))}
                            className="input w-24 text-center"
                          />
                        ) : (
                          <span className="text-slate-300">✓</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="mb-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-700">
              Al confirmar se descuenta el stock de <strong>{scanned.pickup_location_name}</strong> y se registra el
              movimiento con auditoría. La operación es transaccional.
            </div>

            <div className="flex justify-end gap-3">
              <button className="btn btn-secondary" onClick={() => setScanned(null)}>Cancelar</button>
              <button className="btn btn-success" onClick={handleConfirmPickup} disabled={confirming}>
                {confirming ? 'Confirmando…' : '✅ Confirmar entrega'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal cancelar */}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 className="mb-1 text-lg font-bold text-red-600">Cancelar orden {cancelTarget.number}</h2>
            <p className="mb-4 text-sm text-slate-500">
              Se liberará el stock reservado ({fmtQty(Number(cancelTarget.total_qty_reserved ?? 0) - Number(cancelTarget.total_qty_delivered ?? 0))} unidades)
              y la orden quedará como CANCELADO.
            </p>
            <label className="mb-1 block text-sm font-medium text-slate-700">Motivo * (mínimo 3 caracteres)</label>
            <textarea
              className="input w-full"
              rows={3}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Ej: cliente canceló la compra, error de derivación…"
            />
            <div className="mt-4 flex justify-end gap-3">
              <button className="btn btn-secondary" onClick={() => setCancelTarget(null)}>Volver</button>
              <button
                className="btn btn-danger"
                onClick={handleCancel}
                disabled={cancelReason.trim().length < 3}
              >
                Confirmar cancelación
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal extender plazo */}
      {extendTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 className="mb-1 text-lg font-bold text-slate-800">⏳ Extender plazo · {extendTarget.number}</h2>
            <p className="mb-4 text-sm text-slate-500">
              Las reservas de la orden se corren N días desde ahora: el auto-cancel
              ya no la va a anular al vencer el plazo actual.
            </p>
            <label className="mb-1 block text-sm font-medium text-slate-700">Días de extensión</label>
            <select className="input w-full" value={extendDays} onChange={(e) => setExtendDays(e.target.value)}>
              <option value="7">7 días</option>
              <option value="14">14 días</option>
              <option value="30">30 días</option>
            </select>
            <label className="mb-1 mt-3 block text-sm font-medium text-slate-700">Nota (opcional)</label>
            <textarea
              className="input w-full"
              rows={2}
              value={extendNote}
              onChange={(e) => setExtendNote(e.target.value)}
              placeholder="Ej: cliente pagó, pasa a buscar el sábado…"
            />
            <div className="mt-4 flex justify-end gap-3">
              <button className="btn btn-secondary" onClick={() => setExtendTarget(null)}>Volver</button>
              <button className="btn btn-success" onClick={handleExtend} disabled={extending}>
                {extending ? 'Extendiendo…' : 'Confirmar extensión'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Nota de retiro imprimible */}
      {printOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4">
          <div className="w-full max-w-lg">
            <Card className="print-area p-6 text-sm text-slate-800">
              <div className="flex items-start justify-between border-b-2 border-slate-800 pb-3">
                <div>
                  <div className="text-lg font-black tracking-wide">ROBLES PINTURERÍAS</div>
                  <div className="text-xs text-slate-500">Nota de retiro · Comprobante interno</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm font-bold">{printOrder.number}</div>
                  <div className="text-xs text-slate-500">{fmtDateTime(printOrder.created_at)}</div>
                </div>
              </div>

              <div className="print:flex print:justify-center py-3">
                <Barcode value={printOrder.barcode} format="EAN13" height={44} />
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-slate-200 pb-3">
                <div>
                  <span className="text-xs text-slate-500">Cliente: </span>
                  <span className="font-semibold">{printOrder.customer_name || '—'}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-500">Teléfono: </span>
                  <span className="font-semibold">{printOrder.customer_phone || '—'}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-500">Retira en: </span>
                  <span className="font-semibold">{printOrder.pickup_location_name ?? '—'}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-500">Vendido en: </span>
                  <span className="font-semibold">{printOrder.sale_location_name ?? '—'}</span>
                </div>
              </div>

              <table className="mt-2 w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-300 text-left uppercase tracking-wide text-slate-500">
                    <th className="py-1">Producto</th>
                    <th className="py-1 text-right">Pedido</th>
                    <th className="py-1 text-right">Entregado</th>
                    <th className="py-1 text-right">Pendiente</th>
                  </tr>
                </thead>
                <tbody>
                  {(printOrder.items ?? []).map((it) => {
                    const pending = Number(it.quantity_reserved) - Number(it.quantity_delivered);
                    return (
                      <tr key={`${it.product_id}-${it.source_location_id}`} className="border-b border-slate-100">
                        <td className="py-1">
                          <div className="font-medium">{it.product_name}</div>
                          <div className="font-mono text-[10px] text-slate-400">{it.product_code}</div>
                        </td>
                        <td className="py-1 text-right">{fmtQty(it.quantity_requested)}</td>
                        <td className="py-1 text-right">{fmtQty(it.quantity_delivered)}</td>
                        <td className={`py-1 text-right font-semibold ${pending > 0 ? 'text-slate-800' : 'text-emerald-600'}`}>
                          {pending > 0 ? fmtQty(pending) : '✓'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {printOrder.notes && (
                <p className="mt-2 text-xs text-slate-600">Nota: {printOrder.notes}</p>
              )}

              <div className="mt-8 grid grid-cols-2 gap-8 print:flex">
                <div className="border-t border-slate-800 pt-1 text-center text-xs">Firma de quien retira</div>
                <div className="border-t border-slate-800 pt-1 text-center text-xs">Firma y sello · Robles</div>
              </div>
            </Card>

            <div className="mt-3 flex justify-end gap-3 no-print">
              <button className="btn btn-secondary" onClick={() => setPrintOrder(null)}>Cerrar</button>
              <button className="btn btn-success" onClick={() => window.print()}>🖨 Imprimir</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ color, value, label }: { color: 'amber' | 'blue' | 'sky' | 'slate'; value: string | number; label: string }) {
  const cls: Record<string, string> = {
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    sky: 'border-sky-200 bg-sky-50 text-sky-700',
    slate: 'border-slate-200 bg-slate-50 text-slate-700',
  };
  return (
    <div className={`rounded-lg border p-3 ${cls[color]}`}>
      <div className="text-xl font-bold">{value}</div>
      <div className="text-xs opacity-80">{label}</div>
    </div>
  );
}
