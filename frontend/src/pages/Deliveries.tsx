import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs, scanDelivery, confirmDelivery, type DeliveryConfirmResponse } from '../lib/api';
import { fmtDateTime, fmtQty } from '../lib/format';
import type { Delivery, Location, ScanDeliveryResult } from '../types';
import { useAuth } from '../store/auth';
import { Badge, Button, Card, Input, Modal, PageHeader, Select } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';
import { ScanInput } from '../components/ScanInput';

type DeliveryStatusStyle = { label: string; color: 'amber' | 'green' | 'red' | 'blue' | 'gray' };

export const DELIVERY_STATUS: Record<Delivery['status'], DeliveryStatusStyle> = {
  BORRADOR: { label: 'Borrador', color: 'amber' },
  CONFIRMADO: { label: 'Confirmada', color: 'green' },
  // Parte del stock derivado a otra sucursal, con orden de retiro abierta
  PARCIAL: { label: 'Parcial', color: 'blue' },
  ANULADO: { label: 'Anulada', color: 'red' },
};

/** Etiqueta/color de un estado, con fallback para estados no conocidos. */
export function deliveryStatusStyle(status: string): DeliveryStatusStyle {
  return DELIVERY_STATUS[status as Delivery['status']] ?? { label: status, color: 'gray' };
}

/** Mensaje que se muestra según el estado de la orden escaneada */
function scanStatusHint(status: string): { tone: string; text: string } {
  switch (status) {
    case 'BORRADOR':
      return { tone: 'amber', text: 'Orden en borrador: si toda la mercadería está correcta, aceptá la entrega. Si falta stock, la web deriva el faltante al flujo ya existente (parcial con orden de retiro o edición del borrador).' };
    case 'PARCIAL':
      return { tone: 'blue', text: 'La orden ya fue aceptada de forma PARCIAL: parte de la mercadería se derivó a otra sucursal y el cliente la retirará luego presentando el código de la orden de retiro. Abri el detalle para ver los pendientes o re-derivar faltantes.' };
    case 'CONFIRMADO':
      return { tone: 'green', text: 'La orden ya fue aceptada y entregada por completo. No hay nada pendiente.' };
    case 'ANULADO':
      return { tone: 'red', text: 'La orden está ANULADA: no se puede operar sobre ella.' };
    default:
      return { tone: 'gray', text: '' };
  }
}

