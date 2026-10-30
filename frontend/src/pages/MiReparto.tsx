import { useEffect, useState } from 'react';
import { 
  getMyDriverAssignments, 
  getMyDriverHistory, 
  startDriverDelivery, 
  completeDriverDelivery,
  geocodeAddressApi
} from '../lib/api';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Textarea } from '../components/ui';
import { useToast } from '../components/Toast';
import { fmtDateTime } from '../lib/format';

type Assignment = {
  delivery_id: number;
  reference: string;
  type: 'DELIVERY' | 'TRANSFER';
  status: string;
  delivery_type?: string;
  customer_name?: string | null;
  customer_phone?: string | null;
  delivery_address?: string | null;
  delivery_lat?: number | null;
  delivery_lng?: number | null;
  location_name?: string;
  notes?: string | null;
  delivery_observations?: string | null;
  due_at?: string | null;
  driver_assigned_at?: string | null;
  delivery_started_at?: string | null;
  delivered_at?: string | null;
  created_at?: string;
};

export default function MiReparto() {
  const toast = useToast();
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const [pending, setPending] = useState<Assignment[]>([]);
  const [history, setHistory] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Assignment | null>(null);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [completeNotes, setCompleteNotes] = useState('');
  const [receivedBy, setReceivedBy] = useState('');
  const [acting, setActing] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [p, h] = await Promise.all([getMyDriverAssignments(), getMyDriverHistory()]);
      setPending(p || []);
      setHistory(h || []);
    } catch (e: any) {
      toast.error(e.message || 'Error cargando repartos');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleStart(a: Assignment) {
    setActing(true);
    try {
      await startDriverDelivery(a.type, a.delivery_id);
      toast.success('Reparto iniciado');
      await load();
      setDetail(null);
    } catch (e: any) {
      toast.error(e.message || 'Error al iniciar');
    } finally {
      setActing(false);
    }
  }

  async function openComplete(a: Assignment) {
    setDetail(a);
    setCompleteNotes('');
    setReceivedBy('');
    setCompleteOpen(true);
  }

  async function handleComplete() {
    if (!detail) return;
    if (detail.type === 'DELIVERY' && receivedBy.trim().length < 2) {
      toast.error('Ingresá el nombre de quien recibió la mercadería');
      return;
    }
    setActing(true);
    try {
      await completeDriverDelivery(detail.type, detail.delivery_id, completeNotes.trim() || undefined, receivedBy.trim() || undefined);
      toast.success('Entrega finalizada');
      setCompleteOpen(false);
      setDetail(null);
      await load();
    } catch (e: any) {
      toast.error(e.message || 'Error al finalizar');
    } finally {
      setActing(false);
    }
  }

  function openMaps(a: Assignment) {
    if (a.delivery_lat && a.delivery_lng) {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${a.delivery_lat},${a.delivery_lng}`, '_blank');
      return;
    }
    if (a.delivery_address) {
      const q = encodeURIComponent(a.delivery_address);
      window.open(`https://www.google.com/maps/search/?api=1&query=${q}`, '_blank');
      return;
    }
    toast.warn('Sin dirección para abrir mapa');
  }

  const list = tab === 'pending' ? pending : history;

  return (
    <div>
      <PageHeader
        title="Mi Reparto"
        subtitle="Pendientes y completados asignados a vos"
        actions={
          <div className="flex gap-2">
            <Button variant={tab === 'pending' ? 'primary' : 'secondary'} onClick={() => setTab('pending')}>
              Pendientes ({pending.length})
            </Button>
            <Button variant={tab === 'history' ? 'primary' : 'secondary'} onClick={() => setTab('history')}>
              Historial ({history.length})
            </Button>
          </div>
        }
      />

      <Card>
        {loading ? (
          <div className="p-6 text-center text-sm text-slate-400">Cargando...</div>
        ) : list.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-400">
            {tab === 'pending' ? 'No tenés repartos pendientes' : 'Sin entregas finalizadas'}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {list.map((a) => (
              <div key={`${a.type}-${a.delivery_id}`} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-brand-700">{a.reference}</span>
                    <Badge color={a.type === 'DELIVERY' ? 'blue' : 'amber'}>
                      {a.type === 'DELIVERY' ? 'Entrega' : 'Transferencia'}
                    </Badge>
                    {a.delivery_started_at && !a.delivered_at && <Badge color="green">En camino</Badge>}
                    {a.delivered_at && <Badge color="green">Entregado</Badge>}
                  </div>
                  <div className="mt-1 text-sm text-slate-600">
                    {a.customer_name && <div>{a.customer_name} {a.customer_phone && `· ${a.customer_phone}`}</div>}
                    {a.delivery_address && <div className="text-slate-500">{a.delivery_address}</div>}
                    {a.location_name && <div className="text-xs text-slate-400">Desde: {a.location_name}</div>}
                    {a.due_at && <div className="text-xs text-amber-600">Vence: {fmtDateTime(a.due_at)}</div>}
                    {a.delivery_observations && <div className="mt-1 text-xs text-slate-500">Obs: {a.delivery_observations}</div>}
                    {a.notes && <div className="mt-1 text-xs text-slate-400">Notas: {a.notes}</div>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {a.delivery_address && (
                    <Button size="sm" variant="secondary" onClick={() => openMaps(a)}>
                      🗺️ Ver ruta
                    </Button>
                  )}
                  {tab === 'pending' && !a.delivery_started_at && (
                    <Button size="sm" variant="primary" loading={acting} onClick={() => handleStart(a)}>
                      🚚 Iniciar reparto
                    </Button>
                  )}
                  {tab === 'pending' && a.delivery_started_at && !a.delivered_at && (
                    <Button size="sm" variant="success" onClick={() => openComplete(a)}>
                      ✅ Finalizar entrega
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal
        open={completeOpen}
        onClose={() => setCompleteOpen(false)}
        title={`Finalizar ${detail?.reference || ''}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCompleteOpen(false)}>Cancelar</Button>
            <Button variant="success" loading={acting} disabled={detail?.type === 'DELIVERY' && receivedBy.trim().length < 2} onClick={handleComplete}>Confirmar entrega</Button>
          </>
        }
      >
        {detail?.type === 'DELIVERY' && (
          <Field label="Nombre de quien recibe" required>
            <Input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} maxLength={150} placeholder="Nombre y apellido del receptor" />
          </Field>
        )}
        <Field label="Observaciones de entrega">
          <Textarea rows={3} value={completeNotes} onChange={(e) => setCompleteNotes(e.target.value)} placeholder="Observaciones de entrega..." />
        </Field>
      </Modal>
    </div>
  );
}
