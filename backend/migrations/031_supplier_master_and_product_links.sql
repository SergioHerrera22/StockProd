-- Proveedores como entidad maestra y relación muchos-a-muchos con productos.
CREATE TABLE IF NOT EXISTS suppliers (
 id serial PRIMARY KEY, name varchar(180) NOT NULL, tax_id varchar(20), contact_name varchar(150),
 phone varchar(60), email varchar(180), address varchar(255), notes text,
 is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_name_lower ON suppliers (lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_tax_id ON suppliers (tax_id) WHERE tax_id IS NOT NULL AND btrim(tax_id) <> '';
CREATE INDEX IF NOT EXISTS idx_suppliers_active_name ON suppliers (is_active, name);
CREATE TABLE IF NOT EXISTS product_suppliers (
 product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 supplier_id integer NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
 is_primary boolean NOT NULL DEFAULT false, supplier_product_code varchar(80), notes varchar(500),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (product_id, supplier_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_suppliers_one_primary ON product_suppliers(product_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_product_suppliers_supplier ON product_suppliers(supplier_id, product_id);
ALTER TABLE stock_entries ADD COLUMN IF NOT EXISTS supplier_id integer REFERENCES suppliers(id) ON DELETE SET NULL;
ALTER TABLE stock_entries ALTER COLUMN supplier TYPE varchar(180);
CREATE INDEX IF NOT EXISTS idx_stock_entries_supplier ON stock_entries(supplier_id, status, created_at DESC);

INSERT INTO suppliers (name)
SELECT DISTINCT btrim(supplier) FROM stock_entries
WHERE NULLIF(btrim(supplier), '') IS NOT NULL ON CONFLICT DO NOTHING;
UPDATE stock_entries e SET supplier_id = s.id FROM suppliers s
WHERE e.supplier_id IS NULL AND NULLIF(btrim(e.supplier), '') IS NOT NULL
AND lower(btrim(e.supplier)) = lower(btrim(s.name));

WITH latest_supplier_purchase AS (
 SELECT DISTINCT ON (ei.product_id,e.supplier_id)
        ei.product_id,e.supplier_id,COALESCE(e.confirmed_at,e.created_at) AS purchased_at,e.id AS entry_id
 FROM stock_entry_items ei JOIN stock_entries e ON e.id=ei.entry_id
 WHERE e.status='CONFIRMADO' AND e.type='COMPRA' AND e.supplier_id IS NOT NULL
 ORDER BY ei.product_id,e.supplier_id,COALESCE(e.confirmed_at,e.created_at) DESC,e.id DESC
), ranked AS (
 SELECT product_id,supplier_id,
        row_number() OVER(PARTITION BY product_id ORDER BY purchased_at DESC,entry_id DESC) AS supplier_rank
 FROM latest_supplier_purchase
)
INSERT INTO product_suppliers(product_id,supplier_id,is_primary)
SELECT product_id,supplier_id,supplier_rank=1 FROM ranked
ON CONFLICT(product_id,supplier_id) DO UPDATE SET is_primary=product_suppliers.is_primary OR EXCLUDED.is_primary;
