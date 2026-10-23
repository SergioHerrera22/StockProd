import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs, checkDeliveryAvailability, confirmDeliveryWithAlternatives } from '../lib/api';
import { fmtQty } from '../lib/format';
import { useAuth } from '../store/auth';
import type { Delivery, Location, StockRow, DeliveryAvailabilityItem, UserAlternativeChoice } from '../types';
import {
  Badge, Button, Card, Field, FormRow, Input, Modal, PageHeader, Select, Textarea,
} from '../components/ui';
import { DerivationModal } from '../components/DerivationModal';
import { ScanInput } from '../components/ScanInput';
import { ProductPicker } from '../components/ProductPicker';
import { useToast } from '../components/Toast';
import { hasPermission } from '../lib/permissions';

interface Line {
  productId: number;
  code: string;
  name: string;
  unit: string;
  stock: number;
  minStock: number;
  quantity: number;
  requestedQuantity?: number | null;
}

const emptyLine: Omit<Line, 'productId' | 'code' | 'name' | 'unit'> = { stock: 0, minStock: 0, quantity: 1 };

export default function DeliveryNew() {
  const toast = useToast();
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);

  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState<string>(user?.locationId ? String(user.locationId) : '');
  const [lines, setLines] = useState<Line[]>([]);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stockMap, setStockMap] = useState<Record<string, number>>({});
  const pickerRef = useRef(false);
  
  // Nuevos estados para flujo multi-sucursal
  const [availabilityItems, setAvailabilityItems] = useState<DeliveryAvailabilityItem[]>([]);
  const [altModalOpen, setAltModalOpen] = useState(false);
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const [draftDeliveryId, setDraftDeliveryId] = useState<number | null>(null);

  // Ubicaciones disponibles
  useMemo(() => {
    api<{ locations: Location[] }>('/locations')
      .then((r) => {
        setLocations(r.locations.filter((l) => l.is_active));
        if (!locationId && r.locations.length) {
          const def = r.locations.find((l) => l.id === user?.locationId) ?? r.locations[0];
          setLocationId(String(def.id));
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Busca un producto por código exacto (escaneo) y lo agrega o suma cantidad. */
  const handleScan = useCallback(async (code: string) => {
    if (!locationId) {
      toast.warn('Primero elegí la ubicación de salida');
      return;
    }
    try {
      const res = await api<{ products: StockRow[] }>(`/stock${qs({ q: code, locationId, limit: 5 })}`);
      const match =
        res.products.find((p) => p.code.toLowerCase() === code.toLowerCase() || p.name.toLowerCase() === code.toLowerCase()) ??
        (res.products.length === 1 ? res.products[0] : undefined);
      if (!match) {
        toast.error(`Producto no identificado: "${code}"`);
        return;
      }
      addProduct(match);
    } catch (e) {
      toast.error((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, lines]);

  function addProduct(p: StockRow) {
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.productId === p.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 };
        toast.info(`+1 ${p.name} (total ${next[idx].quantity})`);
        return next;
      }
      const stock = Number(p.total_qty ?? 0);
      return [
        ...prev,
        {
          ...emptyLine,
          productId: p.id,
          code: p.code,
          name: p.name,
          unit: p.unit ?? 'UNIDAD',
          stock,
          minStock: Number(p.min_stock ?? 0),
          quantity: 1,
        },
      ];
    });
  }

  function setQuantity(productId: number, quantity: number) {
    setLines((prev) => prev.map((l) => (l.productId === productId ? { ...l, quantity } : l)));
  }

  function setRequested(productId: number, requested: number | null) {
    setLines((prev) => prev.map((l) => (l.productId === productId ? { ...l, requestedQuantity: requested } : l)));
  }

  /** Refresca el stock actual de los productos cargados (por si cambió). */
  async function refreshStock() {
    if (!locationId || lines.length === 0) return;
    try {
      const res = await api<{ products: StockRow[] }>(`/stock${qs({ locationId, limit: 300 })}`);
      const map: Record<string, number> = {};
      for (const p of res.products) map[p.code] = Number(p.total_qty);
      setStockMap(map);
      toast.info('Stock actualizado');
    } catch { /* silencioso */ }
  }

  const body = {
    locationId: Number(locationId),
    invoiceNumber: invoiceNumber.trim() || null,
    notes: notes.trim() || null,
    items: lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      requestedQuantity: l.requestedQuantity ?? null,
    })),
  };

  function validate(): string | null {
    if (!locationId) return 'Elegí la ubicación de salida';
    if (lines.length === 0) return 'Agregá al menos un producto';
    for (const l of lines) {
      if (!Number.isFinite(l.quantity) || l.quantity <= 0) return `Cantidad inválida en ${l.code}`;
    }
    return null;
  }

  async function saveDraft() {
    const err = lines.length === 0 ? 'Agregá al menos un producto' : null;
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      const res = await api<{ id: number; number: string }>('/deliveries', { method: 'POST', body });
      toast.success(`Borrador ${res.number} guardado (el stock no cambió)`);
      navigate(`/entregas/${res.id}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  /** Paso 1: Verificar disponibilidad antes de confirmar */
  async function checkAvailabilityAndProceed() {
    const err = validate();
    if (err) { toast.error(err); return; }
    
    // Primero guardar como borrador para tener ID
    setSaving(true);
    try {
      const draftRes = await api<{ id: number; number: string }>('/deliveries', { method: 'POST', body });
      const deliveryId = draftRes.id;
      setDraftDeliveryId(deliveryId);
      
      // Verificar disponibilidad
      setCheckingAvailability(true);
      const avail = await checkDeliveryAvailability(deliveryId);
      setAvailabilityItems(avail.items);
      
      if (avail.canFullyDeliverLocally) {
        // Todo disponible localmente -> confirmar directo
        await confirmDeliveryDirect(deliveryId);
      } else {
        // Hay faltantes -> mostrar modal para elegir alternativas
        setAltModalOpen(true);
      }
    } catch (e: any) {
      toast.error('Error verificando stock: ' + e.message);
    } finally {
      setSaving(false);
      setCheckingAvailability(false);
    }
  }

  /** Confirmar entrega directa (todo en local) */
  async function confirmDeliveryDirect(deliveryId: number) {
    try {
      const res = await api<{ id: number; number: string }>(`/deliveries/${deliveryId}/confirm`, { method: 'POST' });
      toast.success(`Entrega ${res.number} confirmada: stock actualizado`);
      navigate(`/entregas/${res.id}`);
    } catch (e: any) {
      toast.error('Error confirmando: ' + e.message);
    }
  }

  /** Confirmar con alternativas elegidas por el usuario */
  async function handleConfirmWithAlternatives(choices: UserAlternativeChoice[]) {
    setAltModalOpen(false);
    if (!draftDeliveryId) {
      toast.error('No hay borrador de entrega activo');
      return;
    }
    setSaving(true);
    try {
      const res = await confirmDeliveryWithAlternatives({ choices }, draftDeliveryId);

      if (res.pendingDeliveries.length > 0) {
        toast.success(
          `Entrega ${res.deliveryNumber} confirmada parcialmente. Se crearon ${res.pendingDeliveries.length} retiro(s): ` +
          res.pendingDeliveries.map(o => o.barcode).join(', ')
        );
      } else {
        toast.success(`Entrega ${res.deliveryNumber} confirmada`);
      }
      if (res.unresolvedShortfalls?.length) {
        toast.warn(
          `Quedó deuda sin derivar: ` +
          res.unresolvedShortfalls.map(u => `${u.productName} x${u.quantity}`).join(', ')
        );
      }
      navigate(`/entregas/${res.deliveryId}`);
    } catch (e: any) {
      toast.error('Error: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  const totalUnits = lines.reduce((acc, l) => acc + (Number(l.quantity) || 0), 0);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Nueva entrega de mercadería"
        subtitle="Verificá y cargá solo lo que realmente se entrega. Si falta stock, podés derivar a otra sucursal."
        actions={<Button variant="secondary" onClick={() => navigate('/entregas')}>← Volver</Button>}
      />

      <Card className="mb-4 p-4">
        <FormRow cols={3}>
          <Field label="Ubicación de salida" required>
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          <Field label="Factura de referencia" hint="Opcional (Tiempo Gestión)">
            <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="0001-00012345" />
          </Field>
          <Field label="Observaciones">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
          </Field>
        </FormRow>
      </Card>

      <Card className="mb-4 p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-700">1 · Escaneá o buscá los productos</h3>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={refreshStock} disabled={!lines.length}>↻ Actualizar stock</Button>
            <Button size="sm" variant="secondary" onClick={() => { pickerRef.current = true; setPickerOpen(true); }}>🔍 Buscar producto</Button>
          </div>
        </div>
        <ScanInput onScan={handleScan} autoFocus placeholder="Escaneá el código de barras o escribí el código…" />
      </Card>

      <Card className="mb-4">
        <div className="border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-700">2 · Revisá las cantidades</h3>
        </div>
        {lines.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-slate-400">
            Escaneá un producto o usá el buscador para agregar la primera línea
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2">Producto</th>
                  <th className="px-3 py-2 text-right">Stock actual</th>
                  <th className="px-3 py-2 text-center">Cant. entregada</th>
                  <th className="px-3 py-2 text-center">Cant. factura</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const liveStock = stockMap[l.code] ?? l.stock;
                  const insufficient = l.quantity > liveStock || (l.requestedQuantity ?? 0) > liveStock;
                  return (
                    <tr key={l.productId} className={`border-b border-slate-100 last:border-0 ${insufficient ? 'bg-red-50' : ''}`}>
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-700">{l.name}</div>
                        <div className="font-mono text-xs text-slate-400">{l.code}</div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className={insufficient ? 'font-bold text-red-600' : 'text-slate-600'}>
                          {fmtQty(liveStock)} {l.unit.toLowerCase()}
                        </span>
                        {insufficient && <div className="text-xs text-red-500">Stock insuficiente - se derivará</div>}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <Input
                          type="number"
                          min="0.001"
                          step="0.001"
                          value={l.quantity}
                          onChange={(e) => setQuantity(l.productId, Number(e.target.value))}
                          className="w-24 text-center"
                          disabled={saving}
                        />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <Input
                          type="number"
                          min="0"
                          step="0.001"
                          value={l.requestedQuantity ?? ''}
                          placeholder="—"
                          onChange={(e) => setRequested(l.productId, e.target.value === '' ? null : Number(e.target.value))}
                          className="w-24 text-center"
                          disabled={saving}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setLines((prev) => prev.filter((x) => x.productId !== l.productId))}
                          disabled={saving}
                        >
                          🗑
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4 shadow-sm">
        <div className="text-sm text-slate-500">
          {lines.length} línea(s) · <strong className="text-slate-700">{fmtQty(totalUnits)}</strong> unidad(es) a entregar
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={saveDraft} loading={saving} disabled={!lines.length}>
            💾 Guardar borrador
          </Button>
          <Button
            variant="success"
            size="lg"
            onClick={checkAvailabilityAndProceed}
            disabled={!lines.length || saving || checkingAvailability || !hasPermission(user?.role, 'deliveries.confirm')}
            title={!hasPermission(user?.role, 'deliveries.confirm') ? 'No tenés permiso para confirmar entregas' : undefined}
          >
            {checkingAvailability ? '⏳ Verificando stock...' : '✅ Confirmar entrega'}
          </Button>
        </div>
      </div>

      {/* Toast is provided by ToastProvider in App.tsx */}

      {/* Modal Derivar Faltantes (componente compartido con el detalle) */}
      <DerivationModal
        open={altModalOpen}
        onClose={() => setAltModalOpen(false)}
        items={availabilityItems}
        onConfirm={handleConfirmWithAlternatives}
      />

      <ProductPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        locationId={Number(locationId)}
        onPick={addProduct}
      />
    </div>
  );
}