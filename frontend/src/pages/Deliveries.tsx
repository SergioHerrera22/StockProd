import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { fmtDateTime, fmtQty } from '../lib/format';
import type { Delivery, Location } from '../types';
import { Badge, Button, Card, Input, PageHeader, Select } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';

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

export default function Deliveries() {
  const toast = useToast();
  const navigate = useNavigate();
  const [rows, setRows] = useState<Delivery[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [locationId, setLocationId] = useState('');
  const [q, setQ] = useState('');
  const [locations, setLocations] = useState<Location[]>([]);

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

  const columns: Column<Delivery>[] = [
    { key: 'number', label: 'N°', sortable: true, render: (d) => <span className="font-mono font-semibold text-brand-700">{d.number}</span> },
    { key: 'created_at', label: 'Fecha', sortable: true, render: (d) => fmtDateTime(d.created_at) },
    { key: 'location_name', label: 'Sale de', render: (d) => d.location_name },
    { key: 'invoice_number', label: 'Factura ref.', render: (d) => d.invoice_number ?? '—' },
    { key: 'line_count', label: 'Líneas', align: 'right', render: (d) => d.line_count ?? '—' },
    { key: 'total_items', label: 'Unidades', align: 'right', render: (d) => fmtQty(d.total_items ?? 0) },
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
        actions={<Button onClick={() => navigate('/entregas/nueva')}>+ Nueva entrega</Button>}
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
    </div>
  );
}
