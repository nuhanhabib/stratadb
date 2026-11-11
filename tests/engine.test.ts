import { beforeEach, describe, expect, it } from 'vitest';
import { Database, formatPlan, SqlError, type Value } from '../src/engine';

let db: Database;

/** Rows of the last statement, as arrays. */
const rows = (sql: string): Value[][] => {
  const result = db.execute(sql).at(-1)!;
  if (result.type !== 'rows') throw new Error('expected a row-returning statement');
  return result.rows;
};
const scalar = (sql: string): Value => rows(sql)[0][0];
const plan = (sql: string): string => {
  const result = db.execute(sql).at(-1)!;
  if (result.type !== 'rows' || !result.plan) throw new Error('no plan');
  return formatPlan(result.plan, false).join('\n');
};

beforeEach(() => {
  db = new Database();
  db.execute(`
    CREATE TABLE dept (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE emp (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      dept_id INTEGER,
      salary REAL,
      active BOOLEAN DEFAULT TRUE
    );
    INSERT INTO dept VALUES (1, 'Engineering'), (2, 'Sales'), (3, 'Empty');
    INSERT INTO emp (name, dept_id, salary) VALUES
      ('Ada', 1, 120), ('Grace', 1, 150), ('Linus', 1, 100),
      ('Dale', 2, 60), ('Zig', 2, 80), ('Nomad', NULL, 50);
  `);
});

describe('expressions', () => {
  it('evaluates arithmetic and strings', () => {
    expect(rows("SELECT 1 + 2 * 3, (1 + 2) * 3, 7 / 2, 7 % 4, -5 + 2, 'a' || 'b' || 1")).toEqual([
      [7, 9, 3.5, 3, -3, 'ab1'],
    ]);
  });

  it('implements three-valued logic', () => {
    expect(rows('SELECT NULL AND FALSE, NULL AND TRUE, NULL OR TRUE, NULL OR FALSE, NOT NULL')).toEqual([
      [false, null, true, null, null],
    ]);
    expect(rows('SELECT NULL = NULL, 1 + NULL, NULL IS NULL, 1 IS NOT NULL, 1 / 0')).toEqual([
      [null, null, true, true, null],
    ]);
    expect(rows('SELECT 1 IN (1, NULL), 2 IN (1, NULL), 2 NOT IN (1, NULL), 2 NOT IN (1, 3)')).toEqual([
      [true, null, null, true],
    ]);
  });

  it('supports LIKE, BETWEEN, CASE and scalar functions', () => {
    expect(rows("SELECT 'Hello' LIKE 'h%o', 'Hello' LIKE 'h_o', 'a.c' LIKE 'a.c', 'abc' LIKE 'a.c'")).toEqual([
      [true, false, true, false],
    ]);
    expect(rows('SELECT 5 BETWEEN 1 AND 5, 5 NOT BETWEEN 1 AND 4')).toEqual([[true, true]]);
    expect(rows("SELECT CASE WHEN 1 > 2 THEN 'a' WHEN 2 > 1 THEN 'b' ELSE 'c' END, CASE 3 WHEN 3 THEN 'three' END, CASE WHEN FALSE THEN 1 END")).toEqual([
      ['b', 'three', null],
    ]);
    expect(rows("SELECT UPPER('ab'), LENGTH('abc'), ROUND(2.567, 2), ROUND(2.5), ABS(-3), SUBSTR('hello', 2, 3), COALESCE(NULL, NULL, 7), NULLIF(1, 1), UPPER(NULL)")).toEqual([
      ['AB', 3, 2.57, 3, 3, 'ell', 7, null, null],
    ]);
  });

  it('rejects type errors and unknown names', () => {
    expect(() => db.execute("SELECT 1 + 'a'")).toThrow(/cannot be applied to text/);
    expect(() => db.execute('SELECT nope(1)')).toThrow(/function nope\(\) does not exist/);
    expect(() => db.execute('SELECT missing FROM emp')).toThrow('column "missing" does not exist');
    expect(() => db.execute('SELECT * FROM nowhere')).toThrow('table "nowhere" does not exist');
    expect(() => db.execute('SELECT id FROM emp JOIN dept ON emp.dept_id = dept.id')).toThrow(/ambiguous/);
  });
});

