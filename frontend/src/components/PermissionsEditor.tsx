import {
  ALL_PERMISSIONS, PERMISSIONS, PERMISSION_GROUPS, ROLE_LABEL, samePermissions,
  type Permission, type PermissionGroup, type Role,
} from '../lib/permissions';
import { Badge, Button } from './ui';

interface Props {
  role: Role;
  value: Permission[];
  onChange: (next: Permission[]) => void;
  /** Permisos que no se pueden quitar (ej. el propio users.manage). */
  lockedPermissions?: Permission[];
  /** Solo el administrador puede editar permisos. */
  readOnly?: boolean;
}

export function PermissionsEditor({
  role, value, onChange, lockedPermissions = [], readOnly = false,
}: Props) {
  const selected = new Set(value);
  const roleDefaults = PERMISSIONS[role] ?? [];
  const isCustom = !samePermissions(value, roleDefaults);
  const locked = new Set(lockedPermissions);

  function apply(next: Iterable<Permission>) {
    if (readOnly) return;
    // Nunca quitar un permiso bloqueado que ya estaba activo.
    const set = new Set(next);
    for (const permission of locked) {
      if (selected.has(permission)) set.add(permission);
    }
    onChange(ALL_PERMISSIONS.filter((permission) => set.has(permission)));
  }

  function toggle(permission: Permission, checked: boolean) {
    if (readOnly) return;
    if (!checked && locked.has(permission)) return;
    const next = new Set(value);
    if (checked) next.add(permission);
    else next.delete(permission);
    apply(next);
  }

  function setGroup(group: PermissionGroup, enabled: boolean) {
    const next = new Set(value);
    for (const permission of group.permissions) {
      if (!enabled && locked.has(permission.key)) continue;
      if (enabled) next.add(permission.key);
      else next.delete(permission.key);
    }
    apply(next);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-4 py-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-slate-700">Permisos del usuario</h4>
            <Badge color={isCustom ? 'violet' : 'blue'}>
              {isCustom ? 'Personalizados' : `Según rol ${ROLE_LABEL[role]}`}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            Activá o desactivá cada permiso. Se agrupan por función y el servidor valida siempre esta lista.
          </p>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold text-slate-700">{value.length} / {ALL_PERMISSIONS.length}</div>
          <div className="text-xs text-slate-400">permisos activos</div>
        </div>
      </div>

      {readOnly ? (
        <p className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-700">
          Solo un administrador puede modificar los permisos de un usuario.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2">
          <Button size="sm" variant="secondary" onClick={() => apply(ALL_PERMISSIONS)}>Activar todos</Button>
          <Button size="sm" variant="secondary" onClick={() => apply([])}>Desactivar todos</Button>
          <Button size="sm" variant="ghost" onClick={() => apply(roleDefaults)}>Volver a los del rol</Button>
          <span className="ml-auto text-xs text-slate-400">
            El rol solo marca el punto de partida.
          </span>
        </div>
      )}

      <div className="grid gap-3 p-3 sm:grid-cols-2">
        {PERMISSION_GROUPS.map((group) => {
          const activeCount = group.permissions.filter((permission) => selected.has(permission.key)).length;
          const allActive = activeCount === group.permissions.length;
          return (
            <section
              key={group.key}
              className={`rounded-lg border ${activeCount > 0 ? 'border-brand-200 bg-brand-50/20' : 'border-slate-200'}`}
            >
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
                <div className="min-w-0">
                  <h5 className="truncate text-xs font-bold uppercase tracking-wide text-slate-600">
                    <span className="mr-1">{group.icon}</span>{group.label}
                  </h5>
                  <p className="truncate text-[11px] text-slate-400" title={group.description}>
                    {activeCount}/{group.permissions.length} activos
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={readOnly}
                  onClick={() => setGroup(group, !allActive)}
                >
                  {allActive ? 'Ninguno' : 'Todos'}
                </Button>
              </div>

              <div className="space-y-1.5 px-2.5 py-2">
                {group.permissions.map((permission) => {
                  const checked = selected.has(permission.key);
                  const isLocked = checked && locked.has(permission.key);
                  const disabled = readOnly || isLocked;
                  return (
                    <label
                      key={permission.key}
                      className={`flex gap-2 rounded-md px-1.5 py-1 ${
                        disabled ? 'opacity-70' : 'cursor-pointer hover:bg-white/80'
                      }`}
                      title={isLocked ? 'No podés quitarte este permiso a vos mismo' : undefined}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-brand-600"
                        checked={checked}
                        disabled={disabled}
                        onChange={(event) => toggle(permission.key, event.target.checked)}
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1 text-sm font-medium text-slate-700">
                          {permission.label}
                          {isLocked && <span className="text-[11px] text-amber-600">🔒</span>}
                        </span>
                        <span className="block text-xs leading-snug text-slate-400">{permission.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
