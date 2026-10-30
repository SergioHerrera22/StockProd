import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs, checkDeliveryAvailability, confirmDeliveryWithAlternatives, getDrivers, geocodeAddressApi } from '../lib/api';
import { fmtQty } from '../lib/format';
import { useAuth } from '../store/auth';
import type { Delivery, Location, StockRow, DeliveryAvailabilityItem, UserAlternativeChoice } from '../types';
import { availableOf } from '../types';
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

  // Home delivery / driver
  const [deliveryType, setDeliveryType] = useState<'NORMAL' | 'DOMICILIO'>('NORMAL');
  const [drivers, setDrivers] = useState<any[]>([]);
  const [driverUserId, setDriverUserId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryLat, setDeliveryLat] = useState<number | null>(null);
  const [deliveryLng, setDeliveryLng] = useState<number | null>(null);
  const [dueAt, setDueAt] = useState('');
  const [deliveryObservations, setDeliveryObservations] = useState('');
  const [geocoding, setGeocoding] = useState(false);

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

  useEffect(() => {
    getDrivers().then((d) => setDrivers(d || [])).catch(() => {});
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
      const stock = availableOf(p);
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
      for (const p of res.products) map[p.code] = availableOf(p);
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
    deliveryType,
    customerName: customerName.trim() || null,
    customerPhone: customerPhone.trim() || null,
    deliveryAddress: deliveryAddress.trim() || null,
    deliveryLat,
    deliveryLng,
    driverUserId: driverUserId ? Number(driverUserId) : null,
    dueAt: dueAt ? new Date(dueAt).toISOString() : null,
    deliveryObservations: deliveryObservations.trim() || null,
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
  async function geocode() {
    if (!deliveryAddress.trim()) {
      toast.warn('Ingresá una dirección');
      return;
    }
    setGeocoding(true);
    try {
      const res: any = await geocodeAddressApi(deliveryAddress.trim());
      if (res.lat && res.lng) {
        setDeliveryLat(res.lat);
        setDeliveryLng(res.lng);
        toast.success('Dirección geolocalizada');
      } else {
        toast.warn('No se pudo geolocalizar la dirección');
      }
    } catch (e: any) {
      toast.error(e.message || 'Error al geolocalizar');
    } finally {
      setGeocoding(false);
    }
  }

  async function checkAvailabilityAndProceed() {
    const err = validate();
    if (err) { toast.error(err); return; }
    if (deliveryType === 'DOMICILIO' && !deliveryAddress.trim()) {
      toast.error('Ingresá la dirección de entrega a domicilio');
      return;
    }
    
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
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">Entrega / Reparto</h3>
        </div>
        <FormRow cols={3}>
          <Field label="Tipo de entrega">
            <Select value={deliveryType} onChange={(e) => setDeliveryType(e.target.value as any)}>
              <option value="NORMAL">Normal</option>
              <option value="DOMICILIO">Enviar a domicilio</option>
            </Select>
          </Field>
          <Field label="Chofer asignado">
            <Select value={driverUserId} onChange={(e) => setDriverUserId(e.target.value)}>
              <option value="">Sin asignar</option>
              {drivers.map((d: any) => (
                <option key={d.id} value={d.id}>{d.full_name || d.username}</option>
              ))}
            </Select>
          </Field>
          <Field label="Vencimiento / Hora límite">
            <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </Field>
        </FormRow>
        {(deliveryType === 'DOMICILIO' || driverUserId) && (
          <div className="mt-3 space-y-3">
            <FormRow cols={2}>
              <Field label="Cliente">
                <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Nombre y apellido" />
              </Field>
              <Field label="Teléfono">
                <Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="Contacto" />
              </Field>
            </FormRow>
            <Field label="Dirección de entrega" required={deliveryType === 'DOMICILIO'}>
              <div className="flex gap-2">
                <Input value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} placeholder="Calle, número, localidad" className="flex-1" />
                <Button type="button" variant="secondary" loading={geocoding} onClick={geocode}>Buscar en mapa</Button>
              </div>
              {deliveryLat && deliveryLng && (
                <div className="mt-1 text-xs text-emerald-600">Geolocalizado: {deliveryLat.toFixed(6)}, {deliveryLng.toFixed(6)}</div>
              )}
            </Field>
            <Field label="Observaciones para el repartidor">
              <Textarea rows={2} value={deliveryObservations} onChange={(e) => setDeliveryObservations(e.target.value)} placeholder="Instrucciones, piso, portero..." />
            </Field>
          </div>
        )}
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
            Escaneá un producto o usá el buscador para agregar el primer producto
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
                          size="lg"
                          variant="ghost"
                          className="!h-10 !w-10 !min-w-10 !p-0 text-xl leading-none"
                          aria-label="Eliminar producto de la entrega"
                          title="Eliminar producto"
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
          {lines.length} producto(s) · <strong className="text-slate-700">{fmtQty(totalUnits)}</strong> unidad(es) a entregar
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