describe('SELECT', () => {
  it('filters, sorts and limits', () => {
    expect(rows('SELECT name FROM emp WHERE salary >= 100 ORDER BY salary DESC')).toEqual([
      ['Grace'], ['Ada'], ['Linus'],
    ]);
    expect(rows('SELECT name FROM emp ORDER BY name LIMIT 2 OFFSET 1')).toEqual([['Dale'], ['Grace']]);
    expect(rows('SELECT name FROM emp ORDER BY dept_id, salary DESC LIMIT 3')).toEqual([
      ['Nomad'], ['Grace'], ['Ada'], // NULL sorts first
    ]);
    expect(rows('SELECT name FROM emp LIMIT 0')).toEqual([]);
  });

  it('expands stars and names output columns', () => {
    const result = db.execute('SELECT d.*, e.name AS employee, salary * 2 FROM dept d JOIN emp e ON e.dept_id = d.id LIMIT 1')[0];
    expect(result.type === 'rows' && result.columns).toEqual(['id', 'name', 'employee', 'salary * 2']);
    expect(db.query('SELECT * FROM dept WHERE id = 2')).toEqual([{ id: 2, name: 'Sales' }]);
  });

  it('orders by alias, position and expression', () => {
    expect(rows('SELECT name, salary * 2 AS double FROM emp ORDER BY double LIMIT 1')).toEqual([['Nomad', 100]]);
    expect(rows('SELECT name, salary FROM emp ORDER BY 2 DESC LIMIT 1')).toEqual([['Grace', 150]]);
    expect(rows('SELECT name FROM emp ORDER BY LENGTH(name) DESC, name LIMIT 2')).toEqual([['Grace'], ['Linus']]);
  });

  it('removes duplicates with DISTINCT', () => {
    expect(rows('SELECT DISTINCT dept_id FROM emp ORDER BY dept_id')).toEqual([[null], [1], [2]]);
  });

  it('supports uncorrelated subqueries', () => {
    expect(rows('SELECT name FROM emp WHERE salary = (SELECT MAX(salary) FROM emp)')).toEqual([['Grace']]);
    expect(
      rows("SELECT name FROM emp WHERE dept_id IN (SELECT id FROM dept WHERE name = 'Sales') ORDER BY name"),
    ).toEqual([['Dale'], ['Zig']]);
    expect(() => db.execute('SELECT (SELECT id FROM emp)')).toThrow(/more than one row/);
  });
});

