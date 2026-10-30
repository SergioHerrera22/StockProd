import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { fmtDateTime, fmtQty } from '../lib/format';
import { useAuth } from '../store/auth';
import type { Location } from '../types';
import { Card, CardHeader, Loading, PageHeader, Select, StatCard, Badge } from '../components/ui';
import { GroupedBars, HBars } from '../components/Charts';
import { useToast } from '../components/Toast';

interface Summary {
  activeProducts: number;
  inventoryValue: number;
  lowStock: number;
  outOfStock: number;
  entriesToday: number;
  exitsToday: number;
  pendingTransfersCount: number;
  pendingTransfers: { id: number; number: string; origin_name: string; destination_name: string; created_at: string }[];
  recentMovements: {
    id: number; type: string; quantity: number; created_at: string;
    product_name: string; product_code: string; location_name: string;
    user_name: string; reference_number: string | null;
  }[];
  byLocation: { id: number; code: string; name: string; type: string; units: number; skus: number; value: number }[];
  series: { day: string; entradas: number; salidas: number }[];
  debts: {
    pickupsPending: number;
    pickupsOverdue: number;
    pickupOrders: {
      id: number; number: string; status: string; created_at: string;
      pickup_location_name: string; pickup_location_code: string;
      customer_name: string | null; customer_phone: string | null;
      pending_units: number;
    }[];
    underivedDeliveries: {
      id: number; number: string; status: string; created_at: string;
      shortfall_lines: number; shortfall_units: number;
    }[];
    underivedCount: number;
  };
}

const TYPE_BADGE: Record<string, { label: string; color: 'green' | 'red' | 'amber' | 'blue' | 'violet' | 'gray' }> = {
  ENTRADA: { label: 'Entrada', color: 'green' },
  SALIDA: { label: 'Salida', color: 'red' },
  AJUSTE_POS: { label: 'Ajuste +', color: 'amber' },
  AJUSTE_NEG: { label: 'Ajuste −', color: 'amber' },
  TRANS_SALIDA: { label: 'Envío', color: 'blue' },
  TRANS_ENTRADA: { label: 'Recepción', color: 'violet' },
};

