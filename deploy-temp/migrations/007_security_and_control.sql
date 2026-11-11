-- ============================================================
-- Migracion 007: Seguridad, Control Total y Trazabilidad
-- Capas: RBAC por ubicacion, Aprobaciones, Guards, Alertas, Snapshots, Conciliacion
-- ============================================================

-- ------------------------------------------------------------
-- 1. RBAC POR UBICACION (usuario x ubicacion x permiso)
-- ------------------------------------------------------------
CREATE TYPE permission_scope AS ENUM ('GLOBAL', 'LOCATION', 'OWN_LOCATION');

CREATE TABLE user_location_permissions (
    user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    location_id   integer NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    permission    varchar(60) NOT NULL,  -- ej: 'transfers.write', 'deliveries.approve'
    scope         permission_scope NOT NULL DEFAULT 'LOCATION',
    granted_by    integer NOT NULL REFERENCES users(id),
    granted_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz,  -- null = sin expiracion
    PRIMARY KEY (user_id, location_id, permission)
);
CREATE INDEX idx_ulp_user ON user_location_permissions(user_id);
CREATE INDEX idx_ulp_location ON user_location_permissions(location_id);

-- Vista para resolver permisos efectivos (rol + ubicacion)
CREATE OR REPLACE VIEW v_user_effective_permissions AS
SELECT
    u.id AS user_id,
    u.role_code,
    ulp.location_id,
    ulp.permission,
    ulp.scope,
    CASE
        WHEN ulp.scope = 'GLOBAL' THEN true
        WHEN ulp.scope = 'OWN_LOCATION' AND ulp.location_id = u.default_location_id THEN true
        WHEN ulp.scope = 'LOCATION' THEN true
        ELSE false
    END AS is_effective
FROM users u
LEFT JOIN user_location_permissions ulp ON ulp.user_id = u.id
    AND (ulp.expires_at IS NULL OR ulp.expires_at > now())
WHERE u.is_active = true;

-- ------------------------------------------------------------
-- 2. MOTOR DE APROBACIONES (workflow configurable)
-- ------------------------------------------------------------
CREATE TYPE approval_status AS ENUM ('PENDIENTE', 'APROBADO', 'RECHAZADO', 'EXPIRADO', 'CANCELADO');
CREATE TYPE approval_entity AS ENUM ('TRANSFER', 'DELIVERY', 'ENTRY', 'COUNT', 'VOID', 'STOCK_ADJUST');