describe('joins', () => {
  it('inner joins drop unmatched rows on both sides', () => {
    expect(
      rows('SELECT e.name, d.name FROM emp e JOIN dept d ON e.dept_id = d.id ORDER BY e.name'),
    ).toEqual([
      ['Ada', 'Engineering'], ['Dale', 'Sales'], ['Grace', 'Engineering'],
      ['Linus', 'Engineering'], ['Zig', 'Sales'],
    ]);
  });

  it('left joins keep unmatched left rows', () => {
    expect(
      rows('SELECT d.name, e.name FROM dept d LEFT JOIN emp e ON e.dept_id = d.id AND e.salary > 100 ORDER BY d.name, e.name'),
    ).toEqual([['Empty', null], ['Engineering', 'Ada'], ['Engineering', 'Grace'], ['Sales', null]]);
  });

  it('applies WHERE on the nullable side after a left join', () => {
    // Pushing `e.id IS NULL` below the join would be wrong: it must see NULL-extended rows.
    expect(rows('SELECT d.name FROM dept d LEFT JOIN emp e ON e.dept_id = d.id WHERE e.id IS NULL')).toEqual([
      ['Empty'],
    ]);
    expect(
      rows('SELECT d.name, e.name FROM dept d LEFT JOIN emp e ON e.dept_id = d.id WHERE e.salary > 120'),
    ).toEqual([['Engineering', 'Grace']]);
  });

  it('cross joins and comma joins', () => {
    expect(scalar('SELECT COUNT(*) FROM dept CROSS JOIN emp')).toBe(18);
    expect(scalar('SELECT COUNT(*) FROM dept d, emp e WHERE e.dept_id = d.id')).toBe(5);
  });

  it('joins on non-equality conditions and self joins', () => {
    expect(
      rows('SELECT a.name, b.name FROM emp a JOIN emp b ON a.dept_id = b.dept_id AND a.salary < b.salary WHERE a.dept_id = 2'),
    ).toEqual([['Dale', 'Zig']]);
    expect(scalar('SELECT COUNT(*) FROM emp a JOIN emp b ON a.salary < b.salary')).toBe(15);
  });

  it('joins three tables', () => {
    db.execute(`CREATE TABLE badge (emp_id INTEGER, label TEXT);
                INSERT INTO badge VALUES (1, 'founder'), (2, 'admiral'), (2, 'compiler')`);
    expect(
      rows(`SELECT d.name, e.name, b.label FROM dept d
            JOIN emp e ON e.dept_id = d.id
            JOIN badge b ON b.emp_id = e.id ORDER BY b.label`),
    ).toEqual([
      ['Engineering', 'Grace', 'admiral'],
      ['Engineering', 'Grace', 'compiler'],
      ['Engineering', 'Ada', 'founder'],
    ]);
  });
});

describe('aggregation', () => {
  it('computes aggregates over the whole table', () => {
    expect(rows('SELECT COUNT(*), COUNT(dept_id), SUM(salary), MIN(salary), MAX(name), AVG(salary) FROM emp')).toEqual([
      [6, 5, 560, 50, 'Zig', 560 / 6],
    ]);
    expect(rows('SELECT COUNT(DISTINCT dept_id) FROM emp')).toEqual([[2]]);
  });

  it('returns one row for an aggregate over no rows', () => {
    expect(rows('SELECT COUNT(*), SUM(salary), MAX(salary) FROM emp WHERE salary > 1000')).toEqual([[0, null, null]]);
    expect(rows('SELECT dept_id, COUNT(*) FROM emp WHERE salary > 1000 GROUP BY dept_id')).toEqual([]);
  });

  it('groups, filters groups and sorts by aggregates', () => {
    expect(
      rows(`SELECT d.name, COUNT(*) AS n, SUM(e.salary) AS total
            FROM emp e JOIN dept d ON d.id = e.dept_id
            GROUP BY d.name ORDER BY total DESC`),
    ).toEqual([['Engineering', 3, 370], ['Sales', 2, 140]]);
    expect(rows('SELECT dept_id FROM emp GROUP BY dept_id HAVING COUNT(*) > 2')).toEqual([[1]]);
    expect(rows('SELECT dept_id FROM emp GROUP BY dept_id ORDER BY AVG(salary) LIMIT 1')).toEqual([[null]]);
  });

  it('groups by expressions, aliases and positions', () => {
    expect(rows('SELECT salary >= 100 AS senior, COUNT(*) FROM emp GROUP BY senior ORDER BY 1')).toEqual([
      [false, 3], [true, 3],
    ]);
    expect(rows('SELECT dept_id * 10, COUNT(*) + 1 FROM emp WHERE dept_id IS NOT NULL GROUP BY dept_id * 10 ORDER BY 1')).toEqual([
      [10, 4], [20, 3],
    ]);
    expect(rows('SELECT UPPER(name) FROM dept GROUP BY 1 ORDER BY 1 LIMIT 1')).toEqual([['EMPTY']]);
  });

  it('rejects invalid aggregate usage', () => {
    expect(() => db.execute('SELECT name, COUNT(*) FROM emp')).toThrow(/must appear in the GROUP BY clause/);
    expect(() => db.execute('SELECT * FROM emp WHERE COUNT(*) > 1')).toThrow(/not allowed here/);
    expect(() => db.execute('SELECT SUM(COUNT(*)) FROM emp')).toThrow(/cannot be nested/);
    expect(() => db.execute('SELECT name FROM emp HAVING salary > 1')).toThrow(/HAVING requires/);
  });
});

