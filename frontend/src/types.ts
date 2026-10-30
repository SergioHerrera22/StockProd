// Tipos compartidos del dominio (espejo de las respuestas de la API)

export interface Location {
  id: number;
  code: string;
  name: string;
  type: 'SUCURSAL' | 'DEPOSITO';
  address: string | null;
  is_active: boolean;
}

export interface Supplier {
  id: number; name: string; tax_id: string | null; contact_name: string | null;
  phone: string | null; email: string | null; address: string | null; notes: string | null; is_active: boolean;
}

export interface Supplier {
  id: number; name: string; tax_id: string | null; contact_name: string | null;
  phone: string | null; email: string | null; address: string | null; notes: string | null; is_active: boolean;
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
  /** Unidades comprometidas: por producto, y por loc.code en by_reserved */
  total_reserved?: number;
  by_reserved?: Record<string, string | number>;
  /** Físico − reservado: lo que realmente se puede vender */
  available?: number;
  by_location: Record<string, string | number>;
}

/** Lo realmente libre en una ubicación (o el consolidado), en unidades. */
export function availableOf(row: StockRow, locCode?: string): number {
  if (locCode) {
    const qty = Number(row.by_location?.[locCode] ?? 0);
    const reserved = Number(row.by_reserved?.[locCode] ?? 0);
    return qty - reserved;
  }
  return Number(row.available ?? (Number(row.total_qty) - Number(row.total_reserved ?? 0)));
}

