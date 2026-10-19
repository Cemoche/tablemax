-- Demo "shop" dataset for SQLite. Run against a fresh database file.
PRAGMA foreign_keys = ON;
BEGIN;

CREATE TABLE customers (
  id          INTEGER PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  full_name   TEXT NOT NULL,
  country     TEXT,
  is_vip      BOOLEAN NOT NULL DEFAULT 0,
  balance     NUMERIC NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  DATETIME NOT NULL
);

CREATE TABLE products (
  id              INTEGER PRIMARY KEY,
  sku             TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  price           NUMERIC NOT NULL,
  stock           INTEGER NOT NULL,
  attributes      JSON,
  thumbnail       BLOB,
  discontinued_on DATE
);

CREATE TABLE orders (
  id           INTEGER PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  status       TEXT NOT NULL CHECK (status IN ('pending','paid','shipped','delivered','cancelled')),
  total        NUMERIC NOT NULL DEFAULT 0,
  placed_at    DATETIME NOT NULL,
  shipped_at   DATETIME
);
CREATE INDEX orders_customer_idx ON orders(customer_id);

CREATE TABLE order_items (
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  quantity    INTEGER NOT NULL,
  unit_price  NUMERIC NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE edge_cases (
  id          INTEGER PRIMARY KEY,
  label       TEXT NOT NULL,
  big_id      INTEGER,
  empty_text  TEXT,
  null_text   TEXT,
  long_text   TEXT,
  unicode     TEXT,
  payload     JSON,
  raw         BLOB,
  ratio       REAL,
  happened_at DATETIME
);

INSERT INTO customers (email, full_name, country, is_vip, balance, notes, created_at)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 2500)
SELECT
  'user' || n || '@example.test',
  json_extract('["Alice","Bruno","Chloé","Diego","Emma","Farid","Giulia","Hugo","Inès","Jonas"]', '$[' || (n % 10) || ']')
    || ' ' ||
  json_extract('["Martin","Bernard","Dubois","Rossi","García","Yılmaz","Schmidt","Nowak","Silva","Kowalski","Leroy","Moreau"]', '$[' || ((n / 10) % 12) || ']'),
  CASE WHEN n % 17 = 0 THEN NULL
       ELSE json_extract('["FR","DE","IT","ES","TR","PL","PT","BE","CH","NL"]', '$[' || ((n * 7) % 10) || ']') END,
  n % 23 = 0,
  round(((n * 37) % 100000) / 100.0, 2),
  CASE WHEN n % 5 = 0 THEN 'Prefers email contact' WHEN n % 11 = 0 THEN '' ELSE NULL END,
  datetime('2024-01-01 09:00:00', '+' || (n * 197) || ' minutes')
FROM s;

INSERT INTO products (sku, name, price, stock, attributes, thumbnail, discontinued_on)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 150)
SELECT
  'SKU-' || substr('0000' || n, -5),
  json_extract('["Desk lamp","Office chair","Mechanical keyboard","USB-C hub","Monitor arm","Notebook","Coffee mug","Standing desk","Webcam","Headset"]', '$[' || (n % 10) || ']')
    || ' ' || json_extract('["Mini","Pro","Max","Lite","Plus","XL"]', '$[' || ((n / 10) % 6) || ']'),
  round(5 + ((n * 913) % 49500) / 100.0, 2),
  (n * 13) % 400,
  json_object('color', json_extract('["black","white","oak","grey"]', '$[' || (n % 4) || ']'),
              'weight_g', 100 + (n * 29) % 4000,
              'tags', json_array('office', CASE WHEN n % 3 = 0 THEN 'sale' ELSE 'new' END)),
  CASE WHEN n % 4 = 0 THEN randomblob(16) ELSE NULL END,
  CASE WHEN n % 15 = 0 THEN date('2025-06-30', '+' || n || ' days') ELSE NULL END
FROM s;

INSERT INTO orders (customer_id, status, placed_at, shipped_at)
WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 12000)
SELECT
  1 + (n * 7919) % 2500,
  json_extract('["pending","paid","shipped","delivered","delivered","delivered","cancelled"]', '$[' || (n % 7) || ']'),
  datetime('2025-01-01 08:00:00', '+' || (n * 41) || ' minutes'),
  CASE WHEN n % 7 IN (2,3,4,5) THEN datetime('2025-01-02 08:00:00', '+' || (n * 41) || ' minutes') END
FROM s;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
WITH RECURSIVE k(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM k WHERE n < 4)
SELECT o.id, p.id, 1 + (o.id + k.n) % 5, p.price
FROM orders o
JOIN k ON k.n <= 1 + o.id % 4
JOIN products p ON p.id = 1 + (o.id * 7 + k.n * 13) % 150;

UPDATE orders SET total = (
  SELECT round(sum(quantity * unit_price), 2) FROM order_items WHERE order_id = orders.id
);

INSERT INTO edge_cases (label, big_id, empty_text, null_text, long_text, unicode, payload, raw, ratio, happened_at) VALUES
  ('max bigint (must not round)', 9223372036854775807, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('min bigint', -9223372036854775808, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2^53 + 1', 9007199254740993, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('empty string vs NULL', 0, '', NULL, '', NULL, NULL, NULL, NULL, NULL),
  ('long text (50k chars)', 1, '', NULL, replace(hex(zeroblob(1900)), '00', 'lorem ipsum dolor sit amet '), NULL, NULL, NULL, NULL, NULL),
  ('unicode', 2, '', NULL, NULL, 'Ünïcödé — 日本語 — العربية — emoji 🦊🚀', NULL, NULL, NULL, NULL),
  ('multiline', 3, '', NULL, 'line 1' || char(10) || 'line 2' || char(10) || char(9) || 'indented line 3', NULL, NULL, NULL, NULL, NULL),
  ('nested json', 4, '', NULL, NULL, NULL, '{"a":{"b":[1,2,{"c":null}]},"ok":true}', NULL, NULL, NULL),
  ('binary (16 bytes)', 5, '', NULL, NULL, NULL, NULL, x'deadbeef00112233445566778899aabb', NULL, NULL),
  ('binary (empty)', 6, '', NULL, NULL, NULL, NULL, x'', NULL, NULL),
  ('floats', 7, '', NULL, NULL, NULL, NULL, NULL, 0.1 + 0.2, NULL),
  ('dynamic typing: text in INTEGER column', 'not a number', '', NULL, NULL, NULL, NULL, NULL, NULL, NULL);

CREATE VIEW vip_customers AS
SELECT c.id, c.full_name, c.country, count(o.id) AS orders, coalesce(sum(o.total), 0) AS revenue
FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
WHERE c.is_vip
GROUP BY c.id;

COMMIT;
