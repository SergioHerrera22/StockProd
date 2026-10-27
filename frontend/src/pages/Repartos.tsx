/**
 * REPARTOS / TRANSPORTE — listado de viajes + mapa en vivo.
 * El admin ve todos los viajes; una sucursal restringida ve los de su
 * ubicación (el backend filtra con locationGuard). El mapa se refresca solo
 * cada 15s (polling, patrón de Users.tsx).
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Trip, TripStatus } from '../types';
import { tripStatusStyle } from '../types';
import { api, qs, listTrips } from '../lib/api';
import { fmtDateTimeShort } from '../lib/format';
import { useAuth } from '../store/auth';
import { Badge, Button, Card, PageHeader, Select, Spinner, Tabs, StatCard, EmptyState } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';
import MapView, { type MapMarker } from '../components/MapView';
import type { Location } from '../types';

const LIVE_REFRESH_MS = 15000;

/** Timestamp relativo simple: "hace 2 min" */
function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

export default function Repartos() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const [tab, setTab] = useState<'viajes' | 'mapa'>('viajes');

  return (
    <div className="space-y-4">
      <PageHeader
        title="Repartos / Transporte"
        subtitle="Viajes de la camioneta con paradas y seguimiento GPS en vivo"
        actions={
          tab === 'viajes' && can('tracking.write') ? (
            <Button variant="primary" onClick={() => navigate('/repartos/nuevo')}>+ Nuevo viaje</Button>
          ) : undefined
        }
      />

      <Tabs<'viajes' | 'mapa'>
        tabs={[
          { key: 'viajes', label: 'Viajes' },
          { key: 'mapa', label: 'Mapa en vivo' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'viajes' ? <ViajesTab /> : <LiveMapTab />}
    </div>
  );
}

/* ============================== LISTA DE VIAJES ============================== */

function ViajesTab() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [rows, setRows] = useState<Trip[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [originLocationId, setOriginLocationId] = useState(user?.locationId ? String(user.locationId) : '');
  const [locations, setLocations] = useState<Location[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listTrips({ status: status || undefined, originLocationId: originLocationId ? Number(originLocationId) : undefined, page, pageSize: 15 });
      setRows(res.trips);
      setTotal(res.total);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [status, originLocationId, page]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    api<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations)).catch(() => {});
  }, []);

  const columns: Column<Trip>[] = [
    { key: 'number', label: 'Viaje', render: (t) => <span className="font-semibold text-brand-800">{t.number}</span> },
    { key: 'status', label: 'Estado', render: (t) => { const s = tripStatusStyle(t.status); return <Badge color={s.color}>{s.label}</Badge>; } },
    { key: 'origin_name', label: 'Origen', value: (t) => t.origin_name, render: (t) => (t.origin_code ? `${t.origin_code} · ` : '') + (t.origin_name ?? '—') },
    { key: 'driver_name', label: 'Chofer', value: (t) => t.driver_name },
    { key: 'vehicle', label: 'Vehículo', value: (t) => t.vehicle ?? '' },
    {
      key: 'stops', label: 'Paradas', value: (t) => t.delivered_count ?? 0,
      render: (t) => {
        const done = t.delivered_count ?? 0;
        const tot = t.stop_count ?? 0;
        return <span className={done === tot && tot > 0 ? 'font-semibold text-emerald-700' : ''}>{done}/{tot}</span>;
      },
    },
    {
      key: 'last_position', label: 'GPS', value: (t) => t.last_position?.recorded_at ?? '',
      render: (t) =>
        t.last_position ? (
          <span className="text-blue-700 font-medium" title={t.last_position.lat + ', ' + t.last_position.lng}>
            📍 hace {ago(t.last_position.recorded_at)}
          </span>
        ) : (
          <span className="text-slate-400">sin señal</span>
        ),
    },
    {
      key: 'departed_at', label: 'Salió', value: (t) => t.departed_at ?? '',
      render: (t) => fmtDateTimeShort(t.departed_at),
    },
  ];

  return (
    <div className="space-y-3">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-44">
          <label className="mb-1 block text-xs font-semibold uppercase text-slate-500">Estado</label>
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">Todos</option>
            <option value="EN_PREPARACION">En preparación</option>
            <option value="EN_RUTA">En ruta</option>
            <option value="COMPLETADO">Completado</option>
            <option value="CANCELADO">Cancelado</option>
          </Select>
        </div>
        <div className="w-56">
          <label className="mb-1 block text-xs font-semibold uppercase text-slate-500">Sucursal de salida</label>
          <Select value={originLocationId} onChange={(e) => { setOriginLocationId(e.target.value); setPage(1); }}>
            <option value="">Todas</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.code} · {l.name}</option>
            ))}
          </Select>
        </div>
      </Card>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(t) => t.id}
        onRowClick={(t) => navigate(`/repartos/${t.id}`)}
        loading={loading}
        emptyTitle="Sin viajes"
        emptyHint="Cuando se cargue un reparto (EN + transferencias + órdenes de retiro) aparece acá."
        pageSize={15}
        total={total}
        page={page}
        onPageChange={setPage}
      />
    </div>
  );
}