describe('data modification', () => {
  it('auto-increments integer primary keys', () => {
    db.execute("INSERT INTO emp (name) VALUES ('New')");
    expect(rows("SELECT id, active, salary FROM emp WHERE name = 'New'")).toEqual([[7, true, null]]);
    db.execute("INSERT INTO emp (id, name) VALUES (50, 'Jump'); INSERT INTO emp (name) VALUES ('After')");
    expect(scalar("SELECT id FROM emp WHERE name = 'After'")).toBe(51);
  });

  it('updates and deletes', () => {
    const [u] = db.execute('UPDATE emp SET salary = salary * 2, active = FALSE WHERE dept_id = 2');
    expect(u.type === 'ok' && u.rowsAffected).toBe(2);
    expect(rows('SELECT name, salary, active FROM emp WHERE dept_id = 2 ORDER BY id')).toEqual([
      ['Dale', 120, false], ['Zig', 160, false],
    ]);
    const [d] = db.execute('DELETE FROM emp WHERE salary < 110');
    expect(d.type === 'ok' && d.rowsAffected).toBe(2);
    expect(scalar('SELECT COUNT(*) FROM emp')).toBe(4);
  });

  it('enforces constraints', () => {
    expect(() => db.execute("INSERT INTO dept VALUES (1, 'Dup')")).toThrow(/unique constraint "dept_pkey"/);
    expect(() => db.execute("INSERT INTO dept VALUES (9, 'Sales')")).toThrow(/unique constraint "dept_name_key"/);
    expect(() => db.execute('INSERT INTO emp (name) VALUES (NULL)')).toThrow(/NOT NULL/);
    expect(() => db.execute("INSERT INTO emp (name, salary) VALUES ('x', 'lots')")).toThrow(/is REAL but/);
    expect(() => db.execute("INSERT INTO emp (name, dept_id) VALUES ('x', 1.5)")).toThrow(/is INTEGER but/);
    expect(() => db.execute('UPDATE dept SET id = 2 WHERE id = 1')).toThrow(/unique constraint/);
    expect(() => db.execute("INSERT INTO dept VALUES (1)")).toThrow(/1 values but 2 target columns/);
    db.execute('UPDATE dept SET id = id WHERE id = 1'); // a row never conflicts with itself
  });

  it('makes each statement atomic', () => {
    expect(() => db.execute("INSERT INTO dept VALUES (10, 'A'), (11, 'B'), (1, 'Dup')")).toThrow();
    expect(scalar('SELECT COUNT(*) FROM dept')).toBe(3);
    // Shifting every id by one collides part-way through; nothing may change.
    expect(() => db.execute('UPDATE dept SET id = id + 1')).toThrow();
    expect(rows('SELECT id FROM dept ORDER BY id')).toEqual([[1], [2], [3]]);
    expect(rows('SELECT name FROM dept WHERE id = 2')).toEqual([['Sales']]);
  });
});

