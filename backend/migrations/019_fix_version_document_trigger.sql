-- 019: Reinstalar trg_version_document con comparacion de estados por ::text.
--
-- Sintoma: al confirmar (o anular) una entrada, PostgreSQL devolvia
--   22P02 invalid input value for enum doc_status: "RECIBIDO"
-- y toda la transaccion se revertia -> HTTP 500. Solo quedaban los borradores.
--
-- Causa: la version de la funcion instalada en produccion comparaba
--   NEW.status IN ('CONFIRMADO', 'RECIBIDO', 'RECIBIDO_CON_DIF', ...)
-- contra columnas de tipo enum (doc_status no tiene 'RECIBIDO'), en una sola
-- rama para todas las tablas. La migracion 007 del repo ya tenia el cuerpo
-- corregido con ::text, pero se habia aplicado antes de esa correccion y el
-- runner saltea los archivos ya registrados en schema_migrations.
--
-- Esta migracion es idempotente: CREATE OR REPLACE de la funcion + triggers.

CREATE OR REPLACE FUNCTION trg_version_document() RETURNS trigger AS $$
DECLARE
    v_snapshot jsonb;
BEGIN
    IF TG_TABLE_NAME = 'transfers' AND OLD.status::text IS DISTINCT FROM NEW.status::text AND NEW.status::text IN ('EN_TRANSITO', 'RECIBIDO', 'RECIBIDO_CON_DIF', 'ANULADO') THEN
        v_snapshot := jsonb_build_object(
            'id', NEW.id, 'number', NEW.number, 'origin', NEW.origin_location_id, 'destination', NEW.destination_location_id,
            'status', NEW.status::text, 'notes', NEW.notes, 'created_by', NEW.created_by, 'dispatched_by', NEW.dispatched_by,
            'received_by', NEW.received_by, 'verified_by', NEW.verified_by, 'voided_by', NEW.voided_by, 'void_approved_by', NEW.void_approved_by,
            'items', (SELECT jsonb_agg(jsonb_build_object('product_id', ti.product_id, 'qty_sent', ti.quantity_sent, 'qty_received', ti.quantity_received))
                      FROM transfer_items ti WHERE ti.transfer_id = NEW.id)
        );
        PERFORM version_document('TRANSFER', NEW.id, NEW.status::text, v_snapshot, COALESCE(NEW.received_by, NEW.dispatched_by, NEW.voided_by, NEW.verified_by), 'Cambio de estado a ' || NEW.status::text);
    ELSIF TG_TABLE_NAME = 'deliveries' AND OLD.status::text IS DISTINCT FROM NEW.status::text AND NEW.status::text IN ('BORRADOR', 'CONFIRMADO', 'ANULADO', 'PARCIAL') THEN
        v_snapshot := jsonb_build_object(
            'id', NEW.id, 'number', NEW.number, 'location_id', NEW.location_id, 'status', NEW.status::text,
            'invoice_number', NEW.invoice_number, 'notes', NEW.notes, 'created_by', NEW.created_by,
            'confirmed_by', NEW.confirmed_by, 'packed_by', NEW.packed_by, 'voided_by', NEW.voided_by, 'void_approved_by', NEW.void_approved_by,
            'items', (SELECT jsonb_agg(jsonb_build_object('product_id', di.product_id, 'quantity', di.quantity, 'requested_qty', di.requested_quantity))
                      FROM delivery_items di WHERE di.delivery_id = NEW.id)
        );
        PERFORM version_document('DELIVERY', NEW.id, NEW.status::text, v_snapshot, COALESCE(NEW.confirmed_by, NEW.packed_by, NEW.voided_by), 'Cambio de estado a ' || NEW.status::text);
    ELSIF TG_TABLE_NAME = 'stock_entries' AND OLD.status::text IS DISTINCT FROM NEW.status::text AND NEW.status::text IN ('BORRADOR', 'CONFIRMADO', 'ANULADO', 'PARCIAL') THEN
        v_snapshot := jsonb_build_object(
            'id', NEW.id, 'number', NEW.number, 'location_id', NEW.location_id, 'type', NEW.type, 'status', NEW.status::text,
            'supplier', NEW.supplier, 'notes', NEW.notes, 'created_by', NEW.created_by,
            'confirmed_by', NEW.confirmed_by, 'received_by', NEW.received_by, 'voided_by', NEW.voided_by, 'void_approved_by', NEW.void_approved_by,
            'items', (SELECT jsonb_agg(jsonb_build_object('product_id', ei.product_id, 'quantity', ei.quantity, 'unit_cost', ei.unit_cost))
                      FROM stock_entry_items ei WHERE ei.entry_id = NEW.id)
        );
        PERFORM version_document('ENTRY', NEW.id, NEW.status::text, v_snapshot, COALESCE(NEW.confirmed_by, NEW.received_by, NEW.voided_by), 'Cambio de estado a ' || NEW.status::text);
    ELSIF TG_TABLE_NAME = 'stock_counts' AND OLD.status::text IS DISTINCT FROM NEW.status::text AND NEW.status::text IN ('ABIERTO', 'APLICADO', 'ANULADO') THEN
        v_snapshot := jsonb_build_object(
            'id', NEW.id, 'number', NEW.number, 'location_id', NEW.location_id, 'status', NEW.status::text,
            'notes', NEW.notes, 'created_by', NEW.created_by, 'approved_by', NEW.approved_by, 'voided_by', NEW.voided_by, 'void_approved_by', NEW.void_approved_by,
            'items', (SELECT jsonb_agg(jsonb_build_object('product_id', ci.product_id, 'system_qty', ci.system_quantity, 'counted_qty', ci.counted_quantity, 'adjusted', ci.adjusted))
                      FROM stock_count_items ci WHERE ci.count_id = NEW.id)
        );
        PERFORM version_document('COUNT', NEW.id, NEW.status::text, v_snapshot, COALESCE(NEW.approved_by, NEW.voided_by), 'Cambio de estado a ' || NEW.status::text);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_transfer_version ON transfers;
CREATE TRIGGER trg_transfer_version AFTER UPDATE ON transfers FOR EACH ROW EXECUTE FUNCTION trg_version_document();

DROP TRIGGER IF EXISTS trg_delivery_version ON deliveries;
CREATE TRIGGER trg_delivery_version AFTER UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION trg_version_document();

DROP TRIGGER IF EXISTS trg_entry_version ON stock_entries;
CREATE TRIGGER trg_entry_version AFTER UPDATE ON stock_entries FOR EACH ROW EXECUTE FUNCTION trg_version_document();

DROP TRIGGER IF EXISTS trg_count_version ON stock_counts;
CREATE TRIGGER trg_count_version AFTER UPDATE ON stock_counts FOR EACH ROW EXECUTE FUNCTION trg_version_document();
