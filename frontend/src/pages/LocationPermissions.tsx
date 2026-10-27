import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { Badge, Button, Card, EmptyState, Field, FormRow, Input, Modal, PageHeader, Select } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useToast } from '../components/Toast';
import { PERMISSION_LABEL, usePermissionCatalog, type CatalogPermission } from './permissionsCatalog';

/** Fila de GET /api/location-permissions/user/:userId (sin normalizar en el backend). */
interface UserPermissionRow {
  id: number;
  user_id: number;
  location_id: number;
  permission: string;
  scope: 'GLOBAL' | 'LOCATION' | 'OWN_LOCATION';
  granted_by: number | null;
  granted_at: string;
  expires_at: string | null;
  granted_by_name?: string;
  location_name?: string;
}

const SCOPE_LABEL: Record<UserPermissionRow['scope'], { label: string; color: 'blue' | 'green' | 'amber' }> = {
  GLOBAL: { label: 'Global', color: 'blue' },
  LOCATION: { label: 'Esta ubicación', color: 'green' },
  OWN_LOCATION: { label: 'Su ubicación', color: 'amber' },
};

export default function LocationPermissions() {
  const toast = useToast();
  const [users, setUsers] = useState<Array<{ id: number; full_name: string; username: string; role_code: string; is_active: boolean }>>([]);
  const [locations, setLocations] = useState<Array<{ id: number; name: string }>>([]);
  const [userId, setUserId] = useState('');
  const [perms, setPerms] = useState<UserPermissionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  const catalog = usePermissionCatalog();
  type GrantForm = { permission: string; locationId?: number; scope: 'GLOBAL' | 'LOCATION' | 'OWN_LOCATION'; expiresAt?: string };
  const EMPTY_GRANT: GrantForm = { permission: '', locationId: undefined, scope: 'LOCATION' };
  const [form, setForm] = useState<GrantForm | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ users: Array<{ id: number; full_name: string; username: string; role_code: string; is_active: boolean }> }>('/users')
      .then((r) => setUsers(r.users.filter((u) => u.is_active)))
      .catch((e) => toast.error((e as Error).message));
    api<{ locations: Array<{ id: number; name: string }> }>('/locations').then((r) => setLocations(r.locations)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadPerms = useCallback(async () => {
    if (!userId) { setPerms([]); return; }
    setLoading(true);
    try {
      const res = await api<{ permissions: UserPermissionRow[] }>(`/location-permissions/user/${userId}`);
      setPerms(res.permissions);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => { void loadPerms(); }, [loadPerms]);

  async function grant() {
    if (!form || !userId) return;
    if (form.locationId === undefined) { toast.error('Elegí la ubicación del permiso'); return; }
    setSaving(true);
    try {
      await api(`/location-permissions/user/${userId}`, {
        method: 'POST',
        body: {
          locationId: form.locationId,
          permission: form.permission,
          scope: form.scope,
          ...(form.expiresAt ? { expiresAt: form.expiresAt } : {}),
        },
      });
      toast.success('Permiso otorgado');
      setForm(null);
      void loadPerms();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function revoke(p: UserPermissionRow) {
    const key = `${p.location_id}-${p.permission}`;
    setActing(key);
    try {
      await api(`/location-permissions/user/${userId}/${p.location_id}/${encodeURIComponent(p.permission)}`, { method: 'DELETE' });
      toast.success('Permiso revocado');
      void loadPerms();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setActing(null);
    }
  }

  const selectedUser = users.find((u) => String(u.id) === userId);

  const columns: Column<UserPermissionRow>[] = [
    {
      key: 'permission', label: 'Permiso',
      render: (p) => <span className="font-medium text-slate-700">{PERMISSION_LABEL[p.permission] ?? p.permission}</span>,
    },
    {
      key: 'location_id', label: 'Ubicación',
      render: (p) => <span className="text-slate-600">{locations.find((l) => l.id === p.location_id)?.name ?? `#${p.location_id}`}</span>,
    },
    { key: 'scope', label: 'Alcance', render: (p) => {
      const m = SCOPE_LABEL[p.scope];
      return <Badge color={m.color}>{m.label}</Badge>;
    } },
    {
      key: 'expires_at', label: 'Vence',
      render: (p) => p.expires_at
        ? <span className={new Date(p.expires_at) < new Date() ? 'text-red-500' : 'text-slate-500'}>{fmtDateTime(p.expires_at)}</span>
        : <span className="text-slate-300">Nunca</span>,
    },
    { key: 'granted_by_name', label: 'Otorgado por', render: (p) => p.granted_by_name ?? <span className="text-slate-300">—</span> },
    {
      key: 'actions', label: '', render: (p) => (
        <Button size="sm" variant="ghost" disabled={acting === `${p.location_id}-${p.permission}`} onClick={() => void revoke(p)}>
          Revocar
        </Button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Permisos por ubicación"
        subtitle="Excepciones puntuales por usuario y sucursal: el rol define la base, estos permisos suman o ajustan"
        actions={
          <Button disabled={!userId || !!catalog.pending} onClick={() => setForm(EMPTY_GRANT)}>
            + Otorgar permiso
          </Button>
        }
      />

      <Card className="mb-4 p-3">
        <FormRow cols={2}>
          <Field label="Usuario" required>
            <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Elegí un usuario…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name} (@{u.username} · {u.role_code})</option>
              ))}
            </Select>
          </Field>
          {selectedUser && (
            <div className="self-end pb-1 text-sm text-slate-500">
              Rol base: <strong>{selectedUser.role_code}</strong> — los permisos vigentes de este usuario combinan el rol con estas excepciones.
            </div>
          )}
        </FormRow>
      </Card>

      {!userId && (
        <EmptyState
          icon="🔐"
          title="Elegí un usuario"
          hint="Cada usuario tiene permisos por su rol; acá se gestionan permisos extra por sucursal (vencimiento incluido)"
          action={null}
        />
      )}

      {userId && (
        <Card>
          <DataTable
            columns={columns}
            rows={perms}
            rowKey={(p) => `${p.location_id}-${p.permission}`}
            loading={loading}
            pageSize={20}
            total={perms.length}
            page={1}
            onPageChange={() => {}}
            emptyTitle="Sin permisos extra"
            emptyHint="Este usuario solo tiene los permisos definidos por su rol"
          />
        </Card>
      )}

      {/* Otorgar permiso */}
      <Modal
        open={!!form}
        onClose={() => setForm(null)}
        title={selectedUser ? `Otorgar permiso a ${selectedUser.full_name}` : 'Otorgar permiso'}
        width="md"
        footer={
          <>
            <Button variant="secondary" disabled={saving} onClick={() => setForm(null)}>Cancelar</Button>
            <Button variant="success" loading={saving} disabled={!form?.permission} onClick={() => void grant()}>Otorgar</Button>
          </>
        }
      >
        {form && (
          <div className="space-y-3">
            <Field label="Permiso" required>
              <Select value={form.permission} onChange={(e) => setForm({ ...form, permission: e.target.value })}>
                <option value="">Elegí un permiso…</option>
                {catalog.permissions.map((p) => (
                  <option key={p.key} value={p.key}>{PERMISSION_LABEL[p.key] ?? p.key}</option>
                ))}
              </Select>
            </Field>
            {form.permission && (
              <p className="rounded-lg bg-slate-50 p-2.5 text-xs text-slate-500">
                {catalog.permissions.find((p) => p.key === form.permission)?.description ?? ''}
              </p>
            )}
            <FormRow cols={3}>
              <Field label="Ubicación" required>
                <Select value={form.locationId ?? ''} onChange={(e) => setForm({ ...form, locationId: Number(e.target.value) })}>
                  <option value="">Elegí…</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </Select>
              </Field>
              <Field label="Alcance">
                <Select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as GrantForm['scope'] })}>
                  <option value="GLOBAL">Global (todas)</option>
                  <option value="LOCATION">Solo esa ubicación</option>
                  <option value="OWN_LOCATION">Su ubicación habitual</option>
                </Select>
              </Field>
              <Field label="Vencimiento">
                <Input
                  type="date"
                  onChange={(e) => setForm({ ...form, expiresAt: e.target.value ? new Date(`${e.target.value}T23:59:59-03:00`).toISOString() : undefined })}
                />
              </Field>
            </FormRow>
          </div>
        )}
      </Modal>
    </div>
  );
}
