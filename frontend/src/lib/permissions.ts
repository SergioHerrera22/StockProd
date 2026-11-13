// Copia espejo de la matriz de permisos del backend (backend/src/lib/permissions.ts).
// La validación REAL siempre ocurre en el servidor; esto solo guía la interfaz.

export type Role = 'ADMIN' | 'ENCARGADO' | 'EMPLEADO' | 'TRANSPORTE';

export type Permission =
  | 'products.read' | 'products.write' | 'categories.write' | 'products.import' | 'suppliers.manage'
  | 'stock.read' | 'stock.adjust'
  | 'deliveries.read' | 'deliveries.write' | 'deliveries.confirm' | 'deliveries.void' | 'deliveries.approve'
  | 'entries.read' | 'entries.write' | 'entries.confirm' | 'entries.void' | 'entries.approve'
  | 'transfers.read' | 'transfers.write' | 'transfers.receive' | 'transfers.dispatch' | 'transfers.verify' | 'transfers.void' | 'transfers.approve'
  | 'counts.read' | 'counts.write' | 'counts.apply' | 'counts.void' | 'counts.approve'
  | 'movements.read' | 'dashboard.read' | 'reports.read'
  | 'locations.read' | 'locations.manage'
  | 'tracking.read' | 'tracking.write' | 'tracking.gps'
  | 'users.read' | 'users.manage' | 'audit.read'
  | 'approvals.read' | 'approvals.approve'
  | 'merchandise_requests.use' | 'merchandise_requests.manage'
  | 'alerts.read' | 'alerts.manage'
  /** Configuración global (reglas de aprobación, reglas de negocio, umbrales). Espejo del backend. */
  | 'settings.write';

const ENCARGADO: Permission[] = [
  'products.read', 'products.write', 'categories.write', 'suppliers.manage',
  'stock.read', 'stock.adjust', 'merchandise_requests.use',
  'deliveries.read', 'deliveries.write', 'deliveries.confirm', 'deliveries.void', 'deliveries.approve',
  'entries.read', 'entries.write', 'entries.confirm', 'entries.void', 'entries.approve',
  'transfers.read', 'transfers.write', 'transfers.receive', 'transfers.dispatch', 'transfers.verify', 'transfers.void', 'transfers.approve',
  'counts.read', 'counts.write', 'counts.apply', 'counts.void', 'counts.approve',
  'movements.read', 'dashboard.read', 'reports.read',
  'locations.read',
  'tracking.read', 'tracking.write', 'tracking.gps',
  'approvals.read', 'approvals.approve',
  'alerts.read', 'alerts.manage',
];

const EMPLEADO: Permission[] = [
  'products.read',
  'stock.read', 'merchandise_requests.use',
  'deliveries.read', 'deliveries.write', 'deliveries.confirm',
  'movements.read', 'dashboard.read',
  'locations.read',
  'tracking.read', 'tracking.gps',
  'approvals.read',
  'alerts.read',
];

export const PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: [
    ...ENCARGADO, 'merchandise_requests.manage',
    'locations.manage', 'users.manage', 'users.read', 'audit.read', 'settings.write',
  ],
  ENCARGADO,
  EMPLEADO,
  // Espejo exacto del backend: chofer de transporte solo consulta/opera GPS.
  TRANSPORTE: ['locations.read', 'tracking.read', 'tracking.gps', 'deliveries.read', 'stock.read'],
};

/** Lista canónica que consume el editor de permisos. */
export const ALL_PERMISSIONS: Permission[] = [
  'products.read', 'products.write', 'categories.write', 'products.import', 'suppliers.manage',
  'stock.read', 'stock.adjust', 'merchandise_requests.use', 'merchandise_requests.manage',
  'deliveries.read', 'deliveries.write', 'deliveries.confirm', 'deliveries.void', 'deliveries.approve',
  'entries.read', 'entries.write', 'entries.confirm', 'entries.void', 'entries.approve',
  'transfers.read', 'transfers.write', 'transfers.receive', 'transfers.dispatch', 'transfers.verify', 'transfers.void', 'transfers.approve',
  'counts.read', 'counts.write', 'counts.apply', 'counts.void', 'counts.approve',
  'movements.read', 'dashboard.read', 'reports.read',
  'locations.read', 'locations.manage',
  'tracking.read', 'tracking.write', 'tracking.gps',
  'users.read', 'users.manage', 'audit.read',
  'approvals.read', 'approvals.approve',
  'alerts.read', 'alerts.manage', 'settings.write',
];

