import { describe, expect, it } from 'vitest';
import { exprToString, type SelectStmt } from '../src/engine/ast';
import { tokenize } from '../src/engine/lexer';
import { parse } from '../src/engine/parser';
import { SqlError } from '../src/engine/values';

const select = (sql: string) => parse(sql)[0] as SelectStmt;
const expr = (sql: string) => exprToString(select(`SELECT ${sql}`).items[0].expr!);

describe('lexer', () => {
  it('classifies tokens', () => {
    const types = tokenize("SELECT a, 'it''s' FROM t -- comment\nWHERE x >= 1.5").map((t) => t.type);
    expect(types).toEqual([
      'keyword', 'ident', 'punct', 'string', 'keyword', 'ident', 'keyword', 'ident', 'op', 'number', 'eof',
    ]);
  });

  it('unescapes strings and normalises case', () => {
    const tokens = tokenize(`select Name, "Mixed Case", 'it''s'`);
    expect(tokens.map((t) => t.value)).toEqual(['SELECT', 'name', ',', 'Mixed Case', ',', "it's", '']);
  });

  it('reports the position of bad input', () => {
    expect(() => tokenize("SELECT 'oops")).toThrow(/unterminated string/);
    expect(() => tokenize('SELECT #')).toThrow(SqlError);
  });

  it('covers every character in trivia mode and never throws', () => {
    const sql = "SELECT 'unterminated -- x\n # ";
    const tokens = tokenize(sql, true);
    expect(tokens.map((t) => sql.slice(t.pos, t.end)).join('')).toBe(sql);
  });
});

describe('parser', () => {
  it('respects operator precedence', () => {
    expect(expr('1 + 2 * 3')).toBe('1 + 2 * 3');
    expect(expr('(1 + 2) * 3')).toBe('(1 + 2) * 3');
    expect(expr('a OR b AND c')).toBe('a OR b AND c');
    expect(expr('(a OR b) AND c')).toBe('(a OR b) AND c');
    expect(expr('NOT a = 1 AND b')).toBe('NOT a = 1 AND b');
    expect(expr('10 - 4 - 3')).toBe('10 - 4 - 3');
    expect(expr('10 - (4 - 3)')).toBe('10 - (4 - 3)');
    expect(expr('a + 1 BETWEEN 2 AND 3 AND c')).toBe('a + 1 BETWEEN 2 AND 3 AND c');
  });

  it('parses predicates', () => {
    expect(expr("x NOT IN (1, 2) OR y IS NOT NULL OR z NOT LIKE 'a%'")).toBe(
      "x NOT IN (1, 2) OR y IS NOT NULL OR NOT z LIKE 'a%'",
    );
    expect(expr("CASE WHEN a > 1 THEN 'big' ELSE 'small' END")).toBe(
      "CASE WHEN a > 1 THEN 'big' ELSE 'small' END",
    );
    expect(expr('count(DISTINCT x)')).toBe('count(DISTINCT x)');
  });

  it('parses a full SELECT', () => {
    const s = select(`
      SELECT c.name, COUNT(*) AS n
      FROM customers c
      LEFT JOIN orders AS o ON o.customer_id = c.id
      WHERE c.country = 'NZ'
      GROUP BY c.name HAVING COUNT(*) > 1
      ORDER BY n DESC, c.name
      LIMIT 10 OFFSET 5`);
    expect(s.from).toEqual({ name: 'customers', alias: 'c' });
    expect(s.joins[0].type).toBe('left');
    expect(s.joins[0].table).toEqual({ name: 'orders', alias: 'o' });
    expect(s.items[1].alias).toBe('n');
    expect(s.groupBy).toHaveLength(1);
    expect(s.orderBy.map((o) => o.desc)).toEqual([true, false]);
    expect(s.limit).toEqual({ kind: 'literal', value: 10 });
    expect(s.offset).toEqual({ kind: 'literal', value: 5 });
  });

  it('parses multiple statements and keeps their source text', () => {
    const stmts = parse('BEGIN; DELETE FROM t WHERE id = 1;; COMMIT');
    expect(stmts.map((s) => s.kind)).toEqual(['begin', 'delete', 'commit']);
    expect(stmts[1].source).toBe('DELETE FROM t WHERE id = 1');
  });

  it('parses DDL', () => {
    const [t, i] = parse(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, active BOOLEAN DEFAULT TRUE
      );
      CREATE UNIQUE INDEX idx ON users (email);`);
    expect(t).toMatchObject({ kind: 'createTable', name: 'users', ifNotExists: true });
    expect(i).toMatchObject({ kind: 'createIndex', unique: true, table: 'users', column: 'email' });
  });

  it('produces helpful syntax errors', () => {
    expect(() => parse('SELECT FROM t')).toThrow("expected an expression but found 'FROM'");
    expect(() => parse('SELECT * FROM')).toThrow('expected table name but found end of input');
    expect(() => parse('SELECT 1 SELECT 2')).toThrow("expected ';' or end of input");
    expect(() => parse('CREATE TABLE t (a BLOB)')).toThrow(/column type/);
    try {
      parse('SELECT a,\n  FROM t');
      expect.unreachable();
    } catch (e) {
      expect((e as SqlError).position).toBe(12);
    }
  });
});