/* ============================== MAPA EN VIVO ============================== */

function LiveMapTab() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await api<{ trips: Trip[] }>('/tracking/live');
      setTrips(r.trips);
    } catch (e) {
      if (!silent) toast.error((e as Error).message);
    } finally {
      if (!silent) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(true), LIVE_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const inRoute = trips.filter((t) => t.status === 'EN_RUTA');
  const preparing = trips.filter((t) => t.status === 'EN_PREPARACION');

  const markers: MapMarker[] = [];
  for (const t of trips) {
    if (!t.last_position) continue;
    const isSel = selected === t.id;
    markers.push({
      id: `trip-${t.id}`,
      lat: t.last_position.lat,
      lng: t.last_position.lng,
      tone: 'vehicle',
      focus: isSel,
      tooltip: `${t.number} · ${t.driver_name}`,
      popup:
        `<b>${t.number}</b> · ${t.driver_name}` +
        (t.vehicle ? ` (${t.vehicle})` : '') +
        `<br/>Se actualizó hace ${ago(t.last_position.recorded_at)}` +
        `<br/>Paradas entregadas: ${t.delivered_count}/${t.stop_count}` +
        `<br/><i>${t.origin_code ?? ''} · ${t.origin_name ?? ''}</i>`,
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
      {/* Panel de viajes activos */}
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <StatCard label="En ruta" value={inRoute.length} icon="🚐" tone="default" />
          <StatCard label="En preparación" value={preparing.length} icon="📦" />
        </div>

        {loading ? (
          <div className="flex justify-center py-10"><Spinner size="lg" /></div>
        ) : trips.length === 0 ? (
          <EmptyState icon="🗺️" title="No hay repartos activos" hint="Los viajes EN_RUTA con GPS activo aparecen acá en tiempo real." />
        ) : (
          <div className="space-y-2">
            {trips.map((t) => {
              const s = tripStatusStyle(t.status);
              return (
                <button
                  key={t.id}
                  onClick={() => setSelected(t.id)}
                  className={`w-full rounded-xl border p-3 text-left transition-shadow hover:shadow-md ${
                    selected === t.id ? 'border-blue-400 ring-2 ring-blue-200 bg-blue-50' : 'border-slate-200 bg-white'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-brand-800">{t.number}</span>
                    <Badge color={s.color}>{s.label}</Badge>
                  </div>
                  <div className="mt-1 text-sm text-slate-600">
                    🚐 {t.driver_name}{t.vehicle ? ` · ${t.vehicle}` : ''}
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
                    <span>Paradas {t.delivered_count}/{t.stop_count}</span>
                    {t.last_position && <span className="text-blue-700 font-medium">📍 GPS hace {ago(t.last_position.recorded_at)}</span>}
                  </div>
                  {selected === t.id && (
                    <div className="mt-2 border-t border-slate-200 pt-2 text-xs text-slate-600">
                      {t.stops?.slice(0, 6).map((st) => (
                        <div key={st.id} className="flex items-center justify-between gap-2 py-0.5">
                          <span className={st.delivered_at ? 'line-through text-slate-400' : ''}>
                            {st.sequence}. {st.reference} · {st.location_name ?? st.customer_name ?? st.address}
                          </span>
                          <span>{st.delivered_at ? '✓' : ''}</span>
                        </div>
                      ))}
                      {t.stops && t.stops.length > 6 && <div className="text-slate-400">…y {t.stops.length - 6} más</div>}
                      {user && can('tracking.read') && (
                        <button className="mt-1 font-semibold text-blue-700 hover:underline" onClick={(e) => { e.stopPropagation(); navigate(`/repartos/${t.id}`); }}>
                          Ver detalle →
                        </button>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <p className="text-[11px] text-slate-400">Se actualiza automáticamente cada {LIVE_REFRESH_MS / 1000}s.</p>
      </div>

      {/* Mapa */}
      <Card className="p-3">
        {markers.length > 0 ? (
          <MapView markers={markers} followKey={selected ?? undefined} height="h-[560px]" />
        ) : (
          <div className="flex h-[560px] items-center justify-center rounded-xl border border-dashed border-slate-300 text-slate-400">
            {loading ? <Spinner size="lg" /> : 'Sin posiciones GPS para mostrar todavía'}
          </div>
        )}
      </Card>
    </div>
  );
}