export interface DeliveryItem {
  id?: number;
  product_id: number;
  quantity: number;
  /** Lo efectivamente entregado al confirmar (la reposición por anulación usa este valor) */
  quantity_delivered?: number | null;
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
  /** EAN-13 único de la orden (imprimible y escaneable en el comprobante) */
  barcode?: string | null;
  // PARCIAL: parte del stock se derivo a otra sucursal y quedo una orden de
  // retiro abierta. El backend puede devolver este estado al confirmar.
  status: 'BORRADOR' | 'CONFIRMADO' | 'PARCIAL' | 'ANULADO';
  is_pending_delivery?: boolean;
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
  /** Faltantes de la orden (CONFIRMADO/PARCIAL): líneas y unidades que quedan
   *  por entregar, descontando lo ya retirado por órdenes de retiro derivadas. */
  shortfall_lines?: number | null;
  shortfall_units?: number | null;
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

// ===== ENTREGAS PENDIENTES MULTI-SUCURSAL (retiros con código de barras) =====

export type PendingDeliveryStatus =
  | 'PENDIENTE'        // Creada, esperando retiro
  | 'EN_PREPARACION'   // Escaneada en sucursal, preparando
  | 'LISTO_RETIRO'     // Preparada, lista para entregar
  | 'PARCIAL'          // Parte retirada, queda mercaderia por entregar
  | 'ENTREGADO'        // Confirmado retiro, stock descontado
  | 'CANCELADO';       // Anulada

export interface PendingDeliveryItem {
  id?: number;
  product_id: number;
  product_code?: string;
  product_name?: string;
  unit?: string;
  quantity_requested: number;   // Lo que pidió el cliente
  quantity_reserved: number;    // Lo que se reservó realmente
  quantity_delivered: number;   // Lo que ya se entregó
  source_location_id: number;
  source_location_code?: string;
  source_location_name?: string;
}

export interface PendingDelivery {
  id: number;
  number: string;               // PD-000001
  barcode: string;              // EAN-13 único
  status: PendingDeliveryStatus;
  sale_location_id: number;     // Donde se vendió
  pickup_location_id: number;   // Donde retira el cliente
  sale_location_code?: string;
  sale_location_name?: string;
  pickup_location_code?: string;
  pickup_location_name?: string;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_document?: string | null;
  notes?: string | null;
  created_by_name?: string;
  created_at: string;
  /** Vencimiento de la reserva activa mas próxima (auto-cancela al pasar el plazo) */
  expires_at?: string | null;
  /** Si el auto-cancel ya la declaro vencida (expires_at <= now()) */
  overdue?: boolean;
  prepared_at?: string | null;
  delivered_at?: string | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  items_count?: number;
  total_qty_reserved?: number;
  total_qty_delivered?: number;
  items?: PendingDeliveryItem[];
  reservations?: unknown[];
}

export interface PendingDeliveryListResponse {
  data: PendingDelivery[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

/** Orden pendiente derivada de una entrega (vista reducida, con sus ítems)
 *  la devuelve GET /deliveries/:id/pending-delivery */
export interface DeliveryPendingOrder {
  id: number;
  number: string;
  barcode: string;
  status: string;
  pickup_location_id: number;
  pickupLocationName?: string | null;
  pickupLocationCode?: string | null;
  notes?: string | null;
  items: {
    product_id: number;
    product_code: string;
    product_name: string;
    unit: string | null;
    quantity_requested: number;
    quantity_reserved: number;
    quantity_delivered: number;
    source_location_id: number;
    source_location_name: string | null;
  }[];
}

export interface ScanPendingDeliveryResult {
  pending_delivery_id: number;
  number: string;
  status: PendingDeliveryStatus;
  sale_location_code: string;
  sale_location_name: string;
  pickup_location_code: string;
  pickup_location_name: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_document: string | null;
  items: PendingDeliveryItem[];
  created_at: string;
}

/** Item de mercadería solicitada en una orden de entrega escaneada */
export interface ScanDeliveryItem {
  productId: number;
  code: string;
  name: string;
  unit: string;
  /** Cantidad a entregar según la orden */
  quantity: number;
  /** Lo ya entregado (null mientras esté en borrador) */
  quantityDelivered: number | null;
  /** Lo facturado al cliente (null si no se cargó factura) */
  requestedQuantity: number | null;
  /** Stock disponible ahora en la sucursal de salida */
  stockAvailable: number;
}

/** Resultado de escanear el código de barras de la orden de entrega */
export interface ScanDeliveryResult {
  id: number;
  number: string;
  status: Delivery['status'];
  locationId: number;
  barcode: string;
  invoiceNumber: string | null;
  notes: string | null;
  createdAt: string;
  confirmedAt: string | null;
  locationName: string;
  locationCode: string;
  createdByName: string;
  items: ScanDeliveryItem[];
}

export interface ConfirmPickupInput {
  barcode: string;
  items: { productId: number; quantityDelivered: number }[];
}

export interface MultiLocationAvailability {
  productId: number;
  productCode: string;
  productName: string;
  saleLocationQty: number;
  otherLocations: {
    locationId: number;
    locationCode: string;
    locationName: string;
    availableQty: number;
  }[];
  totalAvailable: number;
  canFulfill: boolean;
}

export interface StockAvailabilityRow {
  productId: number;
  productCode: string;
  productName: string;
  locationId: number;
  locationCode: string;
  locationName: string;
  totalQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
}

export interface UserAlternativeChoice {
  productId: number;
  chosenLocationId: number;
  quantity: number;
}

// ===== VERIFICACIÓN DE DISPONIBILIDAD DE ENTREGA (faltantes + derivación) =====

export interface DeliveryAvailabilityItem {
  productId: number;
  productCode: string;
  productName: string;
  requestedQuantity: number;
  availableAtMain: number;
  shortfall: number;
  alternativeLocations: {
    locationId: number;
    locationCode: string;
    locationName: string;
    availableQuantity: number;
  }[];
}

export interface DeliveryAvailabilityResult {
  items: DeliveryAvailabilityItem[];
  canFullyDeliverLocally: boolean;
  hasShortfalls: boolean;
}

// ===== TRANSPORTE / REPARTO CON GPS =====

export type TripStatus = 'EN_PREPARACION' | 'EN_RUTA' | 'COMPLETADO' | 'CANCELADO';

export type StopDocType = 'DELIVERY' | 'TRANSFER' | 'PENDING_DELIVERY';

/** Posición GPS de un punto (camioneta) */
export interface TripPosition {
  lat: number;
  lng: number;
  recorded_at: string;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
}

/** Parada del viaje: documento transportado + sucursal/cliente destino */
export interface TripStop {
  id: number;
  sequence: number;
  location_id: number | null;
  location_code?: string | null;
  location_name?: string | null;
  delivery_id?: number | null;
  transfer_id?: number | null;
  pending_delivery_id?: number | null;
  doc_type: StopDocType;
  reference: string;
  customer_name?: string | null;
  address?: string | null;
  delivered_at?: string | null;
  delivered_by_name?: string | null;
  notes?: string | null;
}

export interface Trip {
  id: number;
  number: string;               // RP-000001
  status: TripStatus;
  origin_location_id: number;
  origin_code?: string;
  origin_name?: string;
  driver_name: string;
  driver_phone?: string | null;
  vehicle?: string | null;
  notes?: string | null;
  departed_at?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  created_by_name?: string | null;
  created_at: string;
  /** Usuario chofer asignado (posiciones espejadas en el viaje) */
  driver_user_id?: number | null;
  stop_count?: number;
  delivered_count?: number;
  last_position?: TripPosition | null;
  stops?: TripStop[];
}

/** Documentos disponibles para agregar como parada (GET /tracking/available) */
export interface AvailableDocs {
  deliveries: { id: number; number: string; status: string; invoice_number?: string | null; created_at?: string | null }[];
  transfers?: { id: number; number: string; status: string; destination_location_id?: number; destination_name?: string | null; created_at?: string | null }[];
  pendingDeliveries?: { id: number; number: string; status: string; pickup_location_id?: number; pickup_location_name?: string | null; customer_name?: string | null; created_at?: string | null }[];
}

export const TRIP_STATUS: Record<TripStatus, { label: string; color: 'amber' | 'green' | 'red' | 'blue' | 'gray' }> = {
  EN_PREPARACION: { label: 'En preparación', color: 'amber' },
  EN_RUTA: { label: 'En ruta', color: 'blue' },
  COMPLETADO: { label: 'Completado', color: 'green' },
  CANCELADO: { label: 'Cancelado', color: 'red' },
};

/** Etiqueta/color de un estado de viaje, con fallback */
export function tripStatusStyle(status: string): { label: string; color: 'amber' | 'green' | 'red' | 'blue' | 'gray' } {
  return TRIP_STATUS[status as TripStatus] ?? { label: status, color: 'gray' };
}
