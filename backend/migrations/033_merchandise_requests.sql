-- Pedidos internos de mercadería desde sucursales al Depósito Central.
-- Este módulo registra solicitudes; no crea transferencias ni modifica existencias.
CREATE TYPE merchandise_request_status AS ENUM ('PENDIENTE','VISTO','EN_PREPARACION','ATENDIDO','RECHAZADO');

CREATE TABLE merchandise_requests (
  id serial PRIMARY KEY,
  number varchar(24) NOT NULL UNIQUE,
  origin_location_id integer NOT NULL REFERENCES locations(id),
  destination_location_id integer NOT NULL REFERENCES locations(id),
  created_by integer NOT NULL REFERENCES users(id),
  status merchandise_request_status NOT NULL DEFAULT 'PENDIENTE',
  notes text,
  handled_by integer REFERENCES users(id),
  handled_at timestamptz,
  rejection_reason varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchandise_request_distinct_locations CHECK (origin_location_id <> destination_location_id)
);
CREATE TABLE merchandise_request_items (
  id serial PRIMARY KEY,
  request_id integer NOT NULL REFERENCES merchandise_requests(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES products(id),
  quantity_requested numeric(14,3) NOT NULL CHECK (quantity_requested >= 3),
  UNIQUE (request_id, product_id)
);
CREATE INDEX idx_merch_requests_status_created ON merchandise_requests(status, created_at DESC);
CREATE INDEX idx_merch_requests_destination ON merchandise_requests(destination_location_id, created_at DESC);
CREATE INDEX idx_merch_requests_origin ON merchandise_requests(origin_location_id, created_at DESC);
CREATE INDEX idx_merch_request_items_request ON merchandise_request_items(request_id);
