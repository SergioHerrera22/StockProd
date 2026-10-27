-- ============================================================
-- 025: COMPARTIR UBICACION CONTINUA (GPS del chofer)
--  - Rol TRANSPORTE (chofer): solo ver y operar repartos.
--  - gps_shares: sesiones de compartido por usuario (hasta logout).
--  - driver_positions: feed de posiciones a nivel usuario (independiente
--    del viaje; cuando hay viaje EN_RUTA el motor espeja a trip_positions).
--  - app_settings: configuraciones globales (horario laboral de GPS).
-- ============================================================

-- Rol operador de transporte (sin tracking.write: no arma viajes)
INSERT INTO roles (code, name) VALUES ('TRANSPORTE', 'Transporte / Chofer')
ON CONFLICT (code) DO NOTHING;

-- ---------- Sesiones de compartido ----------
CREATE TABLE gps_shares (
  id            serial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES users(id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  last_ping_at  timestamptz,
  ended_at      timestamptz,
  end_reason    varchar(30)          -- 'user' (boton Detener) | 'logout' | 'replace'
);
CREATE INDEX idx_gps_shares_user ON gps_shares(user_id, ended_at);
CREATE INDEX idx_gps_shares_active ON gps_shares(user_id) WHERE ended_at IS NULL;

-- ---------- Feed de posiciones por usuario ----------
-- El chofer comparte UNA relacion de userId; el mapa en vivo dibuja su punto
-- aunque no tenga viaje abierto. Si tiene viaje EN_RUTA, el server tambien
-- inserta en trip_positions para no duplicar logica en el cliente.
CREATE TABLE driver_positions (
  id           bigserial PRIMARY KEY,
  user_id      integer NOT NULL REFERENCES users(id),
  trip_id      integer REFERENCES delivery_trips(id),  -- viaje con el que se espejo (nullable)
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  accuracy     real,
  speed        real,
  heading      real,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_driver_positions_user ON driver_positions(user_id, id DESC);
CREATE INDEX idx_driver_positions_trip ON driver_positions(trip_id, id DESC) WHERE trip_id IS NOT NULL;

-- ---------- Configuraciones globales ----------
CREATE TABLE app_settings (
  key         varchar(100) PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  integer REFERENCES users(id)
);

-- Horario laboral de compartido GPS. NULL/ausente = sin restriccion.
-- Estructura: { "enabled": false, "days": [1,2,3,4,5], "start": "08:00", "end": "18:00" }
-- days: 0=domingo .. 6=sabado (dow de Postgres).
