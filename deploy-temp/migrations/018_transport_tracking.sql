-- ============================================================
-- Migracion 018: Transporte / Reparto con GPS
-- ============================================================
-- Un VIAJE (delivery_trips) es la ruta de una camioneta de reparto que sale
-- de una ubicacion de ORIGEN y hace PARADAS (trip_stops). Cada parada lleva
-- un documento:
--   - TRANSFER (T-...)        -> transferencia entre sucursales (EN_TRANSITO)
--   - PENDING_DELIVERY (PD-*) -> orden de retiro derivada: mercaderia que viaja
--                               de la sucursal de origen a la de retiro
--   - DELIVERY (EN-...)       -> pedido a domicilio (puede llevar direccion),
--                                sin sucursal destino obligatoria
-- El chofer comparte su ubicacion desde el celular (geolocalizacion del
-- navegador, ver Permissions-Policy) y cada punto se persiste en
-- trip_positions: el admin y las sucursales ven el mapa en vivo. Los puntos
-- no participan del stock: el documento de cada parada se cierra por su
-- flujo normal (recepcion de transferencia, confirmacion de retiro, etc.).

CREATE TYPE trip_status AS ENUM ('EN_PREPARACION', 'EN_RUTA', 'COMPLETADO', 'CANCELADO');

CREATE SEQUENCE seq_trip_number;

CREATE TABLE delivery_trips (
  id                 serial PRIMARY KEY,
  number             varchar(20) NOT NULL UNIQUE,        -- RP-000001
  origin_location_id integer NOT NULL REFERENCES locations(id),
  driver_user_id     integer REFERENCES users(id),       -- opcional: chofer con usuario
  driver_name        varchar(120) NOT NULL,
  driver_phone       varchar(40),
  vehicle            varchar(120),                       -- "Fiorino ABC123"
  notes              text,
  status             trip_status NOT NULL DEFAULT 'EN_PREPARACION',
  departed_at        timestamptz,
  completed_at       timestamptz,
  cancelled_at       timestamptz,
  cancel_reason      varchar(255),
  created_by         integer NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_delivery_trips_touch BEFORE UPDATE ON delivery_trips
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX idx_trips_status ON delivery_trips(status, created_at DESC);
CREATE INDEX idx_trips_origin ON delivery_trips(origin_location_id);
CREATE INDEX idx_trips_driver ON delivery_trips(driver_user_id);

CREATE TABLE trip_stops (
  id                  serial PRIMARY KEY,
  trip_id             integer NOT NULL REFERENCES delivery_trips(id) ON DELETE CASCADE,
  sequence            integer NOT NULL,                   -- 1, 2, 3... (orden de la ruta)
  -- Parada en sucursal (TRANSFER siempre; PENDING_DELIVERY casi siempre).
  -- Los pedidos a domicilio (DELIVERY) manejan address y pueden quedar sin sucursal.
  location_id         integer REFERENCES locations(id),
  delivery_id         integer REFERENCES deliveries(id),
  transfer_id         integer REFERENCES transfers(id),
  pending_delivery_id integer REFERENCES pending_deliveries(id),
  doc_type            varchar(20) NOT NULL
                      CHECK (doc_type IN ('DELIVERY', 'TRANSFER', 'PENDING_DELIVERY')),
  reference           varchar(40) NOT NULL,               -- numero del doc (EN-000123, T-000045, PD-000009)
  customer_name       varchar(150),
  address             varchar(250),
  delivered_at        timestamptz,
  delivered_by        integer REFERENCES users(id),
  notes               varchar(255),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, sequence),
  CHECK (delivery_id IS NOT NULL OR transfer_id IS NOT NULL
         OR pending_delivery_id IS NOT NULL OR location_id IS NOT NULL)
);

CREATE TRIGGER trg_trip_stops_touch BEFORE UPDATE ON trip_stops
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX idx_trip_stops_trip  ON trip_stops(trip_id, sequence);
CREATE INDEX idx_trip_stops_dlv   ON trip_stops(delivery_id);
CREATE INDEX idx_trip_stops_trf   ON trip_stops(transfer_id);
CREATE INDEX idx_trip_stops_pd    ON trip_stops(pending_delivery_id);
CREATE INDEX idx_trip_stops_loc   ON trip_stops(location_id);

CREATE TABLE trip_positions (
  id            bigserial PRIMARY KEY,
  trip_id       integer NOT NULL REFERENCES delivery_trips(id) ON DELETE CASCADE,
  lat           double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng           double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy      real,
  speed         real,          -- m/s
  heading       real,          -- grados de rumbo 0-360
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  source_user_id integer REFERENCES users(id)
);

CREATE INDEX idx_trip_positions_trip ON trip_positions(trip_id, id);
CREATE INDEX idx_trip_positions_time ON trip_positions(trip_id, recorded_at DESC);
