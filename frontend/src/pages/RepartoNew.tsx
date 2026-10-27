/**
 * NUEVO REPARTO — arma el viaje: sucursal de salida, chofer/vehículo y la
 * LISTA ORDENADA de paradas. Las paradas son documentos elegibles:
 *  - Entregas (EN) confirmadas de esa sucursal (pedidos a domicilio)
 *  - Transferencias EN_TRANSITO que salen de esa sucursal
 *  - Órdenes de retiro (PD) cuya mercadería sale de esa sucursal
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { AvailableDocs, StopDocType } from '../types';
import { api } from '../lib/api';
import { createTrip, getAvailableDocs } from '../lib/api';
import { fmtDateTimeShort } from '../lib/format';
import { useAuth } from '../store/auth';
import { Badge, Button, Card, Field, FormRow, Input, PageHeader, Select, Spinner, Textarea, EmptyState } from '../components/ui';
import { useToast } from '../components/Toast';
import type { Location } from '../types';

interface DraftStop {
  key: string;
  docType: StopDocType;
  docId: number;
  reference: string;
  subtitle: string;
  customerName?: string | null;
  address?: string | null;
}

type Candidate = DraftStop & { createdAt?: string | null; status: string };

export default function RepartoNew() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  /** Puede venir ?origin=NN&delivery=ID (pre-carga una parada) */
  const params = useParams();

  const [locations, setLocations] = useState<Location[]>([]);
  const [originLocationId, setOriginLocationId] = useState<string>(
    (typeof params.origin === 'number' ? params.origin : undefined) ?? (user?.locationId ? String(user.locationId) : '')
  );
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [notes, setNotes] = useState('');

  const [avail, setAvail] = useState<AvailableDocs | null>(null);
  const [loadingDocs, setLoadingDocs] = useState(false);
  /** Error cargando documentos: sin esto, un fallo de red/pagina reintentaba
   *  render con avail=null y crasheaba en avail!.deliveries (TypeError). */
  const [docsError, setDocsError] = useState(false);
  const [stops, setStops] = useState<DraftStop[]>([]);
  const [saving, setSaving] = useState(false);

  const loadDocs = useCallback(async (origin: string) => {
    if (!origin) { setAvail(null); setDocsError(false); return; }
    setLoadingDocs(true);
    setDocsError(false);
    try {
      setAvail(await getAvailableDocs(Number(origin)));
    } catch (e) {
      toast.error((e as Error).message);
      setAvail(null);
      setDocsError(true);
    } finally {
      setLoadingDocs(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations)).catch(() => {});
  }, []);

  useEffect(() => { void loadDocs(originLocationId); }, [originLocationId, loadDocs]);

  // Si llegó a la página desde una entrega con ?delivery=ID, pre-selecciónala
  useEffect(() => {
    const preDelivery = typeof params.delivery === 'string' ? params.delivery : undefined;
    if (!preDelivery) return;
    const t = window.setInterval(() => {
      if (avail) {
        window.clearInterval(t);
        const d = avail.deliveries.find((x) => x.id === Number(preDelivery));
        if (d) addStop(d.id, 'DELIVERY');
      }
    }, 300);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avail, params.delivery]);

  const origin = originLocationId ? Number(originLocationId) : 0;
  const originName = useMemo(
    () => locations.find((l) => l.id === origin)?.name ?? '',
    [locations, origin]
  );

  function addStop(docId: number, docType: StopDocType, customerName?: string | null, address?: string | null) {
    if (!avail) return;
    if (stops.some((s) => s.docType === docType && s.docId === docId)) {
      toast.warn('Ese documento ya está en el viaje');
      return;
    }
    let c: Candidate | null = null;
    if (docType === 'DELIVERY') {
      const d = avail.deliveries.find((x) => x.id === docId);
      if (d) c = { key: `D-${d.id}`, docType, docId, reference: d.number, subtitle: 'Pedido a domicilio', customerName, address, createdAt: d.created_at, status: d.status };
    } else if (docType === 'TRANSFER') {
      const t = avail.transfers?.find((x) => x.id === docId);
      if (t) c = { key: `T-${t.id}`, docType, docId, reference: t.number, subtitle: `→ ${t.destination_name ?? t.destination_location_id ?? ''}`, createdAt: t.created_at, status: t.status };
    } else {
      const p = avail.pendingDeliveries?.find((x) => x.id === docId);
      if (p) c = { key: `P-${p.id}`, docType, docId, reference: p.number, subtitle: `Retiro → ${p.pickup_location_name ?? p.pickup_location_id ?? ''}${p.customer_name ? ` · ${p.customer_name}` : ''}`, createdAt: p.created_at, status: p.status };
    }
    if (!c) { toast.error('Ese documento ya no está disponible'); return; }
    setStops((prev) => [
      ...prev,
      { key: `${c!.key}-${Date.now()}`, docType: c!.docType, docId: c!.docId, reference: c!.reference, subtitle: c!.subtitle, customerName: c!.customerName, address: c!.address },
    ]);
  }

  function move(idx: number, dir: -1 | 1) {
    setStops((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }

  /** Edita cliente/dirección de la parada inline (pedidos a domicilio) */
  function editStop(idx: number, patch: Partial<DraftStop>) {
    setStops((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }

  async function submit() {
    if (!origin) return toast.error('Elegí la sucursal de salida');
    if (driverName.trim().length < 2) return toast.error('Indicá el nombre del chofer');
    if (stops.length === 0) return toast.error('Agregá al menos una parada');
    setSaving(true);
    try {
      const trip = await createTrip({
        originLocationId: origin,
        driverName: driverName.trim(),
        driverPhone: driverPhone.trim() || null,
        vehicle: vehicle.trim() || null,
        notes: notes.trim() || null,
        stops: stops.map((s) => ({
          docType: s.docType,
          docId: s.docId,
          customerName: s.customerName || null,
          address: s.address || null,
        })),
      });
      toast.success(`Viaje ${trip.number} creado`);
      navigate(`/repartos/${trip.id}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const noDocs = avail && (avail.deliveries.length === 0 && !avail.transfers?.length && !avail.pendingDeliveries?.length);

  return (
    <div className="space-y-4">
      <PageHeader title="Nuevo viaje de reparto" subtitle="Orden de paradas de la camioneta con seguimiento GPS" />

      <Card className="p-4">
        <FormRow cols={2}>
          <Field label="Sucursal de salida" required hint="De dónde sale la camioneta">
            <Select value={originLocationId} onChange={(e) => { setOriginLocationId(e.target.value); setStops([]); }}>
              <option value="">Seleccionar…</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Chofer" required>
            <Input value={driverName} onChange={(e) => setDriverName(e.target.value)} placeholder="Nombre y apellido" maxLength={120} />
          </Field>
        </FormRow>
        <FormRow cols={3}>
          <Field label="Teléfono del chofer">
            <Input value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} placeholder="Opcional" maxLength={40} />
          </Field>
          <Field label="Vehículo" hint="Modelo + patente">
            <Input value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="Ej: Fiorino ABC123" maxLength={120} />
          </Field>
          <Field label="Notas del viaje">
            <Textarea rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" maxLength={500} />
          </Field>
        </FormRow>
      </Card>

      {/* Selección de paradas */}
      <Card>
        <div className="border-b border-slate-200 p-4">
          <h3 className="font-bold text-brand-800">Documentos a transportar {originName ? `· salen de ${originName}` : ''}</h3>
          <p className="text-sm text-slate-500">Elegí entregas, transferencias y órdenes de retiro activas. El orden define la ruta.</p>
        </div>
        <div className="p-4">
          {!origin ? (
            <EmptyState icon="🏪" title="Elegí primero la sucursal de salida" />
          ) : loadingDocs ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : docsError ? (
            <EmptyState icon="⚠️" title="No se pudieron cargar los documentos" hint="Revisá tu conexión y volvé a elegir la sucursal para reintentar." />
          ) : noDocs ? (
            <EmptyState icon="📭" title="No hay documentos disponibles" hint="Faltan entregas confirmadas, transferencias EN_TRANSITO u órdenes de retiro pendientes desde esa sucursal." />
          ) : (
            <div className="space-y-4">
              {(avail?.deliveries?.length ?? 0) > 0 && (
                <PickerGroup title="Entregas (pedidos)" accent="blue">
                  {avail?.deliveries?.map((d) => (
                    <PickerRow
                      key={d.id}
                      onAdd={() => addStop(d.id, 'DELIVERY')}
                      active={stops.some((s) => s.docType === 'DELIVERY' && s.docId === d.id)}
                    >
                      <span className="font-semibold">{d.number}</span>
                      <Badge color="blue">{d.status}</Badge>
                      {d.invoice_number && <span className="text-slate-500">Fac. {d.invoice_number}</span>}
                      <span className="text-xs text-slate-400">{fmtDateTimeShort(d.created_at)}</span>
                    </PickerRow>
                  ))}
                </PickerGroup>
              )}
              {!!avail?.transfers?.length && (
                <PickerGroup title="Transferencias a otros locales">
                  {avail.transfers.map((t) => (
                    <PickerRow
                      key={t.id}
                      onAdd={() => addStop(t.id, 'TRANSFER')}
                      active={stops.some((s) => s.docType === 'TRANSFER' && s.docId === t.id)}
                    >
                      <span className="font-semibold">{t.number}</span>
                      <Badge color="blue">{t.status}</Badge>
                      <span className="text-slate-600">destino: {t.destination_name}</span>
                    </PickerRow>
                  ))}
                </PickerGroup>
              )}
              {!!avail?.pendingDeliveries?.length && (
                <PickerGroup title="Ordenes de retiro (mercadería en tránsito a retiro Sucursal)">
                  {avail.pendingDeliveries.map((p) => (
                    <PickerRow
                      key={p.id}
                      onAdd={() => addStop(p.id, 'PENDING_DELIVERY', p.customer_name)}
                      active={stops.some((s) => s.docType === 'PENDING_DELIVERY' && s.docId === p.id)}
                    >
                      <span className="font-semibold">{p.number}</span>
                      <Badge color="blue">{p.status}</Badge>
                      <span className="text-slate-600">retira en {p.pickup_location_name}, fijo: {p.customer_name}</span>
                    </PickerRow>
                  ))}
                </PickerGroup>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* Rutas armada */}
      <Card>
        <div className="border-b border-slate-200 p-4">
          <h3 className="font-bold text-brand-800">Orden de paradas ({stops.length})</h3>
        </div>
        {stops.length === 0 ? (
          <div className="p-4 text-sm text-slate-500">Todavía no agregaste paradas</div>
        ) : (
          <ol className="divide-y divide-slate-100 p-2">
            {stops.map((s, i) => (
              <li key={s.key} className="flex flex-wrap items-center gap-2 rounded-lg p-2 hover:bg-slate-50">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-700 text-sm font-bold text-white">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{s.reference}</span>
                    <Badge color={s.docType === 'DELIVERY' ? 'blue' : s.docType === 'TRANSFER' ? 'violet' : 'amber'}>
                      {s.docType === 'DELIVERY' ? 'Pedido' : s.docType === 'TRANSFER' ? 'Transferencia' : 'Retiro'}
                    </Badge>
                    <span className="truncate text-sm text-slate-500">{s.subtitle}</span>
                  </div>
                  {(s.docType === 'DELIVERY' || s.docType === 'PENDING_DELIVERY') && (
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Input
                        className="w-56 text-sm"
                        placeholder="Cliente (opcional)"
                        value={s.customerName ?? ''}
                        onChange={(e) => editStop(i, { customerName: e.target.value })}
                      />
                      <Input
                        className="w-72 text-sm"
                        placeholder="Dirección de entrega (opcional)"
                        value={s.address ?? ''}
                        onChange={(e) => editStop(i, { address: e.target.value })}
                      />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => move(i, -1)} disabled={i === 0}>↑</Button>
                  <Button variant="ghost" size="sm" onClick={() => move(i, 1)} disabled={i === stops.length - 1}>↓</Button>
                  <Button variant="danger" size="sm" onClick={() => setStops((prev) => prev.filter((x) => x.key !== s.key))}>Sacar</Button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <div className="flex justify-end gap-2 pb-4">
        <Button variant="secondary" onClick={() => navigate('/repartos')}>Cancelar</Button>
        <Button variant="primary" loading={saving} onClick={submit}>
          Crear viaje{stops.length > 0 ? ` (${stops.length} paradas)` : ''}
        </Button>
      </div>
    </div>
  );
}

/* ============================== piezas chicas ============================== */

function PickerGroup({ title, accent = 'blue', children }: { title: string; accent?: 'blue' | 'amber' | 'violet'; children: React.ReactNode }) {
  const border = accent === 'blue' ? 'border-blue-100' : accent === 'amber' ? 'border-amber-100' : 'border-violet-100';
  return (
    <div>
      <div className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">{title}</div>
      <div className={`divide-y divide-slate-100 rounded-xl border ${border} bg-white`}>{children}</div>
    </div>
  );
}

function PickerRow({ children, onAdd, active }: { children: React.ReactNode; onAdd: () => void; active: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
      {children}
      <div className="ml-auto">
        {active ? (
          <Badge color="green">En el viaje ✓</Badge>
        ) : (
          <Button variant="secondary" size="sm" onClick={onAdd}>Agregar</Button>
        )}
      </div>
    </div>
  );
}
