// Tipos compartidos del dominio (espejo de las respuestas de la API)

export interface Location {
  id: number;
  code: string;
  name: string;
  type: 'SUCURSAL' | 'DEPOSITO';
  address: string | null;
  is_active: boolean;
}

export interface Category {
  id: number;
  name: string;
  description?: string | null;
}

export interface Product {
  id: number;
  code: string;
  barcode: string | null;
  name: string;
  description: string | null;
  brand: string | null;
  category_id: number | null;
  category_name?: string | null;
  unit: 'UNIDAD' | 'LITRO' | 'KG' | 'METRO' | 'OTRO';
  min_stock: string | number;
  cost: string | number | null;
  reference_price: string | number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProductStockRow {
  location_id: number;
  location_name: string;
  location_code?: string;
  type?: string;
  quantity: string | number;
}

export interface StockRow {
  id: number;
  code: string;
  name: string;
  brand: string | null;
  unit: string;
  min_stock: string | number;
  cost: string | number | null;
  category_name: string | null;
  total_qty: number;
  by_location: Record<string, string | number>;
}

export interface DeliveryItem {
  id?: number;
  product_id: number;
  quantity: number;
  requested_quantity?: number | null;
  code?: string;
  name?: string;
  unit?: string;
  brand?: string | null;
  min_stock?: string | number;
  stock_now?: string | number;
}

export interface Delivery {
  id: number;
  number: string;
  status: 'BORRADOR' | 'CONFIRMADO' | 'ANULADO';
  location_id: number;
  location_name?: string;
  location_code?: string;
  invoice_number: string | null;
  notes: string | null;
  created_by_name?: string;
  confirmed_by_name?: string | null;
  confirmed_at?: string | null;
  created_at: string;
  items: DeliveryItem[];
  total_items?: number;
  line_count?: number;
}

export interface Entry {
  id: number;
  number: string;
  status: 'BORRADOR' | 'CONFIRMADO' | 'ANULADO';
  type: 'COMPRA' | 'DEVOLUCION' | 'OTRO';
  supplier: string | null;
  location_id: number;
  location_name?: string;
  notes: string | null;
  created_by_name?: string;
  confirmed_at?: string | null;
  created_at: string;
  items?: EntryItem[];
  line_count?: number;
}

export interface EntryItem {
  id: number;
  product_id: number;
  quantity: string | number;
  unit_cost: string | number | null;
  code?: string;
  name?: string;
  unit?: string;
}

export interface Transfer {
  id: number;
  number: string;
  status: 'EN_TRANSITO' | 'RECIBIDO' | 'RECIBIDO_CON_DIF' | 'ANULADO';
  origin_location_id: number;
  destination_location_id: number;
  origin_name?: string;
  destination_name?: string;
  notes: string | null;
  created_by_name?: string;
  received_by_name?: string | null;
  created_at: string;
  received_at?: string | null;
  items?: TransferItem[];
  line_count?: number;
}

export interface TransferItem {
  id: number;
  product_id: number;
  quantity_sent: string | number;
  quantity_received: string | number | null;
  code?: string;
  name?: string;
  unit?: string;
}

export interface StockCount {
  id: number;
  number: string;
  status: 'ABIERTO' | 'APLICADO' | 'ANULADO';
  location_id: number;
  location_name?: string;
  notes: string | null;
  created_by_name?: string;
  approved_by_name?: string | null;
  created_at: string;
  applied_at?: string | null;
  items?: CountItem[];
  line_count?: number;
  counted_lines?: number;
  adjusted_lines?: number;
}

export interface CountItem {
  id: number;
  product_id: number;
  system_quantity: string | number;
  counted_quantity: string | number | null;
  adjusted?: boolean;
  code: string;
  name: string;
  unit: string;
  min_stock: string | number;
}

export interface Movement {
  id: number;
  type: 'ENTRADA' | 'SALIDA' | 'AJUSTE_POS' | 'AJUSTE_NEG' | 'TRANS_SALIDA' | 'TRANS_ENTRADA';
  quantity: number;
  balance_before: number;
  balance_after: number;
  reference_type: 'DELIVERY' | 'ENTRY' | 'TRANSFER' | 'COUNT' | 'MANUAL';
  reference_id: number;
  reference_number: string | null;
  reason: string | null;
  notes: string | null;
  created_at: string;
  product_id: number;
  product_code: string;
  product_name: string;
  unit: string;
  location_name: string;
  user_name: string;
}

export interface UserRow {
  id: number;
  username: string;
  full_name: string;
  role_code: import('./lib/permissions').Role;
  default_location_id: number | null;
  location_name: string | null;
  is_active: boolean;
  restrict_to_location: boolean;
  last_login_at: string | null;
}

export interface SessionRow {
  id: string;
  user_id: number;
  user_name: string;
  username: string;
  location_name: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  is_own: boolean;
}

export interface AuditRow {
  id: number;
  action: string;
  entity: string;
  entity_id: number | null;
  details: unknown;
  ip: string | null;
  created_at: string;
  user_name: string | null;
  username: string | null;
}

export interface Paged<T> {
  total: number;
  page: number;
  pageSize: number;
}