export default function Deliveries() {
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [rows, setRows] = useState<Delivery[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [locationId, setLocationId] = useState('');
  const [q, setQ] = useState('');
  const [locations, setLocations] = useState<Location[]>([]);

  // ===== Escanear orden de entrega =====
  const [scanOpen, setScanOpen] = useState(false);
  const [scanned, setScanned] = useState<ScanDeliveryResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmRes, setConfirmRes] = useState<DeliveryConfirmResponse | null>(null);
  // Checklist de picking (mejora 10): cantidad recibida por producto + cuántas
  // veces se escaneó cada código. Solo activa en órdenes BORRADOR.
  const [pickQty, setPickQty] = useState<Record<number, string>>({});
  const [scanHits, setScanHits] = useState<Record<number, number>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ deliveries: Delivery[]; total: number }>(
        `/deliveries${qs({ status, locationId, q, page, pageSize: 15 })}`
      );
      setRows(res.deliveries);
      setTotal(res.total);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, locationId, q, page]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations)).catch(() => {});
  }, []);

  async function handleScan(code: string) {
    try {
      const res = await scanDelivery(code.trim());
      setScanOpen(false);
      setConfirmRes(null);
      // Precargar el checklist con la cantidad del borrador por producto
      const pre: Record<number, string> = {};
      for (const it of res.items) pre[it.productId] = String(Number(it.quantity));
      setPickQty(pre);
      setScanHits({});
      setScanned(res);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  /** Escaneo de PRODUCTO dentro del modal: tumba la línea y suma +1 a recibir
   *  (cap a la cantidad pedida del borrador). Busca por código interno; si no
   *  matchea, prueba por código de barras vía /stock. */
  async function handleItemScan(code: string) {
    if (!scanned) return;
    const codel = code.trim().toLowerCase();
    let target = scanned.items.find((it) => it.code.toLowerCase() === codel);
    if (!target) {
      try {
        const res = await api<{ products: Array<{ id: number }> }>(`/stock${qs({ q: codel, limit: 3 })}`);
        const pid = res.products[0]?.id;
        if (pid) target = scanned.items.find((it) => it.productId === pid);
      } catch { /* sin match por barras */ }
    }
    if (!target) {
      toast.warn(`Ese producto no está en la orden ${scanned.number}`);
      return;
    }
    const t = target;
    setScanHits((prev) => ({ ...prev, [t.productId]: (prev[t.productId] ?? 0) + 1 }));
    setPickQty((prev) => {
      const cur = Number(prev[t.productId] ?? t.quantity);
      return { ...prev, [t.productId]: String(Math.min(cur + 1, Math.max(0, Number(t.quantity)))) };
    });
  }

  async function acceptDelivery() {
    if (!scanned) return;
    setConfirming(true);
    try {
      const res = await confirmDelivery(scanned.id);
      setScanned(null);
      setConfirmRes(res);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setConfirming(false);
    }
  }

  /** Confirma SOLO lo marcado en el checklist (mejora 10). Lo omitido queda
   *  como PARCIAL: deuda con orden de retiro o unidad sin derivar. */
  async function acceptPicked() {
    if (!scanned) return;
    const pick = scanned.items
      .map((it) => ({ productId: it.productId, quantity: Number(pickQty[it.productId] ?? it.quantity) }))
      .filter((p) => p.quantity > 0);
    if (pick.length === 0) {
      toast.error('El checklist está vacío: cargá al menos una cantidad recibida');
      return;
    }
    const reduced = scanned.items.filter(
      (it) => Number(pickQty[it.productId] ?? it.quantity) < Number(it.quantity)
    ).length;
    setConfirming(true);
    try {
      const res = await confirmDelivery(scanned.id, pick);
      setScanned(null);
      setPickQty({});
      setScanHits({});
      setConfirmRes(res);
      if (reduced > 0) toast.info(`${reduced} producto(s) quedó con menos de lo cargado: se deriva lo faltante (PARCIAL)`);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setConfirming(false);
    }
  }

  const columns: Column<Delivery>[] = [
    { key: 'number', label: 'N°', sortable: true, render: (d) => <span className="font-mono font-semibold text-brand-700">{d.number}</span> },
    { key: 'created_at', label: 'Fecha', sortable: true, render: (d) => fmtDateTime(d.created_at) },
    { key: 'location_name', label: 'Sale de', render: (d) => d.location_name },
    { key: 'invoice_number', label: 'Factura ref.', render: (d) => d.invoice_number ?? '—' },
    { key: 'line_count', label: 'Productos', align: 'right', render: (d) => d.line_count ?? '—' },
    { key: 'total_items', label: 'Unidades', align: 'right', render: (d) => fmtQty(d.total_items ?? 0) },
    { key: 'shortfall_units', label: 'Faltan', align: 'right', render: (d) => {
      if ((d.shortfall_lines ?? 0) > 0) {
        return (
          <span
            className="font-semibold text-red-600"
            title={`Faltan ${d.shortfall_lines} producto(s) · ${fmtQty(d.shortfall_units ?? 0)} unidades sin entregar`}
          >
            {d.shortfall_lines} prod · {fmtQty(d.shortfall_units ?? 0)} u
          </span>
        );
      }
      return <span className="text-slate-300">—</span>;
    } },
    { key: 'status', label: 'Estado', render: (d) => {
      const s = deliveryStatusStyle(d.status);
      return <Badge color={s.color}>{s.label}</Badge>;
    } },
    { key: 'created_by_name', label: 'Usuario', render: (d) => d.created_by_name },
  ];

  return (
    <div>
      <PageHeader
        title="Entregas de mercadería"
        subtitle="Salidas verificadas al entregar productos al cliente"
        actions={
          <>
            <Button variant="secondary" onClick={() => setScanOpen(true)}>📷 Escanear orden</Button>
            <Button onClick={() => navigate('/entregas/nueva')}>+ Nueva entrega</Button>
          </>
        }
      />

      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Buscar por número o factura…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            className="min-w-[200px] flex-1"
          />
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-40">
            <option value="">Todos los estados</option>
            <option value="BORRADOR">Borradores</option>
            <option value="CONFIRMADO">Confirmadas</option>
            <option value="PARCIAL">Parciales</option>
            <option value="ANULADO">Anuladas</option>
          </Select>
          <Select value={locationId} onChange={(e) => { setLocationId(e.target.value); setPage(1); }} className="w-48">
            <option value="">Todas las ubicaciones</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </div>
      </Card>

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(d) => d.id}
          onRowClick={(d) => navigate(`/entregas/${d.id}`)}
          loading={loading}
          pageSize={15}
          total={total}
          page={page}
          onPageChange={setPage}
          emptyTitle="No hay entregas"
          emptyHint="Registrá la primera entrega de mercadería"
        />
      </Card>

      {/* ===== Modal escanear código de la orden ===== */}
      {scanOpen && (
        <Modal open onClose={() => setScanOpen(false)} title="Escanear orden de entrega">
          <p className="mb-3 text-sm text-slate-500">
            Escaneá con cámara o lector USB el código EAN-13 del comprobante de la orden.
            Te aparece toda la mercadería solicitada para el control.
          </p>
          <ScanInput onScan={handleScan} autoFocus placeholder="Código EAN-13 de la orden de entrega…" />
        </Modal>
      )}

      {/* ===== Modal orden escaneada: control de mercadería ===== */}
      {scanned && (() => {
        const s = deliveryStatusStyle(scanned.status);
        const hint = scanStatusHint(scanned.status);
        const billedShort = scanned.items.filter(
          (it) => it.stockAvailable < Math.max(it.quantity, it.requestedQuantity ?? 0)
        ).length;
        const checklistMode = scanned.status === 'BORRADOR' && can('deliveries.confirm');
        return (
          <Modal
            open
            width="lg"
            onClose={() => setScanned(null)}
            title={`Orden ${scanned.number}`}
            footer={
              <>
                <Button variant="secondary" onClick={() => navigate(`/entregas/${scanned.id}`)}>
                  Abrir detalle
                </Button>
                {checklistMode && (
                  <>
                    <Button variant="ghost" onClick={() => void acceptDelivery()} title="Confirma entrega con TODO el stock disponible, sin checklist">
                      Aceptar todo
                    </Button>
                    <Button
                      variant="success"
                      loading={confirming}
                      onClick={() => void acceptPicked()}
                      title="Confirma SOLO las cantidades del checklist; lo que queda sin recibir se deriva como deuda (PARCIAL)"
                    >
                      ✅ Confirmar según checklist
                    </Button>
                  </>
                )}
              </>
            }
          >
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
              <Badge color={s.color}>{s.label}</Badge>
              <span><span className="text-slate-400">Sale de:</span> <strong>{scanned.locationName}</strong></span>
              <span><span className="text-slate-400">Factura:</span> {scanned.invoiceNumber ?? '—'}</span>
              <span><span className="text-slate-400">Registró:</span> {scanned.createdByName}</span>
              <span><span className="text-slate-400">Fecha:</span> {fmtDateTime(scanned.createdAt)}</span>
            </div>

            <p className={`mb-3 rounded-lg p-3 text-xs leading-relaxed ${
              hint.tone === 'amber' ? 'bg-amber-50 text-amber-800' :
              hint.tone === 'blue' ? 'bg-blue-50 text-blue-800' :
              hint.tone === 'green' ? 'bg-emerald-50 text-emerald-800' :
              hint.tone === 'red' ? 'bg-red-50 text-red-700' : 'bg-slate-50 text-slate-600'
            }`}>
              {hint.text}
            </p>

            {billedShort > 0 && scanned.status === 'BORRADOR' && (
              <p className="mb-3 rounded-lg bg-red-50 p-3 text-xs text-red-700">
                ⚠️ {billedShort} producto(s) tienen menos stock disponible que lo solicitado al confirmar.
                Se van a derivar esos faltantes a otras sucursales o quedarán como retiro posterior del cliente.
              </p>
            )}

            {checklistMode && (
              <div className="mb-3">
                <ScanInput
                  onScan={handleItemScan}
                  autoFocus
                  placeholder="Escanear producto de la orden (marca ✓ y suma cantidad)…"
                />
                <p className="mt-1 text-xs text-slate-400">
                  Picking: escaneá cada producto o ajustá la cantidad recibida a mano. Lo que no entra
                  a la caja queda debiéndose y se deriva con "Confirmar según checklist".
                </p>
              </div>
            )}

            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2">Producto</th>
                  <th className="py-2 text-right">Solicitado</th>
                  <th className="py-2 text-right">Facturado</th>
                  <th className="py-2 text-right">Entregado</th>
                  <th className="py-2 text-right">Stock disp.</th>
                  {checklistMode && <th className="py-2 text-center">Escaneos</th>}
                  {checklistMode && <th className="py-2 text-right">Recibir</th>}
                </tr>
              </thead>
              <tbody>
                {scanned.items.map((it) => {
                  const needed = Math.max(it.quantity, it.requestedQuantity ?? 0);
                  const short = it.stockAvailable < needed;
                  return (
                    <tr key={it.productId} className="border-b border-slate-100">
                      <td className="py-2">
                        <span className="font-mono text-xs text-slate-400">{it.code}</span>
                        <div className={short ? 'font-medium text-red-600' : 'text-slate-700'}>{it.name}</div>
                      </td>
                      <td className="py-2 text-right font-semibold">{fmtQty(it.quantity)} {(it.unit ?? '').toLowerCase()}</td>
                      <td className="py-2 text-right text-slate-400">{it.requestedQuantity != null ? fmtQty(it.requestedQuantity) : '—'}</td>
                      <td className="py-2 text-right">
                        {scanned.status === 'BORRADOR'
                          ? <span className="text-slate-300">—</span>
                          : <span className="font-semibold">{fmtQty(it.quantityDelivered ?? 0)}</span>}
                      </td>
                      <td className={`py-2 text-right ${short && scanned.status === 'BORRADOR' ? 'font-semibold text-red-600' : 'text-slate-500'}`}>
                        {fmtQty(it.stockAvailable)}
                      </td>
                      {checklistMode && (
                        <>
                          <td className="py-2 text-center">
                            {(scanHits[it.productId] ?? 0) > 0
                              ? <Badge color="green">✓ {scanHits[it.productId]}×</Badge>
                              : <span className="text-slate-300">—</span>}
                          </td>
                          <td className="py-2 text-right">
                            <input
                              type="number"
                              min="0"
                              max={it.quantity}
                              step="0.001"
                              value={pickQty[it.productId] ?? ''}
                              onChange={(e) => setPickQty((prev) => ({ ...prev, [it.productId]: e.target.value }))}
                              className="input w-20 text-center"
                            />
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Modal>
        );
      })()}

      {/* ===== Modal resultado de la aceptación ===== */}
      {confirmRes && (
        <Modal
          open
          onClose={() => setConfirmRes(null)}
          title={`Entrega ${confirmRes.deliveryNumber} aceptada`}
          footer={
            <>
              <Button variant="secondary" onClick={() => navigate(`/entregas/${confirmRes.deliveryId}`)}>
                Ver comprobante
              </Button>
              <Button onClick={() => { setConfirmRes(null); setScanOpen(true); }}>Escanear otra orden</Button>
            </>
          }
        >
          {(confirmRes.shortfalls?.length ?? 0) === 0 ? (
            <p className="flex flex-col items-center gap-2 py-6 text-center text-emerald-600">
              <span className="text-4xl">✅</span>
              <span className="font-semibold">Toda la mercadería fue entregada</span>
              <span className="text-xs text-slate-400">
                {confirmRes.fullyDelivered.length} producto(s) · stock descontado de la sucursal de salida
              </span>
            </p>
          ) : (
            <div className="space-y-3">
              <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
                ⚠️ Faltantes detectados: la entrega quedó <strong>PARCIAL</strong>.
              </p>
              <ul className="list-inside list-disc text-sm text-slate-600">
                {confirmRes.shortfalls.map((sf, i) => {
                  const any = sf as { productName?: string; shortfallQuantity?: number };
                  return <li key={i}>{any.productName}: faltan {fmtQty(any.shortfallQuantity ?? 0)}</li>;
                })}
              </ul>
              {confirmRes.pendingDeliveries.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  <div className="font-semibold">Órdenes de retiro creadas (el cliente las retira luego):</div>
                  <ul className="mt-1 list-inside list-disc text-xs">
                    {confirmRes.pendingDeliveries.map((o) => (
                      <li key={o.id}>
                        {o.number} — retira en <strong>{o.pickupLocationName}</strong>. Código escaneable
                        en el comprobante: {o.barcode}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {confirmRes.unresolvedShortfalls && confirmRes.unresolvedShortfalls.length > 0 && (
                <p className="rounded-lg bg-red-50 p-3 text-xs text-red-700">
                  {confirmRes.unresolvedShortfalls.map((u) => `${u.productName}: ${fmtQty(u.quantity)} u. sin stock en ninguna sucursal`).join(' · ')}
                  <br />Quedó una alerta para ADMIN/ENCARGADO.
                </p>
              )}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
