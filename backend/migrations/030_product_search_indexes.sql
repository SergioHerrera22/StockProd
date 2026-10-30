-- ============================================================
-- 029: Optimizacion de busqueda de productos
-- El listado busca con ILIKE '%q%' sobre name/code/barcode/brand,
-- pero solo name tenia indice trigram. code/barcode/brand viven en
-- un sequential scan por cada busqueda. Ademas el ORDER BY name
-- ordenaba en memoria sin b-tree.
-- ============================================================

-- Busqueda parcial en las 4 columnas: GIN trigram en cada una
CREATE INDEX IF NOT EXISTS idx_products_code_trgm   ON products USING gin (code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_barcode_trgm ON products USING gin (barcode gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_brand_trgm  ON products USING gin (brand gin_trgm_ops);

-- Orden por nombre (ORDER BY p.name) y paginacion estable
CREATE INDEX IF NOT EXISTS idx_products_name_sort ON products (name);