CREATE TABLE approval_rules (
    id              serial PRIMARY KEY,
    name            varchar(100) NOT NULL UNIQUE,
    entity_type     approval_entity NOT NULL,
    operation       varchar(30) NOT NULL,  -- 'CREATE', 'CONFIRM', 'RECEIVE', 'VOID', 'APPLY', 'ADJUST'
    -- Condicion JSON: { "qty_gt": 50, "value_gt": 10000, "location_ids": [1,2], "product_category_ids": [3] }
    condition       jsonb NOT NULL DEFAULT '{}',
    -- Accion JSON: { "require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1, "allowed_roles": ["ENCARGADO","ADMIN"] }
    action          jsonb NOT NULL DEFAULT '{"require_approval": true}',
    is_active       boolean NOT NULL DEFAULT true,
    priority        integer NOT NULL DEFAULT 100,  -- menor = mayor prioridad
    created_by      integer NOT NULL REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_approval_rules_entity ON approval_rules(entity_type, operation, is_active);

CREATE TABLE approval_requests (
    id                  bigserial PRIMARY KEY,
    rule_id             integer NOT NULL REFERENCES approval_rules(id),
    entity_type         approval_entity NOT NULL,
    entity_id           integer NOT NULL,  -- id del documento: transfer_id, delivery_id, etc.
    entity_number       varchar(30) NOT NULL,
    requested_by        integer NOT NULL REFERENCES users(id),
    requested_at        timestamptz NOT NULL DEFAULT now(),
    status              approval_status NOT NULL DEFAULT 'PENDIENTE',
    -- Contexto para el aprobador
    context             jsonb NOT NULL DEFAULT '{}',  -- { "items": [...], "total_value": 12345, "origin": "SUC01", "destination": "SUC02" }
    -- Resolucion
    resolved_by         integer REFERENCES users(id),
    resolved_at         timestamptz,
    resolution_notes    varchar(500),
    expires_at          timestamptz NOT NULL DEFAULT (now() + interval '48 hours'),
    -- Metadata
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_approval_req_status ON approval_requests(status, entity_type, entity_id);
CREATE INDEX idx_approval_req_requested ON approval_requests(requested_by, requested_at DESC);
CREATE INDEX idx_approval_req_pending ON approval_requests(status) WHERE status = 'PENDIENTE';

-- Historial de aprobaciones (inmutable)
CREATE TABLE approval_history (
    id                  bigserial PRIMARY KEY,
    approval_request_id bigint NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
    action              varchar(20) NOT NULL,  -- 'REQUESTED', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'
    performed_by        integer NOT NULL REFERENCES users(id),
    performed_at        timestamptz NOT NULL DEFAULT now(),
    notes               varchar(500),
    previous_status     approval_status,
    new_status          approval_status
);
CREATE INDEX idx_approval_hist_req ON approval_history(approval_request_id, performed_at);

-- ------------------------------------------------------------
-- 3. LOG DE AUDITORIA INMUTABLE (append-only, sin UPDATE/DELETE)
-- ------------------------------------------------------------
-- Revocar permisos de UPDATE/DELETE sobre audit_logs para roles no admin
REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;

-- Trigger para bloquear UPDATE/DELETE (defensa en profundidad)
CREATE OR REPLACE FUNCTION prevent_audit_modification() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'audit_logs es inmutable: no se permite UPDATE';
    ELSIF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'audit_logs es inmutable: no se permite DELETE';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_logs;
CREATE TRIGGER trg_audit_immutable
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

-- Hash encadenado para detectar manipulacion (opcional, para exportaciones firmadas)
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS prev_hash varchar(64);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS row_hash varchar(64);

CREATE OR REPLACE FUNCTION compute_audit_hash() RETURNS trigger AS $$
DECLARE
    prev_row record;
    hash_input text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Obtener hash de la fila anterior (ordenada por id)
        SELECT row_hash INTO prev_row FROM audit_logs WHERE id < NEW.id ORDER BY id DESC LIMIT 1;
        hash_input := COALESCE(prev_row.row_hash, 'GENESIS') || '|' || NEW.id || '|' || COALESCE(NEW.user_id::text, 'null') || '|' || NEW.action || '|' || NEW.entity || '|' || COALESCE(NEW.entity_id::text, 'null') || '|' || COALESCE(NEW.details::text, 'null') || '|' || COALESCE(NEW.ip, 'null') || '|' || NEW.created_at::text;
        NEW.prev_hash := COALESCE(prev_row.row_hash, 'GENESIS');
        NEW.row_hash := encode(digest(hash_input, 'sha256'), 'hex');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_audit_hash ON audit_logs;
CREATE TRIGGER trg_audit_hash
BEFORE INSERT ON audit_logs
FOR EACH ROW EXECUTE FUNCTION compute_audit_hash();

-- Backfill hashes existentes (ejecutar una vez)
-- UPDATE audit_logs SET prev_hash = 'GENESIS', row_hash = encode(digest('GENESIS|'||id||'|'||COALESCE(user_id::text,'null')||'|'||action||'|'||entity||'|'||COALESCE(entity_id::text,'null')||'|'||COALESCE(details::text,'null')||'|'||COALESCE(ip,'null')||'|'||created_at::text, 'sha256'), 'hex') WHERE row_hash IS NULL;

-- ------------------------------------------------------------
-- 4. GUARDS DE ESTADO + SEGREGACION DE FUNCIONES
-- ------------------------------------------------------------

-- 4.1 Transfers: agregar dispatched_by, dispatched_at, verified_by (recepcion distinta de envio)
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS dispatched_by integer REFERENCES users(id);
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS verified_by integer REFERENCES users(id);  -- segunda persona verifica recepcion
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- Constraint: received_by != dispatched_by (segregacion de funciones)
ALTER TABLE transfers DROP CONSTRAINT IF EXISTS chk_transfer_segregation;
ALTER TABLE transfers ADD CONSTRAINT chk_transfer_segregation
    CHECK (received_by IS NULL OR dispatched_by IS NULL OR received_by <> dispatched_by);

-- 4.2 Deliveries: agregar packed_by, packed_at (quien prepara != quien confirma)
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS packed_by integer REFERENCES users(id);
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS packed_at timestamptz;

-- 4.3 Entries: agregar received_by, received_at (quien recibe fisicamente != quien confirma contable)
ALTER TABLE stock_entries ADD COLUMN IF NOT EXISTS received_by integer REFERENCES users(id);
ALTER TABLE stock_entries ADD COLUMN IF NOT EXISTS received_at timestamptz;

-- 4.4 Counts: ya tiene approved_by distinto de created_by, reforzar constraint
ALTER TABLE stock_counts DROP CONSTRAINT IF EXISTS chk_count_segregation;
ALTER TABLE stock_counts ADD CONSTRAINT chk_count_segregation
    CHECK (approved_by IS NULL OR created_by <> approved_by);

-- ------------------------------------------------------------
-- 5. DOBLE AUTORIZACION PARA ANULACIONES (Four-Eyes Principle)
-- ------------------------------------------------------------
-- Agregar campos de segunda autorizacion a documentos confirmados
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS void_approved_by integer REFERENCES users(id);
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS void_approved_at timestamptz;

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS void_approved_by integer REFERENCES users(id);
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS void_approved_at timestamptz;

ALTER TABLE stock_entries ADD COLUMN IF NOT EXISTS void_approved_by integer REFERENCES users(id);
ALTER TABLE stock_entries ADD COLUMN IF NOT EXISTS void_approved_at timestamptz;

ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS void_approved_by integer REFERENCES users(id);
ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS void_approved_at timestamptz;

-- Constraint: void_approved_by != voided_by (distinto usuario)
ALTER TABLE transfers DROP CONSTRAINT IF EXISTS chk_transfer_void_dual;
ALTER TABLE transfers ADD CONSTRAINT chk_transfer_void_dual
    CHECK (voided_by IS NULL OR void_approved_by IS NULL OR voided_by <> void_approved_by);

ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS chk_delivery_void_dual;
ALTER TABLE deliveries ADD CONSTRAINT chk_delivery_void_dual
    CHECK (voided_by IS NULL OR void_approved_by IS NULL OR voided_by <> void_approved_by);

ALTER TABLE stock_entries DROP CONSTRAINT IF EXISTS chk_entry_void_dual;
ALTER TABLE stock_entries ADD CONSTRAINT chk_entry_void_dual
    CHECK (voided_by IS NULL OR void_approved_by IS NULL OR voided_by <> void_approved_by);

ALTER TABLE stock_counts DROP CONSTRAINT IF EXISTS chk_count_void_dual;
ALTER TABLE stock_counts ADD CONSTRAINT chk_count_void_dual
    CHECK (voided_by IS NULL OR void_approved_by IS NULL OR voided_by <> void_approved_by);

-- ------------------------------------------------------------
-- 6. MOTOR DE REGLAS DE NEGOCIO (configurables sin deploy)
-- ------------------------------------------------------------
CREATE TABLE business_rules (
    id              serial PRIMARY KEY,
    code            varchar(50) NOT NULL UNIQUE,  -- 'transfer_qty_threshold', 'delivery_value_threshold', etc.
    name            varchar(100) NOT NULL,
    description     text,
    entity_type     approval_entity NOT NULL,
    trigger_event   varchar(30) NOT NULL,  -- 'BEFORE_CREATE', 'BEFORE_CONFIRM', 'BEFORE_VOID', 'BEFORE_ADJUST'
    -- Condicion evaluada en runtime (ej: {"qty_sum_gt": 100, "location_ids": [1,2], "user_role": "EMPLEADO"})
    condition       jsonb NOT NULL DEFAULT '{}',
    -- Acciones: {"require_approval": true, "min_role": "ENCARGADO", "block": false, "alert_roles": ["ADMIN"]}
    action          jsonb NOT NULL DEFAULT '{}',
    severity        varchar(20) NOT NULL DEFAULT 'WARNING',  -- INFO, WARNING, BLOCKING
    is_active       boolean NOT NULL DEFAULT true,
    created_by      integer NOT NULL REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_biz_rules_entity ON business_rules(entity_type, trigger_event, is_active);

-- ------------------------------------------------------------
-- 7. ALERTAS Y NOTIFICACIONES AUTOMATICAS
-- ------------------------------------------------------------
CREATE TYPE alert_severity AS ENUM ('INFO', 'WARNING', 'CRITICAL');
CREATE TYPE alert_status AS ENUM ('PENDIENTE', 'VISTA', 'RESUELTA', 'DESCARTADA');

CREATE TABLE alerts (
    id              bigserial PRIMARY KEY,
    code            varchar(50) NOT NULL,  -- 'TRANSFER_OVERDUE', 'PENDING_DELIVERY_EXPIRING', 'STOCK_BELOW_MIN', 'VOID_ANOMALY', 'RECONCILIATION_GAP'
    severity        alert_severity NOT NULL DEFAULT 'WARNING',
    entity_type     varchar(30),  -- 'TRANSFER', 'DELIVERY', 'PRODUCT', 'LOCATION', 'USER'
    entity_id       integer,
    title           varchar(200) NOT NULL,
    message         text NOT NULL,
    data            jsonb NOT NULL DEFAULT '{}',  -- contexto: { "transfer_id": 123, "hours_overdue": 26 }
    target_roles    varchar(20)[],  -- ['ADMIN', 'ENCARGADO'] - roles que deben verla
    target_location_id integer REFERENCES locations(id),  -- null = global
    status          alert_status NOT NULL DEFAULT 'PENDIENTE',
    acknowledged_by integer REFERENCES users(id),
    acknowledged_at timestamptz,
    resolved_by     integer REFERENCES users(id),
    resolved_at     timestamptz,
    resolution_notes varchar(500),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_alerts_status ON alerts(status, severity, created_at DESC);
CREATE INDEX idx_alerts_target ON alerts(target_roles, target_location_id, status);
CREATE INDEX idx_alerts_entity ON alerts(entity_type, entity_id);

-- ------------------------------------------------------------
-- 8. SNAPSHOTS DE STOCK (puntos de control temporales)
-- ------------------------------------------------------------
CREATE TABLE stock_snapshots (
    id              bigserial PRIMARY KEY,
    location_id     integer NOT NULL REFERENCES locations(id),
    snapshot_type   varchar(20) NOT NULL,  -- 'DAILY', 'WEEKLY', 'MANUAL', 'PRE_COUNT', 'POST_COUNT'
    reference_id    integer,  -- opcional: count_id, transfer_id, etc.
    reference_type  varchar(30),
    total_products  integer NOT NULL DEFAULT 0,
    total_quantity  numeric(18,3) NOT NULL DEFAULT 0,
    total_value     numeric(18,2),  -- sum(qty * cost) si hay costos
    data_hash       varchar(64) NOT NULL,  -- hash del contenido para verficar integridad
    created_by      integer REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_snapshots_loc_date ON stock_snapshots(location_id, created_at DESC);
CREATE INDEX idx_snapshots_ref ON stock_snapshots(reference_type, reference_id);

-- Detalle del snapshot (tabla separada para no duplicar en tabla principal)
CREATE TABLE stock_snapshot_items (
    snapshot_id     bigint NOT NULL REFERENCES stock_snapshots(id) ON DELETE CASCADE,
    product_id      integer NOT NULL REFERENCES products(id),
    quantity        numeric(14,3) NOT NULL DEFAULT 0,
    unit_cost       numeric(14,2),
    PRIMARY KEY (snapshot_id, product_id)
);
CREATE INDEX idx_ss_items_product ON stock_snapshot_items(product_id);

-- ------------------------------------------------------------
-- 9. VERSIONADO DE DOCUMENTOS CRITICOS
-- ------------------------------------------------------------
CREATE TABLE document_versions (
    id              bigserial PRIMARY KEY,
    document_type   varchar(20) NOT NULL,  -- 'TRANSFER', 'DELIVERY', 'ENTRY', 'COUNT'
    document_id     integer NOT NULL,
    version         integer NOT NULL,
    status          varchar(30) NOT NULL,  -- estado en ese momento
    snapshot        jsonb NOT NULL,  -- documento completo serializado
    changed_by      integer NOT NULL REFERENCES users(id),
    changed_at      timestamptz NOT NULL DEFAULT now(),
    change_reason   varchar(255),
    UNIQUE (document_type, document_id, version)
);
CREATE INDEX idx_doc_ver_lookup ON document_versions(document_type, document_id, version DESC);

-- ------------------------------------------------------------
-- 10. CONCILIACION Y DETECCION DE ANOMALIAS
-- ------------------------------------------------------------
CREATE TABLE reconciliation_logs (
    id              bigserial PRIMARY KEY,
    location_id     integer NOT NULL REFERENCES locations(id),
    check_type      varchar(30) NOT NULL,  -- 'BALANCE_VS_MOVEMENTS', 'TRANSFER_GAP', 'PENDING_DELIVERY_STALE', 'NEGATIVE_STOCK'
    status          varchar(20) NOT NULL,  -- 'OK', 'WARNING', 'ERROR', 'FIXED'
    expected_value  numeric(18,3),
    actual_value    numeric(18,3),
    difference      numeric(18,3),
    details         jsonb NOT NULL DEFAULT '{}',  -- productos afectados, movimientos huérfanos, etc.
    fixed_by        integer REFERENCES users(id),
    fixed_at        timestamptz,
    run_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_recon_loc_date ON reconciliation_logs(location_id, run_at DESC);
CREATE INDEX idx_recon_status ON reconciliation_logs(status, run_at DESC);

-- ------------------------------------------------------------
-- 11. CONFIGURACION DE UMERALES POR UBICACION/TIPO
-- ------------------------------------------------------------
CREATE TABLE control_thresholds (
    id                  serial PRIMARY KEY,
    location_id         integer REFERENCES locations(id),  -- null = global
    entity_type         approval_entity NOT NULL,
    metric              varchar(50) NOT NULL,  -- 'qty_sum', 'value_sum', 'lines_count', 'days_in_transit', 'pending_hours'
    threshold_value     numeric(18,3) NOT NULL,
    threshold_operator  varchar(10) NOT NULL DEFAULT 'GT',  -- GT, GTE, LT, LTE, EQ
    action              jsonb NOT NULL DEFAULT '{"require_approval": true}',  -- { "require_approval": true, "min_role": "ENCARGADO", "alert": true }
    is_active           boolean NOT NULL DEFAULT true,
    created_by          integer NOT NULL REFERENCES users(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, entity_type, metric)
);
CREATE INDEX idx_thresholds_lookup ON control_thresholds(location_id, entity_type, is_active);

-- ------------------------------------------------------------
-- 12. FUNCIONES AUXILIARES PARA EL SISTEMA DE CONTROL
-- ------------------------------------------------------------

-- 12.1 Funcion: verificar permiso efectivo (rol + ubicacion)
CREATE OR REPLACE FUNCTION has_effective_permission(p_user_id integer, p_permission varchar, p_location_id integer DEFAULT NULL)
RETURNS boolean AS $$
DECLARE
    v_role varchar(20);
    v_default_loc integer;
    v_has boolean := false;
BEGIN
    -- Obtener rol y ubicacion por defecto del usuario
    SELECT role_code, default_location_id INTO v_role, v_default_loc FROM users WHERE id = p_user_id AND is_active = true;
    IF NOT FOUND THEN RETURN false; END IF;

    -- ADMIN tiene todo globalmente
    IF v_role = 'ADMIN' THEN RETURN true; END IF;

    -- Verificar permiso por rol (tabla PERMISSIONS en codigo, aqui consultamos user_location_permissions)
    -- Primero: permiso GLOBAL
    SELECT true INTO v_has FROM user_location_permissions
    WHERE user_id = p_user_id AND permission = p_permission AND scope = 'GLOBAL'
      AND (expires_at IS NULL OR expires_at > now());
    IF v_has THEN RETURN true; END IF;

    -- Segundo: permiso OWN_LOCATION (coincide con default_location_id)
    IF p_location_id IS NOT NULL THEN
        SELECT true INTO v_has FROM user_location_permissions
        WHERE user_id = p_user_id AND permission = p_permission AND scope = 'OWN_LOCATION'
          AND location_id = p_location_id AND location_id = v_default_loc
          AND (expires_at IS NULL OR expires_at > now());
        IF v_has THEN RETURN true; END IF;
    END IF;

    -- Tercero: permiso LOCATION especifico
    IF p_location_id IS NOT NULL THEN
        SELECT true INTO v_has FROM user_location_permissions
        WHERE user_id = p_user_id AND permission = p_permission AND scope = 'LOCATION'
          AND location_id = p_location_id
          AND (expires_at IS NULL OR expires_at > now());
        IF v_has THEN RETURN true; END IF;
    END IF;

    -- Fallback: permisos por rol (hardcoded en app, aqui solo BD)
    RETURN false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 12.2 Funcion: evaluar reglas de aprobacion para una operacion
CREATE OR REPLACE FUNCTION evaluate_approval_rules(
    p_entity_type approval_entity,
    p_operation varchar,
    p_context jsonb
) RETURNS TABLE (
    rule_id integer,
    rule_name varchar,
    require_approval boolean,
    min_approver_role varchar,
    approvers_count integer,
    allowed_roles varchar[],
    priority integer
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        ar.id,
        ar.name,
        (ar.action->>'require_approval')::boolean,
        ar.action->>'min_approver_role',
        COALESCE((ar.action->>'approvers_count')::int, 1),
        COALESCE((ar.action->>'allowed_roles')::varchar[], ARRAY['ENCARGADO','ADMIN']),
        ar.priority
    FROM approval_rules ar
    WHERE ar.entity_type = p_entity_type
      AND ar.operation = p_operation
      AND ar.is_active = true
      AND (
        -- Evaluar condicion JSON (simplificado: comparar campos numericos)
        (ar.condition->>'qty_gt') IS NULL OR (p_context->>'qty_sum')::numeric > (ar.condition->>'qty_gt')::numeric
      )
      AND (
        (ar.condition->>'value_gt') IS NULL OR (p_context->>'value_sum')::numeric > (ar.condition->>'value_gt')::numeric
      )
      AND (
        (ar.condition->>'location_ids') IS NULL OR p_context->>'location_id' = ANY((ar.condition->>'location_ids')::int[])
      )
      AND (
        (ar.condition->>'user_role') IS NULL OR p_context->>'user_role' = (ar.condition->>'user_role')::text
      )
    ORDER BY ar.priority ASC, ar.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 12.3 Funcion: crear solicitud de aprobacion
CREATE OR REPLACE FUNCTION create_approval_request(
    p_rule_id integer,
    p_entity_type approval_entity,
    p_entity_id integer,
    p_entity_number varchar,
    p_requested_by integer,
    p_context jsonb,
    p_expires_hours integer DEFAULT 48
) RETURNS bigint AS $$
DECLARE
    v_approval_id bigint;
BEGIN
    INSERT INTO approval_requests (rule_id, entity_type, entity_id, entity_number, requested_by, context, expires_at)
    VALUES (p_rule_id, p_entity_type, p_entity_id, p_entity_number, p_requested_by, p_context, now() + (p_expires_hours || ' hours')::interval)
    RETURNING id INTO v_approval_id;

    INSERT INTO approval_history (approval_request_id, action, performed_by, previous_status, new_status, notes)
    VALUES (v_approval_id, 'REQUESTED', p_requested_by, NULL, 'PENDIENTE', 'Solicitud creada automaticamente');

    RETURN v_approval_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 12.4 Funcion: resolver aprobacion
CREATE OR REPLACE FUNCTION resolve_approval_request(
    p_approval_id bigint,
    p_resolved_by integer,
    p_action varchar,  -- 'APPROVE' | 'REJECT'
    p_notes varchar DEFAULT NULL
) RETURNS boolean AS $$
DECLARE
    v_req record;
    v_new_status approval_status;
BEGIN
    SELECT * INTO v_req FROM approval_requests WHERE id = p_approval_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Solicitud de aprobacion no encontrada'; END IF;
    IF v_req.status <> 'PENDIENTE' THEN RAISE EXCEPTION 'Solicitud ya resuelta: %', v_req.status; END IF;

    IF p_action = 'APPROVE' THEN
        v_new_status := 'APROBADO';
    ELSIF p_action = 'REJECT' THEN
        v_new_status := 'RECHAZADO';
    ELSE
        RAISE EXCEPTION 'Accion invalida: %', p_action;
    END IF;

    UPDATE approval_requests SET status = v_new_status, resolved_by = p_resolved_by, resolved_at = now(), resolution_notes = p_notes, updated_at = now()
    WHERE id = p_approval_id;

    INSERT INTO approval_history (approval_request_id, action, performed_by, previous_status, new_status, notes)
    VALUES (p_approval_id, p_action, p_resolved_by, v_req.status, v_new_status, p_notes);

    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 12.5 Funcion: crear alerta
CREATE OR REPLACE FUNCTION create_alert(
    p_code varchar,
    p_severity alert_severity,
    p_entity_type varchar,
    p_entity_id integer,
    p_title varchar,
    p_message text,
    p_data jsonb DEFAULT '{}',
    p_target_roles varchar[] DEFAULT ARRAY['ADMIN','ENCARGADO'],
    p_target_location_id integer DEFAULT NULL
) RETURNS bigint AS $$
DECLARE
    v_alert_id bigint;
BEGIN
    INSERT INTO alerts (code, severity, entity_type, entity_id, title, message, data, target_roles, target_location_id)
    VALUES (p_code, p_severity, p_entity_type, p_entity_id, p_title, p_message, p_data, p_target_roles, p_target_location_id)
    RETURNING id INTO v_alert_id;
    RETURN v_alert_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 12.6 Funcion: crear snapshot de stock
CREATE OR REPLACE FUNCTION create_stock_snapshot(
    p_location_id integer,
    p_snapshot_type varchar,
    p_reference_id integer DEFAULT NULL,
    p_reference_type varchar DEFAULT NULL,
    p_created_by integer DEFAULT NULL
) RETURNS bigint AS $$
DECLARE
    v_snapshot_id bigint;
    v_hash text;
    v_items jsonb;
BEGIN
    -- Agregar items
    SELECT jsonb_agg(jsonb_build_object(
        'productId', sb.product_id,
        'quantity', sb.quantity,
        'unitCost', p.cost
    )) INTO v_items
    FROM stock_balances sb
    JOIN products p ON p.id = sb.product_id
    WHERE sb.location_id = p_location_id AND sb.quantity > 0;

    -- Hash del contenido
    v_hash := encode(digest(v_items::text, 'sha256'), 'hex');

    INSERT INTO stock_snapshots (location_id, snapshot_type, reference_id, reference_type, total_products, total_quantity, total_value, data_hash, created_by)
    SELECT p_location_id, p_snapshot_type, p_reference_id, p_reference_type,
           count(*)::int, sum(sb.quantity), sum(sb.quantity * COALESCE(p.cost, 0)), v_hash, p_created_by
    FROM stock_balances sb
    JOIN products p ON p.id = sb.product_id
    WHERE sb.location_id = p_location_id AND sb.quantity > 0
    RETURNING id INTO v_snapshot_id;

    -- Insertar detalle
    INSERT INTO stock_snapshot_items (snapshot_id, product_id, quantity, unit_cost)
    SELECT v_snapshot_id, sb.product_id, sb.quantity, p.cost
    FROM stock_balances sb
    JOIN products p ON p.id = sb.product_id
    WHERE sb.location_id = p_location_id AND sb.quantity > 0;

    RETURN v_snapshot_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 12.7 Funcion: versionar documento
CREATE OR REPLACE FUNCTION version_document(
    p_document_type varchar,
    p_document_id integer,
    p_status varchar,
    p_snapshot jsonb,
    p_changed_by integer,
    p_change_reason varchar DEFAULT NULL
) RETURNS void AS $$
DECLARE
    v_version integer;
BEGIN
    SELECT COALESCE(max(version), 0) + 1 INTO v_version
    FROM document_versions WHERE document_type = p_document_type AND document_id = p_document_id;

    INSERT INTO document_versions (document_type, document_id, version, status, snapshot, changed_by, change_reason)
    VALUES (p_document_type, p_document_id, v_version, p_status, p_snapshot, p_changed_by, p_change_reason);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 12.8 Trigger para versionar automaticamente cambios de estado clave
-- NOTA: se usa ::text para comparar estados, evitando conflictos de tipo entre enums de distintas tablas (doc_status vs transfer_status vs count_status).
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

-- ------------------------------------------------------------
-- 13. DATOS SEMILLA: REGLAS DE APROBACION POR DEFECTO
-- ------------------------------------------------------------
-- Usar DO block para obtener el ID del admin dinámicamente (seed se ejecuta después de migraciones)
DO $$
DECLARE
    v_admin_id integer;
BEGIN
    SELECT id INTO v_admin_id FROM users WHERE role_code = 'ADMIN' AND is_active = true LIMIT 1;
    IF v_admin_id IS NULL THEN
        RAISE NOTICE 'No hay usuario ADMIN aún, saltando seed de approval_rules y control_thresholds. Se poblarán vía seed.mjs';
        RETURN;
    END IF;

    INSERT INTO approval_rules (name, entity_type, operation, condition, action, priority, created_by) VALUES
    -- TRANSFERS
    ('transfer_qty_approval', 'TRANSFER', 'CREATE', '{"qty_gt": 50}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, v_admin_id),
    ('transfer_value_approval', 'TRANSFER', 'CREATE', '{"value_gt": 50000}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, v_admin_id),
    ('transfer_emp_requires_approval', 'TRANSFER', 'CREATE', '{"user_role": "EMPLEADO"}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 5, v_admin_id),

    -- DELIVERIES
    ('delivery_qty_approval', 'DELIVERY', 'CONFIRM', '{"qty_gt": 100}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, v_admin_id),
    ('delivery_value_approval', 'DELIVERY', 'CONFIRM', '{"value_gt": 100000}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, v_admin_id),
    ('delivery_emp_requires_approval', 'DELIVERY', 'CONFIRM', '{"user_role": "EMPLEADO"}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 5, v_admin_id),

    -- ENTRIES
    ('entry_qty_approval', 'ENTRY', 'CONFIRM', '{"qty_gt": 200}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, v_admin_id),
    ('entry_value_approval', 'ENTRY', 'CONFIRM', '{"value_gt": 200000}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, v_admin_id),

    -- COUNTS
    ('count_large_approval', 'COUNT', 'APPLY', '{"lines_gt": 50}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, v_admin_id),
    ('count_adjustment_approval', 'COUNT', 'APPLY', '{"adjustments_gt": 10}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, v_admin_id),

    -- VOIDS (anulaciones de confirmados)
    ('void_always_dual', 'VOID', 'VOID', '{}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1, "dual_auth": true}', 1, v_admin_id),

    -- STOCK ADJUST (ajustes manuales)
    ('adjust_large_approval', 'STOCK_ADJUST', 'ADJUST', '{"qty_gt": 20}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 10, v_admin_id),
    ('adjust_emp_requires_approval', 'STOCK_ADJUST', 'ADJUST', '{"user_role": "EMPLEADO"}', '{"require_approval": true, "min_approver_role": "ENCARGADO", "approvers_count": 1}', 5, v_admin_id)
    ON CONFLICT (name) DO NOTHING;

    INSERT INTO control_thresholds (location_id, entity_type, metric, threshold_value, threshold_operator, action, created_by) VALUES
    -- Transferencias
    (NULL, 'TRANSFER', 'qty_sum', 50, 'GT', '{"require_approval": true, "min_role": "ENCARGADO", "alert": true}', v_admin_id),
    (NULL, 'TRANSFER', 'days_in_transit', 1, 'GT', '{"alert": true, "alert_roles": ["ADMIN","ENCARGADO"], "alert_code": "TRANSFER_OVERDUE"}', v_admin_id),
    -- Entregas
    (NULL, 'DELIVERY', 'value_sum', 100000, 'GT', '{"require_approval": true, "min_role": "ENCARGADO", "alert": true}', v_admin_id),
    (NULL, 'DELIVERY', 'pending_hours', 40, 'GT', '{"alert": true, "alert_roles": ["ADMIN","ENCARGADO"], "alert_code": "PENDING_DELIVERY_EXPIRING"}', v_admin_id),
    -- Stock bajo
    (NULL, 'PRODUCT', 'stock_below_min', 0, 'GT', '{"alert": true, "alert_roles": ["ADMIN","ENCARGADO"], "alert_code": "STOCK_BELOW_MIN"}', v_admin_id),
    -- Anulaciones anomalas
    (NULL, 'VOID', 'void_count_per_user_day', 3, 'GT', '{"alert": true, "alert_roles": ["ADMIN"], "alert_code": "VOID_ANOMALY"}', v_admin_id)
    ON CONFLICT (location_id, entity_type, metric) DO NOTHING;
END $$;

-- ------------------------------------------------------------
-- 15. PERMISOS POR UBICACION POR DEFECTO (EMPLEADO solo su ubicacion)
-- ------------------------------------------------------------
-- Se poblaran via UI o script; aqui solo estructura.
-- Ejemplo: INSERT INTO user_location_permissions (user_id, location_id, permission, scope, granted_by) VALUES (2, 1, 'deliveries.write', 'OWN_LOCATION', 1);