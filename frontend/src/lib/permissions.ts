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
  | 'alerts.read' | 'alerts.manage'
  /** Configuración global (reglas de aprobación, reglas de negocio, umbrales). Espejo del backend. */
  | 'settings.write';

const ENCARGADO: Permission[] = [
  'products.read', 'products.write', 'categories.write', 'suppliers.manage',
  'stock.read', 'stock.adjust',
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
  'stock.read',
  'deliveries.read', 'deliveries.write', 'deliveries.confirm',
  'movements.read', 'dashboard.read',
  'locations.read',
  'tracking.read', 'tracking.gps',
  'approvals.read',
  'alerts.read',
];

export const PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: [
    ...ENCARGADO,
    'locations.manage', 'users.manage', 'users.read', 'audit.read', 'settings.write',
  ],
  ENCARGADO,
  EMPLEADO,
  // Espejo exacto del backend: chofer de transporte solo consulta/opera GPS.
  TRANSPORTE: ['locations.read', 'tracking.read', 'tracking.gps'],
};

/** Lista canónica que consume el editor de permisos. */
export const ALL_PERMISSIONS: Permission[] = [
  'products.read', 'products.write', 'categories.write', 'products.import', 'suppliers.manage',
  'stock.read', 'stock.adjust',
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

const PERMISSION_LABELS: Record<Permission, { label: string; description: string }> = {
  'products.read': { label: 'Ver productos', description: 'Consultar el catálogo de productos.' },
  'products.write': { label: 'Crear y editar productos', description: 'Dar de alta y modificar productos.' },
  'categories.write': { label: 'Gestionar categorías', description: 'Crear y modificar categorías.' },
  'products.import': { label: 'Importar productos', description: 'Importar productos desde archivos.' },
  'suppliers.manage': { label: 'Gestionar proveedores', description: 'Crear, editar y administrar proveedores.' },
  'stock.read': { label: 'Ver stock', description: 'Consultar existencias por ubicación.' },
  'stock.adjust': { label: 'Ajustar stock', description: 'Solicitar o registrar ajustes de inventario.' },
  'deliveries.read': { label: 'Ver entregas', description: 'Consultar entregas.' },
  'deliveries.write': { label: 'Crear y modificar entregas', description: 'Preparar entregas.' },
  'deliveries.confirm': { label: 'Confirmar entregas', description: 'Confirmar operaciones de entrega.' },
  'deliveries.void': { label: 'Anular entregas', description: 'Anular entregas según las reglas del sistema.' },
  'deliveries.approve': { label: 'Aprobar entregas', description: 'Aprobar solicitudes de entrega.' },
  'entries.read': { label: 'Ver entradas', description: 'Consultar entradas de stock.' },
  'entries.write': { label: 'Crear y modificar entradas', description: 'Preparar entradas de stock.' },
  'entries.confirm': { label: 'Confirmar entradas', description: 'Confirmar el ingreso de mercadería.' },
  'entries.void': { label: 'Anular entradas', description: 'Anular entradas según las reglas del sistema.' },
  'entries.approve': { label: 'Aprobar entradas', description: 'Aprobar solicitudes de entrada.' },
  'transfers.read': { label: 'Ver transferencias', description: 'Consultar transferencias entre ubicaciones.' },
  'transfers.write': { label: 'Crear transferencias', description: 'Preparar transferencias.' },
  'transfers.receive': { label: 'Recibir transferencias', description: 'Registrar la recepción física.' },
  'transfers.dispatch': { label: 'Despachar transferencias', description: 'Registrar el despacho físico.' },
  'transfers.verify': { label: 'Verificar recepción', description: 'Verificar la recepción como segunda persona.' },
  'transfers.void': { label: 'Anular transferencias', description: 'Anular transferencias según las reglas del sistema.' },
  'transfers.approve': { label: 'Aprobar transferencias', description: 'Aprobar solicitudes de transferencia.' },
  'counts.read': { label: 'Ver inventarios', description: 'Consultar conteos de inventario.' },
  'counts.write': { label: 'Crear inventarios', description: 'Crear y completar conteos.' },
  'counts.apply': { label: 'Aplicar inventarios', description: 'Aplicar diferencias aprobadas.' },
  'counts.void': { label: 'Anular inventarios', description: 'Anular conteos según las reglas del sistema.' },
  'counts.approve': { label: 'Aprobar inventarios', description: 'Aprobar ajustes derivados del conteo.' },
  'movements.read': { label: 'Ver movimientos', description: 'Consultar el historial de movimientos.' },
  'dashboard.read': { label: 'Ver dashboard', description: 'Consultar indicadores generales.' },
  'reports.read': { label: 'Ver reportes', description: 'Consultar y exportar reportes.' },
  'locations.read': { label: 'Ver ubicaciones', description: 'Consultar sucursales y depósitos.' },
  'locations.manage': { label: 'Gestionar ubicaciones', description: 'Administrar sucursales y depósitos.' },
  'tracking.read': { label: 'Ver seguimiento', description: 'Consultar el seguimiento de repartos.' },
  'tracking.write': { label: 'Gestionar seguimiento', description: 'Crear y administrar viajes.' },
  'tracking.gps': { label: 'Compartir GPS', description: 'Enviar ubicación y eventos GPS.' },
  'users.read': { label: 'Ver usuarios', description: 'Consultar usuarios del sistema.' },
  'users.manage': { label: 'Gestionar usuarios', description: 'Crear usuarios y administrar sus permisos.' },
  'audit.read': { label: 'Ver auditoría', description: 'Consultar el registro de auditoría.' },
  'approvals.read': { label: 'Ver aprobaciones', description: 'Consultar solicitudes de aprobación.' },
  'approvals.approve': { label: 'Resolver aprobaciones', description: 'Aprobar o rechazar solicitudes.' },
  'alerts.read': { label: 'Ver alertas', description: 'Consultar alertas operativas.' },
  'alerts.manage': { label: 'Gestionar alertas', description: 'Administrar alertas y sus reglas.' },
  'settings.write': { label: 'Configurar el sistema', description: 'Modificar la configuración global.' },
};

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

export function hasPermission(role: Role | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  return PERMISSIONS[role]?.includes(permission) ?? false;
}

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Administrador',
  ENCARGADO: 'Encargado',
  EMPLEADO: 'Empleado',
  TRANSPORTE: 'Transporte',
};