export interface PermissionGroup {
  key: string;
  label: string;
  description: string;
  icon: string;
  permissions: Array<{
    key: Permission;
    label: string;
    description: string;
  }>;
}

function permissionGroup(key: string, label: string, description: string, icon: string, permissions: Permission[]): PermissionGroup {
  return {
    key, label, description, icon,
    permissions: permissions.map((permission) => ({
      key: permission,
      ...PERMISSION_LABELS[permission],
    })),
  };
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  permissionGroup('products', 'Productos', 'Catálogo, categorías y proveedores.', '📦', ['products.read', 'products.write', 'categories.write', 'products.import', 'suppliers.manage']),
  permissionGroup('stock', 'Stock', 'Consulta y ajustes de existencias.', '🏷️', ['stock.read', 'stock.adjust']),
  permissionGroup('deliveries', 'Entregas', 'Preparación, confirmación y aprobación de entregas.', '🚚', ['deliveries.read', 'deliveries.write', 'deliveries.confirm', 'deliveries.void', 'deliveries.approve']),
  permissionGroup('entries', 'Entradas', 'Ingresos de mercadería y sus aprobaciones.', '📥', ['entries.read', 'entries.write', 'entries.confirm', 'entries.void', 'entries.approve']),
  permissionGroup('merchandise_requests', 'Pedidos de mercadería', 'Pedidos entre sucursales y Depósito Central.', '📦', ['merchandise_requests.use', 'merchandise_requests.manage']),
  permissionGroup('transfers', 'Transferencias', 'Movimientos entre sucursales y depósitos.', '🔁', ['transfers.read', 'transfers.write', 'transfers.dispatch', 'transfers.receive', 'transfers.verify', 'transfers.void', 'transfers.approve']),
  permissionGroup('counts', 'Inventarios', 'Conteos físicos y aplicación de diferencias.', '📋', ['counts.read', 'counts.write', 'counts.apply', 'counts.void', 'counts.approve']),
  permissionGroup('operations', 'Operaciones', 'Movimientos y panel de control.', '📊', ['movements.read', 'dashboard.read', 'reports.read']),
  permissionGroup('locations', 'Ubicaciones', 'Consulta y administración de sucursales.', '📍', ['locations.read', 'locations.manage']),
  permissionGroup('tracking', 'Seguimiento', 'Gestión de viajes y ubicación GPS.', '🛰️', ['tracking.read', 'tracking.write', 'tracking.gps']),
  permissionGroup('users', 'Usuarios', 'Administración de usuarios y auditoría.', '👥', ['users.read', 'users.manage', 'audit.read']),
  permissionGroup('approvals', 'Aprobaciones', 'Consulta y resolución de solicitudes.', '✅', ['approvals.read', 'approvals.approve']),
  permissionGroup('alerts', 'Alertas y configuración', 'Alertas operativas y reglas globales.', '⚙️', ['alerts.read', 'alerts.manage', 'settings.write']),
];

export function samePermissions(a: readonly Permission[], b: readonly Permission[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return set.size === b.length && b.every((permission) => set.has(permission));
}

export function hasPermission(role: Role | undefined | null, permission: Permission, custom?: Permission[] | null): boolean {
  // El administrador conserva acceso a Pedidos de mercadería aunque su lista personalizada sea anterior al módulo.
  if (role === 'ADMIN' && (permission === 'merchandise_requests.use' || permission === 'merchandise_requests.manage')) return true;
  if (custom !== undefined && custom !== null) return custom.includes(permission);
  if (!role) return false;
  return PERMISSIONS[role]?.includes(permission) ?? false;
}

export function hasPermissionWithFallback(role: Role | null, permission: Permission, userPermissions: Permission[] | null): boolean {
  // Si hay permisos de usuario personalizados (desde la BD), usarlos primero
  if (userPermissions && userPermissions.length > 0) {
    if (userPermissions.includes(permission)) return true;
    // Si el usuario tiene permisos custom pero no este específico, verificar rol
  }
  // Fallback a la matriz de roles
  if (role === 'ADMIN' && (permission === 'merchandise_requests.use' || permission === 'merchandise_requests.manage')) return true;
  if (!role) return false;
  return PERMISSIONS[role]?.includes(permission) ?? false;
}

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Administrador',
  ENCARGADO: 'Encargado',
  EMPLEADO: 'Empleado',
  TRANSPORTE: 'Transporte',
};