export default function Dashboard() {
  const user = useAuth((s) => s.user);
  const toast = useToast();
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [locationId, setLocationId] = useState<string>('');
  const [days, setDays] = useState('14');
  const [locations, setLocations] = useState<Location[]>([]);

  useEffect(() => {
    api<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations)).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    api<Summary>(`/dashboard/summary${qs({ locationId, days })}`)
      .then(setData)
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, days]);

  return (
    <div>
      <PageHeader
        title={`Hola, ${user?.fullName?.split(' ')[0] ?? ''} 👋`}
        subtitle="Estado actual de la operación"
        actions={
          <>
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="w-44">
              <option value="">Todas las ubicaciones</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </Select>
            <Select value={days} onChange={(e) => setDays(e.target.value)} className="w-32">
              <option value="7">Últimos 7 días</option>
              <option value="14">Últimos 14 días</option>
              <option value="30">Últimos 30 días</option>
            </Select>
          </>
        }
      />

      {loading && !data ? (
        <Loading />
      ) : data ? (
        <div className="space-y-5">
          {/* Indicadores */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Productos activos" value={data.activeProducts} icon="🧴" />
            <StatCard label="Stock bajo" value={data.lowStock} icon="⚠️" tone={data.lowStock > 0 ? 'warn' : 'default'} />
            <StatCard label="Sin existencias" value={data.outOfStock} icon="🚫" tone={data.outOfStock > 0 ? 'danger' : 'default'} />
            <StatCard label="Entradas hoy" value={fmtQty(data.entriesToday)} icon="📥" tone="good" />
            <StatCard label="Salidas hoy" value={fmtQty(data.exitsToday)} icon="📤" tone="info" />
          </div>

          {/* Gráficos */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-4">
              <h3 className="mb-3 text-sm font-semibold text-slate-700">Movimientos por día</h3>
              <GroupedBars
                data={data.series.map((s) => ({
                  label: new Date(s.day).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }),
                  a: s.entradas,
                  b: s.salidas,
                }))}
                labelA="Entradas"
                labelB="Salidas"
              />
            </Card>
            <Card className="p-4">
              <h3 className="mb-3 text-sm font-semibold text-slate-700">Stock por ubicación</h3>
              <HBars
                data={data.byLocation.map((l) => ({
                  label: l.name,
                  value: l.units,
                  color: l.type === 'DEPOSITO' ? '#f59e0b' : '#2c6396',
                }))}
                valueFormat={(v) => `${fmtQty(v)} u.`}
              />
            </Card>
          </div>

          {/* Deudas con clientes */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title={`Retiros pendientes (${data.debts.pickupsPending})`}
                actions={<Link to="/reservas" className="text-xs font-semibold text-brand-600 hover:underline">Gestionar →</Link>}
              />
              {data.debts.pickupsPending === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-400">No hay retiros pendientes ✅</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.debts.pickupOrders.map((o) => {
                    const vencida = new Date(o.created_at).getTime() < Date.now() - 48 * 3600 * 1000;
                    return (
                      <li key={o.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                        <div className="min-w-0">
                          <div>
                            <span className="font-semibold text-brand-700">{o.number}</span>
                            {o.customer_name && <span className="ml-2 truncate text-slate-600">{o.customer_name}</span>}
                            {vencida && <span className="ml-2 text-xs font-semibold text-red-600">+48h</span>}
                          </div>
                          <div className="text-xs text-slate-400">
                            Retira en {o.pickup_location_name} · {fmtDateTime(o.created_at)}
                          </div>
                        </div>
                        <span className={`shrink-0 text-sm font-semibold ${o.pending_units > 0 ? 'text-amber-600' : 'text-slate-400'}`}>
                          {fmtQty(o.pending_units)} u.
                        </span>
                      </li>
                    );
                  })}
                  {data.debts.pickupsOverdue > 0 && (
                    <li className="bg-red-50 px-4 py-2.5 text-xs text-red-700">
                      ⚠ {data.debts.pickupsOverdue} orden(es) superó el plazo de 48h sin reserva vigente: el auto-cancel la anulará al pasar el scheduler.
                    </li>
                  )}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader
                title={`Faltantes sin derivar (${data.debts.underivedCount})`}
                actions={<Link to="/entregas" className="text-xs font-semibold text-brand-600 hover:underline">Ver entregas →</Link>}
              />
              {data.debts.underivedCount === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-400">Nadie está esperando reposición ✅</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.debts.underivedDeliveries.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                      <div className="min-w-0">
                        <div>
                          <span className="font-semibold text-brand-700">{d.number}</span>
                          <Badge color={d.status === 'PARCIAL' ? 'amber' : 'green'}>{d.status === 'PARCIAL' ? 'Parcial' : 'Entregada'}</Badge>
                        </div>
                        <div className="text-xs text-slate-400">{d.shortfall_lines} producto(s) · {fmtDateTime(d.created_at)}</div>
                      </div>
                      <span className="shrink-0 text-sm font-semibold text-amber-600">
                        {fmtQty(d.shortfall_units)} u.
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* Transferencias pendientes + movimientos recientes */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title={`Transferencias pendientes (${data.pendingTransfersCount})`}
                actions={<Link to="/transferencias" className="text-xs font-semibold text-brand-600 hover:underline">Ver todas →</Link>}
              />
              {data.pendingTransfers.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-400">No hay mercadería en tránsito ✅</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.pendingTransfers.map((t) => (
                    <li key={t.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                      <div>
                        <span className="font-semibold text-brand-700">{t.number}</span>
                        <span className="ml-2 text-slate-500">{t.origin_name} → {t.destination_name}</span>
                      </div>
                      <span className="text-xs text-slate-400">{fmtDateTime(t.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader
                title="Movimientos recientes"
                actions={<Link to="/movimientos" className="text-xs font-semibold text-brand-600 hover:underline">Ver historial →</Link>}
              />
              <ul className="divide-y divide-slate-100">
                {data.recentMovements.map((m) => {
                  const badge = TYPE_BADGE[m.type] ?? { label: m.type, color: 'gray' as const };
                  return (
                    <li key={m.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                      <div className="min-w-0">
                        <div className="truncate font-medium text-slate-700">{m.product_name}</div>
                        <div className="text-xs text-slate-400">
                          {m.location_name} · {m.user_name} · {fmtDateTime(m.created_at)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge color={badge.color}>{badge.label}</Badge>
                        <span className={`font-semibold ${['SALIDA', 'AJUSTE_NEG', 'TRANS_SALIDA'].includes(m.type) ? 'text-red-600' : 'text-emerald-600'}`}>
                          {['SALIDA', 'AJUSTE_NEG', 'TRANS_SALIDA'].includes(m.type) ? '−' : '+'}{fmtQty(m.quantity)}
                        </span>
                      </div>
                    </li>
                  );
                })}
                {data.recentMovements.length === 0 && (
                  <li className="px-4 py-6 text-center text-sm text-slate-400">Aún no hay movimientos registrados</li>
                )}
              </ul>
            </Card>
          </div>
        </div>
      ) : null}
    </div>
  );
}
