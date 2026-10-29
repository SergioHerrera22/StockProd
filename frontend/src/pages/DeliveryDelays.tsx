import { useEffect, useState } from 'react';
import { getDeliveryDelays } from '../lib/api';
import { Badge, Card, PageHeader } from '../components/ui';
import { useToast } from '../components/Toast';
import { fmtDateTime } from '../lib/format';

type DelayItem = {
  type: 'DELIVERY' | 'TRANSFER';
  id: number;
  number: string;
  status: string;
  driver_user_id?: number | null;
  driver_name?: string | null;
  due_at?: string | null;
  delivery_started_at?: string | null;
  delivered_at?: string | null;
  created_at?: string;
  location_name?: string;
  destination_name?: string;
  delay_minutes: number;
};

export default function DeliveryDelays() {
  const toast = useToast();
  const [items, setItems] = useState<DelayItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getDeliveryDelays()
      .then((res: any) => {
        setItems(res.delays || res.items || []);
      })
      .catch((e: any) => {
        toast.error(e.message || 'Error cargando atrasos');
      })
      .finally(() => setLoading(false));
  }, []);

  function formatDelay(m: number) {
    if (m <= 0) return 'A tiempo';
    const hours = Math.floor(m / 60);
    const mins = m % 60;
    if (hours > 0) return `${hours}h ${mins}m de atraso`;
    return `${mins}m de atraso`;
  }

  return (
    <div>
      <PageHeader
        title="Atrasos en entregas"
        subtitle="Seguimiento de entregas y transferencias vencidas"
      />
      <Card>
        {loading ? (
          <div className="p-6 text-center text-sm text-slate-400">Cargando...</div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-400">Sin entregas con atraso</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                  <th className="px-4 py-2">N°</th>
                  <th className="px-4 py-2">Tipo</th>
                  <th className="px-4 py-2">Chofer</th>
                  <th className="px-4 py-2">Origen/Destino</th>
                  <th className="px-4 py-2">Vencimiento</th>
                  <th className="px-4 py-2">Inicio</th>
                  <th className="px-4 py-2 text-right">Atraso</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, idx) => (
                  <tr key={idx} className="border-b border-slate-100">
                    <td className="px-4 py-2 font-mono font-semibold text-brand-700">{it.number}</td>
                    <td className="px-4 py-2">
                      <Badge color={it.type === 'DELIVERY' ? 'blue' : 'amber'}>
                        {it.type === 'DELIVERY' ? 'Entrega' : 'Transferencia'}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-slate-600">{it.driver_name || 'Sin asignar'}</td>
                    <td className="px-4 py-2 text-slate-600">
                      {it.location_name || it.destination_name || '—'}
                    </td>
                    <td className="px-4 py-2 text-slate-600">{it.due_at ? fmtDateTime(it.due_at) : '—'}</td>
                    <td className="px-4 py-2 text-slate-600">{it.delivery_started_at ? fmtDateTime(it.delivery_started_at) : 'Pendiente'}</td>
                    <td className="px-4 py-2 text-right">
                      <span className={it.delay_minutes > 0 ? 'font-semibold text-red-600' : 'text-slate-500'}>
                        {formatDelay(it.delay_minutes)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
