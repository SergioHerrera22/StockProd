import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtDateTime, fmtDateTimeShort } from '../lib/format';
import { ROLE_LABEL, type Role } from '../lib/permissions';
import type { Location, SessionRow, UserRow } from '../types';
import {
  Badge, Button, Card, CardHeader, Field, FormRow, Input, Modal, PageHeader, Select, useConfirm,
} from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';

interface FormState {
  id?: number;
  username: string;
  fullName: string;
  role: Role;
  defaultLocationId: string;
  password: string;
  isActive: boolean;
  restrictToLocation: boolean;
}

const emptyForm: FormState = { username: '', fullName: '', role: 'EMPLEADO', defaultLocationId: '', password: '', isActive: true, restrictToLocation: false };

function prettyUA(ua: string | null): string {
  if (!ua) return '—';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Mobile|Android|iPhone/.test(ua)) return 'Celular';
  return 'Navegador';
}

/** Panel de sesiones activas: quién está conectado, desde dónde y desde cuándo. */
function SessionsPanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api<{ sessions: SessionRow[] }>('/sessions');
      setSessions(res.sessions);
    } catch { /* si no tiene permiso, no muestra nada */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(load, 30000); // refresco automático cada 30 s
    return () => window.clearInterval(t);
  }, [load]);

  async function revoke(s: SessionRow) {
    confirm({
      title: '¿Desconectar sesión?',
      message: s.is_own
        ? 'Vas a cerrar tu propia sesión: tendrás que ingresar de nuevo.'
        : `${s.user_name} será desconectado en su próxima acción y deberá volver a ingresar.`,
      danger: true,
      confirmLabel: 'Desconectar',
      onConfirm: async () => {
        try {
          await api(`/sessions/${s.id}/revoke`, { method: 'POST' });
          toast.success('Sesión desconectada');
          void load();
        } catch (e) {
          toast.error((e as Error).message);
        }
      },
    });
  }

  return (
    <Card className="mt-5">
      <CardHeader
        title={`Sesiones activas (${sessions.length})`}
        subtitle="Quién está usando el sistema ahora mismo"
        actions={<Button size="sm" variant="secondary" onClick={load}>↻ Actualizar</Button>}
      />
      {loading ? (
        <p className="px-4 py-6 text-center text-sm text-slate-400">Cargando…</p>
      ) : sessions.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-slate-400">No hay sesiones activas</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2">Usuario</th>
              <th className="px-3 py-2">Dispositivo</th>
              <th className="px-3 py-2">IP</th>
              <th className="px-3 py-2">Ingresó</th>
              <th className="px-3 py-2">Última actividad</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} className={`border-b border-slate-100 last:border-0 ${s.is_own ? 'bg-brand-50/40' : ''}`}>
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-700">
                    {s.user_name}{s.is_own && <span className="ml-1 text-xs text-brand-500">(vos)</span>}
                  </div>
                  <div className="text-xs text-slate-400">{s.location_name ?? s.username}</div>
                </td>
                <td className="px-3 py-2 text-slate-500">{prettyUA(s.user_agent)}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-400">{s.ip ?? '—'}</td>
                <td className="px-3 py-2 text-slate-500">{fmtDateTimeShort(s.created_at)}</td>
                <td className="px-3 py-2 text-slate-500">{fmtDateTimeShort(s.last_seen_at)}</td>
                <td className="px-3 py-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => revoke(s)}>Desconectar</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export default function Users() {
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ users: UserRow[] }>('/users');
      setRows(res.users);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    api<{ locations: Location[] }>('/locations').then((r) => setLocations(r.locations)).catch(() => {});
  }, []);

  function openNew() { setForm(emptyForm); setOpen(true); }
  function openEdit(u: UserRow) {
    setForm({
      id: u.id,
      username: u.username,
      fullName: u.full_name,
      role: u.role_code,
      defaultLocationId: u.default_location_id ? String(u.default_location_id) : '',
      password: '',
      isActive: u.is_active,
      restrictToLocation: u.restrict_to_location,
    });
    setOpen(true);
  }

  async function save() {
    if (!form.username.trim() || !form.fullName.trim()) {
      toast.error('Usuario y nombre son obligatorios');
      return;
    }
    if (form.restrictToLocation && !form.defaultLocationId) {
      toast.error('Para restringir por ubicación primero elegí la ubicación habitual');
      return;
    }
    setSaving(true);
    const body = {
      username: form.username.trim(),
      fullName: form.fullName.trim(),
      role: form.role,
      defaultLocationId: form.defaultLocationId ? Number(form.defaultLocationId) : null,
      isActive: form.isActive,
      restrictToLocation: form.restrictToLocation,
    };
    try {
      if (form.id) {
        await api(`/users/${form.id}`, { method: 'PUT', body });
        toast.success('Usuario actualizado');
      } else {
        await api('/users', { method: 'POST', body: { ...body, password: form.password } });
        toast.success('Usuario creado');
      }
      setOpen(false);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function resetPassword(u: UserRow) {
    const nueva = window.prompt(`Nueva contraseña para ${u.username} (mínimo 6 caracteres):`);
    if (!nueva) return;
    if (nueva.length < 6) { toast.error('Mínimo 6 caracteres'); return; }
    confirm({
      title: 'Restablecer contraseña',
      message: `¿Confirmás restablecer la contraseña de ${u.username}?`,
      onConfirm: async () => {
        try {
          await api(`/users/${u.id}/reset-password`, { method: 'POST', body: { password: nueva } });
          toast.success('Contraseña restablecida');
        } catch (e) {
          toast.error((e as Error).message);
        }
      },
    });
  }

  function toggleActive(u: UserRow) {
    confirm({
      title: u.is_active ? '¿Desactivar usuario?' : '¿Reactivar usuario?',
      message: u.is_active
        ? `${u.username} no podrá iniciar sesión hasta reactivarlo.`
        : `${u.username} volverá a poder iniciar sesión.`,
      danger: u.is_active,
      onConfirm: async () => {
        try {
          await api(`/users/${u.id}`, { method: 'PUT', body: { isActive: !u.is_active } });
          toast.success('Estado actualizado');
          void load();
        } catch (e) {
          toast.error((e as Error).message);
        }
      },
    });
  }

  const columns: Column<UserRow>[] = [
    { key: 'username', label: 'Usuario', sortable: true, render: (u) => <span className="font-mono font-semibold text-slate-700">{u.username}</span> },
    { key: 'full_name', label: 'Nombre', sortable: true },
    { key: 'role_code', label: 'Rol', render: (u) => <Badge color={u.role_code === 'ADMIN' ? 'violet' : u.role_code === 'ENCARGADO' ? 'blue' : u.role_code === 'TRANSPORTE' ? 'amber' : 'gray'}>{ROLE_LABEL[u.role_code]}</Badge> },
    { key: 'location_name', label: 'Ubicación habitual', render: (u) => u.location_name ?? '—' },
    {
      key: 'restrict_to_location', label: 'Alcance',
      render: (u) => (u.restrict_to_location
        ? <Badge color="amber">Solo {u.location_name ?? 'sin ubicación'}</Badge>
        : <Badge color="blue">Todas</Badge>),
    },
    { key: 'last_login_at', label: 'Último ingreso', render: (u) => (u.last_login_at ? fmtDateTime(u.last_login_at) : '—') },
    { key: 'is_active', label: 'Estado', render: (u) => (u.is_active ? <Badge color="green">Activo</Badge> : <Badge color="red">Inactivo</Badge>) },
    {
      key: 'actions', label: '', align: 'right', render: (u) => (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="secondary" onClick={() => openEdit(u)}>Editar</Button>
          <Button size="sm" variant="ghost" onClick={() => resetPassword(u)}>Clave</Button>
          <Button size="sm" variant="ghost" onClick={() => toggleActive(u)}>{u.is_active ? 'Desactivar' : 'Activar'}</Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Usuarios"
        subtitle="Accesos, roles y ubicación habitual"
        actions={<Button onClick={openNew}>+ Nuevo usuario</Button>}
      />

      <Card>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(u) => u.id}
          loading={loading}
          pageSize={20}
          emptyTitle="No hay usuarios"
        />
      </Card>

      <SessionsPanel />

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={form.id ? `Editar usuario ${form.username}` : 'Nuevo usuario'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button loading={saving} onClick={save}>Guardar</Button>
          </>
        }
      >
        <FormRow cols={2}>
          <Field label="Usuario" required>
            <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} disabled={!!form.id} />
          </Field>
          <Field label="Nombre completo" required>
            <Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          </Field>
          <Field label="Rol" required hint="Define los permisos del usuario">
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="EMPLEADO">Empleado — entregas y consultas</option>
              <option value="ENCARGADO">Encargado — stock, movimientos e inventarios</option>
              <option value="TRANSPORTE">Transporte — repartos y GPS</option>
              <option value="ADMIN">Administrador — acceso total</option>
            </Select>
          </Field>
          <Field label="Ubicación habitual" hint="Precarga la ubicación en entregas y transferencias">
            <Select value={form.defaultLocationId} onChange={(e) => setForm({ ...form, defaultLocationId: e.target.value })}>
              <option value="">Sin ubicación fija</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          <Field
            label="Restringir a su ubicación"
            className="sm:col-span-2"
            hint="Si está activo, el usuario solo puede registrar entregas, entradas, transferencias e inventarios en su ubicación habitual. La consulta de stock sigue siendo de todas."
          >
            <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={form.restrictToLocation}
                onChange={(e) => setForm({ ...form, restrictToLocation: e.target.checked })}
                className="h-4 w-4"
              />
              {form.restrictToLocation
                ? `Restringido: solo puede operar en ${locations.find((l) => String(l.id) === form.defaultLocationId)?.name ?? '—'}`
                : 'Sin restricción de ubicación'}
            </label>
          </Field>
          {!form.id && (
            <Field label="Contraseña inicial" required className="sm:col-span-2">
              <Input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Mínimo 6 caracteres" />
            </Field>
          )}
        </FormRow>
      </Modal>
    </div>
  );
}
