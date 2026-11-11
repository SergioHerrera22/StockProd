-- ============================================================
-- ROBLES PINTURERIAS - Sistema Integral de Stock
-- Migracion 001: esquema completo
-- PostgreSQL >= 14
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- Roles ----------
CREATE TABLE roles (
  id          serial PRIMARY KEY,
  code        varchar(20)  NOT NULL UNIQUE,
  name        varchar(80)  NOT NULL
);

-- ---------- Ubicaciones (sucursales y deposito) ----------
CREATE TYPE location_type AS ENUM ('SUCURSAL', 'DEPOSITO');

CREATE TABLE locations (
  id          serial PRIMARY KEY,
  code        varchar(10)  NOT NULL UNIQUE,
  name        varchar(120) NOT NULL,
  type        location_type NOT NULL DEFAULT 'SUCURSAL',
  address     varchar(200),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Usuarios ----------
CREATE TABLE users (
  id                  serial PRIMARY KEY,
  username            varchar(60)  NOT NULL UNIQUE,
  password_hash       varchar(200) NOT NULL,
  full_name           varchar(120) NOT NULL,
  role_code           varchar(20)  NOT NULL REFERENCES roles(code),
  default_location_id integer REFERENCES locations(id),
  is_active           boolean NOT NULL DEFAULT true,
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_role ON users(role_code);

-- ---------- Categorias ----------
CREATE TABLE categories (
  id          serial PRIMARY KEY,
  name        varchar(120) NOT NULL UNIQUE,
  description varchar(255),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Productos ----------
CREATE TYPE unit_type AS ENUM ('UNIDAD', 'LITRO', 'KG', 'METRO', 'OTRO');

CREATE TABLE products (
  id              serial PRIMARY KEY,
  code            varchar(40)  NOT NULL UNIQUE,           -- codigo interno del articulo
  barcode         varchar(60)  UNIQUE,                    -- opcional
  name            varchar(200) NOT NULL,
  description     text,
  brand           varchar(100),
  category_id     integer REFERENCES categories(id),
  unit            unit_type    NOT NULL DEFAULT 'UNIDAD',
  min_stock       numeric(14,3) NOT NULL DEFAULT 0,
  cost            numeric(14,2),                          -- opcional, permiso restringido
  reference_price numeric(14,2),                          -- opcional, permiso restringido
  is_active       boolean NOT NULL DEFAULT true,
  created_by      integer REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_name_trgm ON products USING gin (name gin_trgm_ops);
CREATE INDEX idx_products_brand     ON products(brand);
CREATE INDEX idx_products_category  ON products(category_id);
CREATE INDEX idx_products_active    ON products(is_active);

-- ---------- Saldos de stock (producto x ubicacion) ----------
CREATE TABLE stock_balances (
  product_id  integer NOT NULL REFERENCES products(id),
  location_id integer NOT NULL REFERENCES locations(id),
  quantity    numeric(14,3) NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, location_id),
  CONSTRAINT quantity_non_negative CHECK (quantity >= 0)
);
CREATE INDEX idx_balances_location ON stock_balances(location_id);

-- ---------- Numeradores de documentos ----------
CREATE SEQUENCE seq_delivery_number     START 1;
CREATE SEQUENCE seq_stock_entry_number  START 1;
CREATE SEQUENCE seq_transfer_number     START 1;
CREATE SEQUENCE seq_stock_count_number  START 1;

-- ---------- Tipos de movimiento y referencia ----------
CREATE TYPE movement_type AS ENUM (
  'ENTRADA', 'SALIDA', 'AJUSTE_POS', 'AJUSTE_NEG', 'TRANS_SALIDA', 'TRANS_ENTRADA'
);
CREATE TYPE reference_type AS ENUM ('DELIVERY', 'ENTRY', 'TRANSFER', 'COUNT', 'MANUAL');

-- ---------- Historial de movimientos ----------
CREATE TABLE stock_movements (
  id               bigserial PRIMARY KEY,
  product_id       integer NOT NULL REFERENCES products(id),
  location_id      integer NOT NULL REFERENCES locations(id),
  type             movement_type NOT NULL,
  quantity         numeric(14,3) NOT NULL CHECK (quantity > 0),
  balance_before   numeric(14,3) NOT NULL,
  balance_after    numeric(14,3) NOT NULL,
  reference_type   reference_type NOT NULL,
  reference_id     integer NOT NULL,
  reference_number varchar(30),
  user_id          integer NOT NULL REFERENCES users(id),
  reason           varchar(255),
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_mov_product    ON stock_movements(product_id, created_at DESC);
CREATE INDEX idx_mov_location   ON stock_movements(location_id, created_at DESC);
CREATE INDEX idx_mov_created    ON stock_movements(created_at DESC);
CREATE INDEX idx_mov_reference  ON stock_movements(reference_type, reference_id);
CREATE INDEX idx_mov_user       ON stock_movements(user_id, created_at DESC);

-- ---------- Entregas de mercaderia ----------
CREATE TYPE doc_status AS ENUM ('BORRADOR', 'CONFIRMADO', 'ANULADO');

CREATE TABLE deliveries (
  id             serial PRIMARY KEY,
  number         varchar(20) NOT NULL UNIQUE,
  location_id    integer NOT NULL REFERENCES locations(id),
  status         doc_status NOT NULL DEFAULT 'BORRADOR',
  invoice_number varchar(40),
  notes          text,
  created_by     integer NOT NULL REFERENCES users(id),
  confirmed_by   integer REFERENCES users(id),
  confirmed_at   timestamptz,
  voided_by      integer REFERENCES users(id),
  voided_at      timestamptz,
  void_reason    varchar(255),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_deliveries_status   ON deliveries(status, created_at DESC);
CREATE INDEX idx_deliveries_location ON deliveries(location_id, created_at DESC);

CREATE TABLE delivery_items (
  id                 serial PRIMARY KEY,
  delivery_id        integer NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  product_id         integer NOT NULL REFERENCES products(id),
  quantity           numeric(14,3) NOT NULL CHECK (quantity > 0),
  requested_quantity numeric(14,3),
  UNIQUE (delivery_id, product_id)
);
CREATE INDEX idx_delivery_items_product ON delivery_items(product_id);

-- ---------- Entradas de mercaderia ----------
CREATE TABLE stock_entries (
  id           serial PRIMARY KEY,
  number       varchar(20) NOT NULL UNIQUE,
  location_id  integer NOT NULL REFERENCES locations(id),
  type         varchar(20) NOT NULL DEFAULT 'COMPRA',   -- COMPRA | DEVOLUCION | OTRO
  supplier     varchar(150),
  status       doc_status NOT NULL DEFAULT 'BORRADOR',
  notes        text,
  created_by   integer NOT NULL REFERENCES users(id),
  confirmed_by integer REFERENCES users(id),
  confirmed_at timestamptz,
  voided_by    integer REFERENCES users(id),
  voided_at    timestamptz,
  void_reason  varchar(255),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_entries_status   ON stock_entries(status, created_at DESC);
CREATE INDEX idx_entries_location ON stock_entries(location_id, created_at DESC);

CREATE TABLE stock_entry_items (
  id         serial PRIMARY KEY,
  entry_id   integer NOT NULL REFERENCES stock_entries(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES products(id),
  quantity   numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_cost  numeric(14,2),
  UNIQUE (entry_id, product_id)
);
CREATE INDEX idx_entry_items_product ON stock_entry_items(product_id);

-- ---------- Transferencias entre ubicaciones ----------
CREATE TYPE transfer_status AS ENUM ('EN_TRANSITO', 'RECIBIDO', 'RECIBIDO_CON_DIF', 'ANULADO');

CREATE TABLE transfers (
  id                      serial PRIMARY KEY,
  number                  varchar(20) NOT NULL UNIQUE,
  origin_location_id      integer NOT NULL REFERENCES locations(id),
  destination_location_id integer NOT NULL REFERENCES locations(id),
  status                  transfer_status NOT NULL DEFAULT 'EN_TRANSITO',
  notes                   text,
  created_by              integer NOT NULL REFERENCES users(id),
  sent_at                 timestamptz NOT NULL DEFAULT now(),
  received_by             integer REFERENCES users(id),
  received_at             timestamptz,
  voided_by               integer REFERENCES users(id),
  voided_at               timestamptz,
  void_reason             varchar(255),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfer_distinct_locations CHECK (origin_location_id <> destination_location_id)
);
CREATE INDEX idx_transfers_status ON transfers(status, created_at DESC);
CREATE INDEX idx_transfers_origin ON transfers(origin_location_id);
CREATE INDEX idx_transfers_dest   ON transfers(destination_location_id);

CREATE TABLE transfer_items (
  id                serial PRIMARY KEY,
  transfer_id       integer NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  product_id        integer NOT NULL REFERENCES products(id),
  quantity_sent     numeric(14,3) NOT NULL CHECK (quantity_sent > 0),
  quantity_received numeric(14,3),
  UNIQUE (transfer_id, product_id)
);
CREATE INDEX idx_transfer_items_product ON transfer_items(product_id);

-- ---------- Inventarios fisicos (recuentos) ----------
CREATE TYPE count_status AS ENUM ('ABIERTO', 'APLICADO', 'ANULADO');

CREATE TABLE stock_counts (
  id          serial PRIMARY KEY,
  number      varchar(20) NOT NULL UNIQUE,
  location_id integer NOT NULL REFERENCES locations(id),
  status      count_status NOT NULL DEFAULT 'ABIERTO',
  notes       text,
  created_by  integer NOT NULL REFERENCES users(id),
  approved_by integer REFERENCES users(id),
  applied_at  timestamptz,
  voided_by   integer REFERENCES users(id),
  voided_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_counts_status   ON stock_counts(status, created_at DESC);
CREATE INDEX idx_counts_location ON stock_counts(location_id);

CREATE TABLE stock_count_items (
  id               serial PRIMARY KEY,
  count_id         integer NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_id       integer NOT NULL REFERENCES products(id),
  system_quantity  numeric(14,3) NOT NULL DEFAULT 0,  -- snapshot al abrir
  counted_quantity numeric(14,3),
  adjusted         boolean NOT NULL DEFAULT false,
  UNIQUE (count_id, product_id)
);
CREATE INDEX idx_count_items_product ON stock_count_items(product_id);

-- ---------- Auditoria ----------
CREATE TABLE audit_logs (
  id         bigserial PRIMARY KEY,
  user_id    integer REFERENCES users(id),
  action     varchar(60) NOT NULL,
  entity     varchar(40) NOT NULL,
  entity_id  integer,
  details    jsonb,
  ip         varchar(60),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_user     ON audit_logs(user_id, created_at DESC);
CREATE INDEX idx_audit_entity   ON audit_logs(entity, entity_id);
CREATE INDEX idx_audit_created  ON audit_logs(created_at DESC);

-- ---------- Funcion: touch de updated_at ----------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_products_touch   BEFORE UPDATE ON products  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_locations_touch  BEFORE UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_users_touch      BEFORE UPDATE ON users     FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_deliveries_touch BEFORE UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_entries_touch    BEFORE UPDATE ON stock_entries FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
