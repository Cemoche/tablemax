-- Demo "shop" dataset for MySQL 8 / MariaDB 11. Run against an empty tablemax_demo database.
CREATE TABLE seq (n INT PRIMARY KEY);
INSERT INTO seq (n)
WITH d AS (SELECT 0 AS x UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
           UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)
SELECT 1 + a.x + 10 * b.x + 100 * c.x + 1000 * e.x + 10000 * f.x
FROM d a, d b, d c, d e, d f
WHERE a.x + 10 * b.x + 100 * c.x + 1000 * e.x + 10000 * f.x < 12000;

CREATE TABLE customers (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  email       VARCHAR(255) NOT NULL UNIQUE,
  full_name   VARCHAR(255) NOT NULL,
  country     CHAR(2),
  is_vip      TINYINT(1) NOT NULL DEFAULT 0,
  balance     DECIMAL(12,2) NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  DATETIME NOT NULL
) DEFAULT CHARSET = utf8mb4;

CREATE TABLE products (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  sku             VARCHAR(32) NOT NULL UNIQUE,
  name            VARCHAR(255) NOT NULL,
  price           DECIMAL(10,2) NOT NULL,
  stock           INT NOT NULL,
  attributes      JSON,
  thumbnail       BLOB,
  discontinued_on DATE
) DEFAULT CHARSET = utf8mb4;

CREATE TABLE orders (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id  BIGINT NOT NULL,
  status       ENUM('pending','paid','shipped','delivered','cancelled') NOT NULL,
  total        DECIMAL(12,2) NOT NULL DEFAULT 0,
  placed_at    DATETIME NOT NULL,
  shipped_at   DATETIME NULL,
  KEY orders_customer_idx (customer_id),
  CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id)
) DEFAULT CHARSET = utf8mb4;

CREATE TABLE order_items (
  order_id    BIGINT NOT NULL,
  product_id  INT NOT NULL,
  quantity    INT NOT NULL,
  unit_price  DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (order_id, product_id),
  CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT order_items_product_fk FOREIGN KEY (product_id) REFERENCES products(id)
) DEFAULT CHARSET = utf8mb4;

CREATE TABLE edge_cases (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  label       VARCHAR(255) NOT NULL,
  big_id      BIGINT,
  big_unsigned BIGINT UNSIGNED,
  empty_text  TEXT,
  null_text   TEXT,
  long_text   LONGTEXT,
  unicode     TEXT,
  payload     JSON,
  raw         VARBINARY(64),
  ratio       DOUBLE,
  happened_at DATETIME(3)
) DEFAULT CHARSET = utf8mb4;

INSERT INTO customers (email, full_name, country, is_vip, balance, notes, created_at)
SELECT
  CONCAT('user', n, '@example.test'),
  CONCAT(ELT(1 + n % 10, 'Alice','Bruno','Chloé','Diego','Emma','Farid','Giulia','Hugo','Inès','Jonas'), ' ',
         ELT(1 + (n DIV 10) % 12, 'Martin','Bernard','Dubois','Rossi','García','Yılmaz','Schmidt','Nowak','Silva','Kowalski','Leroy','Moreau')),
  IF(n % 17 = 0, NULL, ELT(1 + (n * 7) % 10, 'FR','DE','IT','ES','TR','PL','PT','BE','CH','NL')),
  n % 23 = 0,
  ROUND(((n * 37) % 100000) / 100.0, 2),
  CASE WHEN n % 5 = 0 THEN 'Prefers email contact' WHEN n % 11 = 0 THEN '' ELSE NULL END,
  TIMESTAMP('2024-01-01 09:00:00') + INTERVAL (n * 197) MINUTE
FROM seq WHERE n <= 2500;