describe('transactions', () => {
  it('rolls back data and schema changes', () => {
    db.execute(`
      BEGIN;
      DELETE FROM emp WHERE dept_id = 1;
      UPDATE emp SET name = 'changed', salary = 1;
      INSERT INTO dept VALUES (4, 'Temp');
      CREATE TABLE scratch (x INTEGER);
      CREATE INDEX emp_salary ON emp (salary);
      DROP TABLE dept;
    `);
    expect(db.inTransaction).toBe(true);
    expect(scalar('SELECT COUNT(*) FROM emp')).toBe(3);
    db.execute('ROLLBACK');
    expect(db.inTransaction).toBe(false);
    expect(scalar('SELECT COUNT(*) FROM emp')).toBe(6);
    expect(scalar('SELECT COUNT(*) FROM dept')).toBe(3);
    expect(rows('SELECT name, salary FROM emp WHERE id = 5')).toEqual([['Zig', 80]]);
    expect(rows("SELECT id FROM emp WHERE name = 'Ada'")).toEqual([[1]]);
    expect(() => db.execute('SELECT * FROM scratch')).toThrow(/does not exist/);
    expect(db.schema().find((t) => t.name === 'emp')!.indexes.map((i) => i.name)).toEqual(['emp_pkey']);
  });

  it('keeps indexes consistent after a rollback', () => {
    db.execute('CREATE INDEX emp_dept ON emp (dept_id)');
    db.execute('BEGIN; UPDATE emp SET dept_id = 3 WHERE dept_id = 1; DELETE FROM emp WHERE id = 4; ROLLBACK');
    expect(plan('SELECT name FROM emp WHERE dept_id = 1')).toContain('Index Scan');
    expect(rows('SELECT name FROM emp WHERE dept_id = 1 ORDER BY name')).toEqual([['Ada'], ['Grace'], ['Linus']]);
    expect(rows('SELECT name FROM emp WHERE dept_id = 3')).toEqual([]);
    expect(rows('SELECT name FROM emp WHERE id = 4')).toEqual([['Dale']]);
  });

  it('commits', () => {
    db.execute('BEGIN; DELETE FROM emp; COMMIT');
    expect(scalar('SELECT COUNT(*) FROM emp')).toBe(0);
    expect(() => db.execute('ROLLBACK')).toThrow(/no transaction/);
    expect(() => db.execute('BEGIN; BEGIN')).toThrow(/already in progress/);
  });

  it('a failed statement inside a transaction undoes only itself', () => {
    db.execute("BEGIN; INSERT INTO dept VALUES (4, 'Kept')");
    expect(() => db.execute("INSERT INTO dept VALUES (5, 'Lost'), (4, 'Dup')")).toThrow(SqlError);
    db.execute('COMMIT');
    expect(rows('SELECT name FROM dept WHERE id >= 4')).toEqual([['Kept']]);
  });
});

