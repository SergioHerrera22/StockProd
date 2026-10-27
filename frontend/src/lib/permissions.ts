// Copia espejo de la matriz de permisos del backend (backend/src/lib/permissions.ts).
// La validación REAL siempre ocurre en el servidor; esto solo guía la interfaz.

export type Role = 'ADMIN' | 'ENCARGADO' | 'EMPLEADO';

export type Permission =
  | 'products.read' | 'products.write' | 'categories.write' | 'products.import'
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
  'products.read', 'products.write', 'categories.write',
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
};

export function hasPermission(role: Role | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  return PERMISSIONS[role]?.includes(permission) ?? false;
}

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Administrador',
  ENCARGADO: 'Encargado',
  EMPLEADO: 'Empleado',
};