INSERT INTO products (sku, name, price, stock, attributes, thumbnail, discontinued_on)
SELECT
  CONCAT('SKU-', LPAD(n, 5, '0')),
  CONCAT(ELT(1 + n % 10, 'Desk lamp','Office chair','Mechanical keyboard','USB-C hub','Monitor arm','Notebook','Coffee mug','Standing desk','Webcam','Headset'),
         ' ', ELT(1 + (n DIV 10) % 6, 'Mini','Pro','Max','Lite','Plus','XL')),
  ROUND(5 + ((n * 913) % 49500) / 100.0, 2),
  (n * 13) % 400,
  JSON_OBJECT('color', ELT(1 + n % 4, 'black','white','oak','grey'),
              'weight_g', 100 + (n * 29) % 4000,
              'tags', JSON_ARRAY('office', IF(n % 3 = 0, 'sale', 'new'))),
  IF(n % 4 = 0, UNHEX(MD5(n)), NULL),
  IF(n % 15 = 0, DATE('2025-06-30') + INTERVAL n DAY, NULL)
FROM seq WHERE n <= 150;

INSERT INTO orders (customer_id, status, placed_at, shipped_at)
SELECT
  1 + (n * 7919) % 2500,
  ELT(1 + n % 7, 'pending','paid','shipped','delivered','delivered','delivered','cancelled'),
  TIMESTAMP('2025-01-01 08:00:00') + INTERVAL (n * 41) MINUTE,
  IF(n % 7 IN (2,3,4,5), TIMESTAMP('2025-01-02 08:00:00') + INTERVAL (n * 41) MINUTE, NULL)
FROM seq WHERE n <= 12000;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o.id, p.id, 1 + (o.id + k.n) % 5, p.price
FROM orders o
JOIN seq k ON k.n <= 1 + o.id % 4
JOIN products p ON p.id = 1 + (o.id * 7 + k.n * 13) % 150;

UPDATE orders o
JOIN (SELECT order_id, SUM(quantity * unit_price) AS total FROM order_items GROUP BY order_id) s
  ON s.order_id = o.id
SET o.total = s.total;

DROP TABLE seq;

INSERT INTO edge_cases (label, big_id, big_unsigned, empty_text, null_text, long_text, unicode, payload, raw, ratio, happened_at) VALUES
  ('max bigint (must not round)', 9223372036854775807, NULL, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('min bigint', -9223372036854775808, NULL, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('max bigint unsigned', NULL, 18446744073709551615, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('2^53 + 1', 9007199254740993, NULL, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('empty string vs NULL', 0, NULL, '', NULL, '', NULL, NULL, NULL, NULL, NULL),
  ('long text (50k chars)', 1, NULL, '', NULL, REPEAT('lorem ipsum dolor sit amet ', 1900), NULL, NULL, NULL, NULL, NULL),
  ('unicode', 2, NULL, '', NULL, NULL, 'Ünïcödé — 日本語 — العربية — emoji 🦊🚀', NULL, NULL, NULL, NULL),
  ('multiline', 3, NULL, '', NULL, 'line 1\nline 2\n\tindented line 3', NULL, NULL, NULL, NULL, NULL),
  ('nested json', 4, NULL, '', NULL, NULL, NULL, '{"a":{"b":[1,2,{"c":null}]},"ok":true}', NULL, NULL, NULL),
  ('binary (16 bytes)', 5, NULL, '', NULL, NULL, NULL, NULL, UNHEX('deadbeef00112233445566778899aabb'), NULL, NULL),
  ('binary (empty)', 6, NULL, '', NULL, NULL, NULL, NULL, '', NULL, NULL),
  ('floats', 7, NULL, '', NULL, NULL, NULL, NULL, NULL, 0.1e0 + 0.2e0, NULL),
  ('datetime with ms', 9, NULL, '', NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-16 12:34:56.789');

CREATE VIEW vip_customers AS
SELECT c.id, c.full_name, c.country, COUNT(o.id) AS orders, COALESCE(SUM(o.total), 0) AS revenue
FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
WHERE c.is_vip
GROUP BY c.id, c.full_name, c.country;
