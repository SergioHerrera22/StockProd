-- Acelera el buscador de productos cuando usa coincidencias parciales (ILIKE '%texto%').
-- El indice trigram de name ya existe en 001_init.sql; estos cubren las otras columnas.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_products_code_trgm
  ON products USING gin (code gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_barcode_trgm
  ON products USING gin (barcode gin_trgm_ops)
  WHERE barcode IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_brand_trgm
  ON products USING gin (brand gin_trgm_ops)
  WHERE brand IS NOT NULL;
