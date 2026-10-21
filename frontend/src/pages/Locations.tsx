import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Location } from '../types';
import { Badge, Button, Card, Field, FormRow, Input, Modal, PageHeader, Select } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';

interface FormState {
  id?: number;
  code: string;
  name: string;
  type: 'SUCURSAL' | 'DEPOSITO';
  address: string;
  isActive: boolean;
}

const emptyForm: FormState = { code: '', name: '', type: 'SUCURSAL', address: '', isActive: true };

export default function Locations() {
  const toast = useToast();
  const [rows, setRows] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ locations: Location[] }>('/locations');
      setRows(res.locations);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!form.code.trim() || !form.name.trim()) {
      toast.error('Código y nombre son obligatorios');
      return;
    }
    setSaving(true);
    const body = {
      code: form.code.trim().toUpperCase(),
      name: form.name.trim(),
      type: form.type,
      address: form.address.trim() || null,
      isActive: form.isActive,
    };
    try {
      if (form.id) {
        await api(`/locations/${form.id}`, { method: 'PUT', body });
        toast.success('Ubicación actualizada');
      } else {
        await api('/locations', { method: 'POST', body });
        toast.success('Ubicación creada');
      }
      setOpen(false);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const columns: Column<Location>[] = [
    { key: 'code', label: 'Código', render: (l) => <span className="font-mono font-semibold text-slate-700">{l.code}</span> },
    { key: 'name', label: 'Nombre', sortable: true },
    { key: 'type', label: 'Tipo', render: (l) => <Badge color={l.type === 'DEPOSITO' ? 'amber' : 'blue'}>{l.type === 'DEPOSITO' ? 'Depósito' : 'Sucursal'}</Badge> },
    { key: 'address', label: 'Dirección', render: (l) => l.address ?? '—' },
    { key: 'is_active', label: 'Estado', render: (l) => (l.is_active ? <Badge color="green">Activa</Badge> : <Badge color="gray">Inactiva</Badge>) },
    {
      key: 'actions', label: '', align: 'right', render: (l) => (
        <Button size="sm" variant="secondary" onClick={() => {
          setForm({ id: l.id, code: l.code, name: l.name, type: l.type, address: l.address ?? '', isActive: l.is_active });
          setOpen(true);
        }}>
          Editar
        </Button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Ubicaciones"
        subtitle="Sucursales y depósito general"
        actions={<Button onClick={() => { setForm(emptyForm); setOpen(true); }}>+ Nueva ubicación</Button>}
      />

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(l) => l.id}
          loading={loading}
          pageSize={20}
          emptyTitle="No hay ubicaciones"
        />
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={form.id ? `Editar ${form.name}` : 'Nueva ubicación'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button loading={saving} onClick={save}>Guardar</Button>
          </>
        }
      >
        <FormRow cols={2}>
          <Field label="Código" required>
            <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="Ej: SUC1" maxLength={10} />
          </Field>
          <Field label="Nombre" required>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ej: Sucursal 1" />
          </Field>
          <Field label="Tipo" required>
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'SUCURSAL' | 'DEPOSITO' })}>
              <option value="SUCURSAL">Sucursal</option>
              <option value="DEPOSITO">Depósito</option>
            </Select>
          </Field>
          <Field label="Dirección">
            <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </Field>
        </FormRow>
        <p className="mt-3 text-xs text-slate-400">
          El stock de cada ubicación es independiente: los saldos nunca se mezclan entre sucursales.
        </p>
      </Modal>
    </div>
  );
}
