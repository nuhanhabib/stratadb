export interface Example {
  title: string;
  blurb: string;
  sql: string;
}

export const EXAMPLES: Example[] = [
  {
    title: 'Top customers by revenue',
    blurb: 'Three-table hash join, aggregation, sort and limit.',
    sql: `-- Who are our ten best customers?
-- Open the "Query plan" tab to see two hash joins feeding a hash aggregate.
SELECT c.name,
       c.country,
       COUNT(DISTINCT o.id)                      AS orders,
       ROUND(SUM(i.quantity * i.unit_price), 2)  AS revenue
FROM customers c
JOIN orders o      ON o.customer_id = c.id
JOIN order_items i ON i.order_id = o.id
WHERE o.status <> 'cancelled'
GROUP BY c.name, c.country
ORDER BY revenue DESC
LIMIT 10;`,
  },
  {
    title: 'Index scan vs. sequential scan',
    blurb: 'The same shape of query, two very different plans.',
    sql: `-- customer_id is indexed: the planner descends the B+tree and reads ~20 rows.
EXPLAIN ANALYZE
SELECT * FROM orders WHERE customer_id = 7;

-- status is not indexed: every one of the 8,000 rows must be examined.
EXPLAIN ANALYZE
SELECT * FROM orders WHERE status = 'returned';`,
  },
  {
    title: 'Add an index, watch the plan change',
    blurb: 'CREATE INDEX turns a full scan into a range scan.',
    sql: `EXPLAIN ANALYZE
SELECT name, price FROM products WHERE price BETWEEN 100 AND 150;

CREATE INDEX products_price_idx ON products (price);

-- Same query, now answered by walking the linked leaves of the B+tree.
EXPLAIN ANALYZE
SELECT name, price FROM products WHERE price BETWEEN 100 AND 150;

DROP INDEX products_price_idx;`,
  },
  {
    title: 'Predicate pushdown',
    blurb: 'Filters run at the scans, below the join.',
    sql: `-- Both WHERE conditions mention a single table, so the planner evaluates
-- them before joining instead of filtering the joined result.
SELECT o.id, o.order_date, c.name
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE c.country = 'Japan'
  AND o.order_date >= '2024-11-01'
ORDER BY o.order_date DESC;`,
  },
  {
    title: 'Customers who never ordered',
    blurb: 'LEFT JOIN ... IS NULL anti-join.',
    sql: `-- The IS NULL test must run after the join, on the NULL-extended rows.
-- A planner that pushed it down into the orders scan would return nothing.
SELECT c.id, c.name, c.email
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
WHERE o.id IS NULL
ORDER BY c.id
LIMIT 20;`,
  },
  {
    title: 'Revenue by category',
    blurb: 'GROUP BY with HAVING and several aggregates.',
    sql: `SELECT p.category,
       COUNT(*)                                  AS line_items,
       SUM(i.quantity)                           AS units,
       ROUND(AVG(i.unit_price), 2)               AS avg_price,
       ROUND(SUM(i.quantity * i.unit_price), 2)  AS revenue
FROM order_items i
JOIN products p ON p.id = i.product_id
GROUP BY p.category
HAVING SUM(i.quantity) > 1000
ORDER BY revenue DESC;`,
  },
  {
    title: 'Subqueries and CASE',
    blurb: 'Products priced above average, bucketed.',
    sql: `SELECT name,
       category,
       price,
       CASE
         WHEN price >= 500 THEN 'luxury'
         WHEN price >= 150 THEN 'premium'
         ELSE 'standard'
       END AS tier
FROM products
WHERE price > (SELECT AVG(price) FROM products)
  AND category IN (SELECT category FROM products WHERE price > 800)
ORDER BY price DESC
LIMIT 15;`,
  },
  {
    title: 'Transactions and rollback',
    blurb: 'Undo a destructive change, including schema changes.',
    sql: `SELECT COUNT(*) AS orders_before FROM orders;

BEGIN;
DELETE FROM orders WHERE status = 'cancelled';
UPDATE products SET price = price * 2;
DROP TABLE customers;
SELECT COUNT(*) AS orders_inside_transaction FROM orders;
ROLLBACK;

-- Everything is back, indexes included.
SELECT COUNT(*) AS orders_after FROM orders;
SELECT COUNT(*) AS customers_after FROM customers;`,
  },
  {
    title: 'Constraints and atomic statements',
    blurb: 'A failing statement leaves no partial effects.',
    sql: `CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL UNIQUE,
  balance REAL NOT NULL DEFAULT 0
);
DELETE FROM accounts;
INSERT INTO accounts (owner, balance) VALUES ('ada', 100), ('grace', 250);

SELECT * FROM accounts;

-- The third row violates UNIQUE(owner). The first two rows of this same
-- statement are rolled back with it: run it and then count the rows.
INSERT INTO accounts (owner, balance) VALUES ('linus', 10), ('ken', 20), ('ada', 30);`,
  },
];
