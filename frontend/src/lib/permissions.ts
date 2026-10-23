// Copia espejo de la matriz de permisos del backend (backend/src/lib/permissions.ts).
// La validación REAL siempre ocurre en el servidor; esto solo guía la interfaz.

export type Role = 'ADMIN' | 'ENCARGADO' | 'EMPLEADO';

export type Permission =
  | 'products.read' | 'products.write' | 'categories.write'
  | 'stock.read' | 'stock.adjust'
  | 'deliveries.read' | 'deliveries.write' | 'deliveries.confirm' | 'deliveries.void'
  | 'entries.read' | 'entries.write'
  | 'transfers.read' | 'transfers.write' | 'transfers.receive'
  | 'counts.read' | 'counts.write' | 'counts.apply'
  | 'movements.read' | 'dashboard.read' | 'reports.read'
  | 'locations.read' | 'locations.manage'
  | 'users.manage' | 'audit.read';

const ENCARGADO: Permission[] = [
  'products.read', 'products.write', 'categories.write',
  'stock.read', 'stock.adjust',
  'deliveries.read', 'deliveries.write', 'deliveries.confirm', 'deliveries.void',
  'entries.read', 'entries.write',
  'transfers.read', 'transfers.write', 'transfers.receive',
  'counts.read', 'counts.write', 'counts.apply',
  'movements.read', 'dashboard.read', 'reports.read',
  'locations.read',
];

const EMPLEADO: Permission[] = [
  'products.read',
  'stock.read',
  'deliveries.read', 'deliveries.write', 'deliveries.confirm',
  'movements.read', 'dashboard.read',
  'locations.read',
];

export const PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: [...ENCARGADO, 'locations.manage', 'users.manage', 'audit.read'],
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
