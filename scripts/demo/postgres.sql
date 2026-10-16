-- Demo "shop" dataset for PostgreSQL. Run against an empty tablemax_demo database.
CREATE TABLE customers (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL UNIQUE,
  full_name   text NOT NULL,
  country     char(2),
  is_vip      boolean NOT NULL DEFAULT false,
  balance     numeric(12,2) NOT NULL DEFAULT 0,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id              serial PRIMARY KEY,
  sku             text NOT NULL UNIQUE,
  name            text NOT NULL,
  price           numeric(10,2) NOT NULL,
  stock           integer NOT NULL,
  attributes      jsonb,
  thumbnail       bytea,
  discontinued_on date
);

CREATE TABLE orders (
  id           bigserial PRIMARY KEY,
  customer_id  bigint NOT NULL REFERENCES customers(id),
  status       text NOT NULL CHECK (status IN ('pending','paid','shipped','delivered','cancelled')),
  total        numeric(12,2) NOT NULL DEFAULT 0,
  placed_at    timestamptz NOT NULL,
  shipped_at   timestamptz
);
CREATE INDEX orders_customer_idx ON orders(customer_id);

CREATE TABLE order_items (
  order_id    bigint  NOT NULL REFERENCES orders(id),
  product_id  integer NOT NULL REFERENCES products(id),
  quantity    integer NOT NULL,
  unit_price  numeric(10,2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

-- One row per tricky value the grid must render distinctly.
CREATE TABLE edge_cases (
  id          serial PRIMARY KEY,
  label       text NOT NULL,
  big_id      bigint,
  empty_text  text,
  null_text   text,
  long_text   text,
  unicode     text,
  payload     jsonb,
  raw         bytea,
  ratio       double precision,
  uid         uuid,
  happened_at timestamptz
);

INSERT INTO customers (email, full_name, country, is_vip, balance, notes, created_at)
SELECT
  'user' || n || '@example.test',
  (ARRAY['Alice','Bruno','Chloé','Diego','Emma','Farid','Giulia','Hugo','Inès','Jonas'])[1 + n % 10]
    || ' ' ||
  (ARRAY['Martin','Bernard','Dubois','Rossi','García','Yılmaz','Schmidt','Nowak','Silva','Kowalski','Leroy','Moreau'])[1 + (n / 10) % 12],
  CASE WHEN n % 17 = 0 THEN NULL
       ELSE (ARRAY['FR','DE','IT','ES','TR','PL','PT','BE','CH','NL'])[1 + (n * 7) % 10] END,
  n % 23 = 0,
  round(((n * 37) % 100000) / 100.0, 2),
  CASE WHEN n % 5 = 0 THEN 'Prefers email contact' WHEN n % 11 = 0 THEN '' ELSE NULL END,
  timestamptz '2024-01-01 09:00:00+00' + (n * interval '3 hours 17 minutes')
FROM generate_series(1, 2500) AS n;

INSERT INTO products (sku, name, price, stock, attributes, thumbnail, discontinued_on)
SELECT
  'SKU-' || lpad(n::text, 5, '0'),
  (ARRAY['Desk lamp','Office chair','Mechanical keyboard','USB-C hub','Monitor arm','Notebook','Coffee mug','Standing desk','Webcam','Headset'])[1 + n % 10]
    || ' ' || (ARRAY['Mini','Pro','Max','Lite','Plus','XL'])[1 + (n / 10) % 6],
  round((5 + (n * 913) % 49500 / 100.0)::numeric, 2),
  (n * 13) % 400,
  jsonb_build_object('color', (ARRAY['black','white','oak','grey'])[1 + n % 4],
                     'weight_g', 100 + (n * 29) % 4000,
                     'tags', jsonb_build_array('office', CASE WHEN n % 3 = 0 THEN 'sale' ELSE 'new' END)),
  CASE WHEN n % 4 = 0 THEN decode(md5(n::text), 'hex') ELSE NULL END,
  CASE WHEN n % 15 = 0 THEN date '2025-06-30' + n ELSE NULL END
FROM generate_series(1, 150) AS n;

INSERT INTO orders (customer_id, status, placed_at, shipped_at)
SELECT
  1 + (n * 7919) % 2500,
  (ARRAY['pending','paid','shipped','delivered','delivered','delivered','cancelled'])[1 + n % 7],
  timestamptz '2025-01-01 08:00:00+00' + (n * interval '41 minutes'),
  CASE WHEN n % 7 IN (2,3,4,5) THEN timestamptz '2025-01-02 08:00:00+00' + (n * interval '41 minutes') END
FROM generate_series(1, 12000) AS n;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o.id, p.id, 1 + (o.id + k) % 5, p.price
FROM orders o
CROSS JOIN LATERAL generate_series(1, 1 + (o.id % 4)::int) AS k
JOIN products p ON p.id = 1 + (o.id * 7 + k * 13) % 150;

UPDATE orders o SET total = s.total
FROM (SELECT order_id, sum(quantity * unit_price) AS total FROM order_items GROUP BY order_id) s
WHERE s.order_id = o.id;

INSERT INTO edge_cases (label, big_id, empty_text, null_text, long_text, unicode, payload, raw, ratio, uid, happened_at) VALUES
  ('max bigint (must not round)', 9223372036854775807, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('min bigint', -9223372036854775808, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2^53 + 1', 9007199254740993, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('empty string vs NULL', 0, '', NULL, '', NULL, NULL, NULL, NULL, NULL, NULL),
  ('long text (50k chars)', 1, '', NULL, repeat('lorem ipsum dolor sit amet ', 1900), NULL, NULL, NULL, NULL, NULL, NULL),
  ('unicode', 2, '', NULL, NULL, 'Ünïcödé — 日本語 — العربية — emoji 🦊🚀', NULL, NULL, NULL, NULL, NULL),
  ('multiline', 3, '', NULL, E'line 1\nline 2\n\tindented line 3', NULL, NULL, NULL, NULL, NULL, NULL),
  ('nested json', 4, '', NULL, NULL, NULL, '{"a":{"b":[1,2,{"c":null}]},"ok":true}', NULL, NULL, NULL, NULL),
  ('binary (16 bytes)', 5, '', NULL, NULL, NULL, NULL, decode('deadbeef00112233445566778899aabb', 'hex'), NULL, NULL, NULL),
  ('binary (empty)', 6, '', NULL, NULL, NULL, NULL, ''::bytea, NULL, NULL, NULL),
  ('floats', 7, '', NULL, NULL, NULL, NULL, NULL, 0.1 + 0.2, NULL, NULL),
  ('float special', 8, '', NULL, NULL, NULL, NULL, NULL, 'NaN', NULL, NULL),
  ('uuid + timestamp', 9, '', NULL, NULL, NULL, NULL, NULL, NULL, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '2026-10-16 12:34:56.789+02');

CREATE VIEW vip_customers AS
SELECT c.id, c.full_name, c.country, count(o.id) AS orders, coalesce(sum(o.total), 0) AS revenue
FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
WHERE c.is_vip
GROUP BY c.id;