describe('query planner', () => {
  beforeEach(() => {
    db.execute('CREATE TABLE big (id INTEGER PRIMARY KEY, grp INTEGER, val REAL, tag TEXT)');
    const values: string[] = [];
    for (let i = 1; i <= 2000; i++) values.push(`(${i}, ${i % 50}, ${i / 4}, 'tag${i % 7}')`);
    db.execute(`INSERT INTO big VALUES ${values.join(',')}`);
    db.execute('CREATE INDEX big_grp ON big (grp)');
  });

  it('uses the primary key index for point lookups', () => {
    const p = plan('SELECT * FROM big WHERE id = 1234');
    expect(p).toBe('Index Scan on big using big_pkey (id = 1234)');
    expect(rows('SELECT grp FROM big WHERE 1234 = id')).toEqual([[34]]);
  });

  it('uses a secondary index and keeps other predicates as a filter', () => {
    const p = plan("SELECT id FROM big WHERE grp = 7 AND tag = 'tag0'");
    expect(p).toContain('Index Scan on big using big_grp (grp = 7)');
    expect(p).toContain("Filter tag = 'tag0'");
    const expected = [];
    for (let i = 1; i <= 2000; i++) if (i % 50 === 7 && i % 7 === 0) expected.push([i]);
    expect(rows("SELECT id FROM big WHERE grp = 7 AND tag = 'tag0' ORDER BY id")).toEqual(expected);
  });

  it('turns range predicates into an index range scan', () => {
    expect(plan('SELECT * FROM big WHERE id > 10 AND id <= 20 AND id >= 5')).toBe(
      'Index Scan on big using big_pkey (id > 10 AND id <= 20)',
    );
    expect(rows('SELECT id FROM big WHERE id > 10 AND id <= 14')).toEqual([[11], [12], [13], [14]]);
    expect(rows('SELECT COUNT(*) FROM big WHERE id BETWEEN 100 AND 199')).toEqual([[100]]);
    expect(rows('SELECT COUNT(*) FROM big WHERE id < 3')).toEqual([[2]]);
    expect(rows('SELECT COUNT(*) FROM big WHERE id >= 1999')).toEqual([[2]]);
    expect(rows('SELECT COUNT(*) FROM big WHERE id > 20 AND id < 10')).toEqual([[0]]);
  });

  it('falls back to a sequential scan when no index applies', () => {
    expect(plan('SELECT * FROM big WHERE val > 100')).toContain('Seq Scan on big');
    expect(plan('SELECT * FROM big WHERE grp + 1 = 8')).toContain('Seq Scan on big');
    expect(plan('SELECT * FROM big WHERE grp = 1 OR grp = 2')).toContain('Seq Scan on big');
  });

  it('index scans and sequential scans return identical results', () => {
    const queries = [
      'SELECT id FROM big WHERE grp = 13 ORDER BY id',
      'SELECT id FROM big WHERE grp >= 48 AND val < 100 ORDER BY id',
      'SELECT COUNT(*), SUM(val) FROM big WHERE grp < 3',
      'SELECT COUNT(*) FROM big WHERE grp = NULL',
    ];
    const withIndex = queries.map(rows);
    db.execute('DROP INDEX big_grp');
    expect(queries.map(rows)).toEqual(withIndex);
  });

  it('pushes predicates below joins and picks hash joins for equalities', () => {
    const p = plan(`SELECT e.name FROM emp e JOIN dept d ON e.dept_id = d.id WHERE d.id = 1 AND e.salary > 100`);
    expect(p.split('\n')).toEqual([
      'Project name',
      '└─ Hash Join on e.dept_id = d.id',
      '   ├─ Filter e.salary > 100',
      '   │  └─ Seq Scan on emp AS e',
      '   └─ Index Scan on dept AS d using dept_pkey (id = 1)',
    ]);
    expect(plan('SELECT * FROM emp a JOIN emp b ON a.salary < b.salary')).toContain('Nested Loop Join');
  });

  it('uses indexes for UPDATE and DELETE and keeps them maintained', () => {
    db.execute('UPDATE big SET grp = 999 WHERE id = 10');
    expect(rows('SELECT id FROM big WHERE grp = 999')).toEqual([[10]]);
    expect(scalar('SELECT COUNT(*) FROM big WHERE grp = 10')).toBe(39);
    db.execute('DELETE FROM big WHERE grp = 999');
    expect(rows('SELECT id FROM big WHERE grp = 999')).toEqual([]);
    expect(rows('SELECT id FROM big WHERE id = 10')).toEqual([]);
  });

  it('LIMIT stops the scan early', () => {
    const result = db.execute('SELECT * FROM big LIMIT 5')[0];
    if (result.type !== 'rows' || !result.plan) throw new Error('no plan');
    expect(result.plan.name).toBe('Limit');
    expect(result.plan.children[0].rows).toBe(5); // the scan produced 5 rows, not 2000
  });

  it('EXPLAIN describes the plan without running it; EXPLAIN ANALYZE runs it', () => {
    expect(rows('EXPLAIN SELECT * FROM big WHERE id = 5')).toEqual([
      ['Index Scan on big using big_pkey (id = 5)'],
    ]);
    expect(scalar('EXPLAIN ANALYZE SELECT * FROM big WHERE grp = 5')).toMatch(
      /^Index Scan on big using big_grp \(grp = 5\) {2}\(rows=40, time=[\d.]+ms\)$/,
    );
  });

  it('enforces unique indexes created after the fact', () => {
    expect(() => db.execute('CREATE UNIQUE INDEX u ON big (grp)')).toThrow(/duplicate value/);
    db.execute('CREATE UNIQUE INDEX u ON big (val)');
    expect(() => db.execute('UPDATE big SET val = 1 WHERE id = 2')).toThrow(/unique constraint "u"/);
    expect(() => db.execute('CREATE INDEX u ON big (tag)')).toThrow(/already exists/);
  });
});
