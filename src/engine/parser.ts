import type {
  BinaryOp, ColumnSpec, Expr, JoinClause, OrderItem, SelectItem, SelectStmt, Statement, TableRef,
} from './ast';
import { tokenize, type Token } from './lexer';
import { SqlError, type ColumnType } from './values';

const TYPE_NAMES: Record<string, ColumnType> = {
  integer: 'INTEGER', int: 'INTEGER', bigint: 'INTEGER', smallint: 'INTEGER',
  real: 'REAL', float: 'REAL', double: 'REAL', numeric: 'REAL', decimal: 'REAL',
  text: 'TEXT', varchar: 'TEXT', char: 'TEXT', string: 'TEXT',
  boolean: 'BOOLEAN', bool: 'BOOLEAN',
};

const COMPARISON_OPS = new Set(['=', '<>', '<', '<=', '>', '>=']);

/**
 * Hand-written recursive-descent parser. Expressions use precedence climbing:
 *   OR < AND < NOT < comparison (= <> < > IN BETWEEN LIKE IS) < || < + - < * / % < unary minus
 */
class Parser {
  private i = 0;
  private readonly tokens: Token[];

  constructor(private readonly sql: string) {
    this.tokens = tokenize(sql);
  }

  // ---- token helpers -------------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    const t = this.peek();
    if (this.i < this.tokens.length - 1) this.i++;
    return t;
  }

  private fail(expected: string): never {
    const t = this.peek();
    const found = t.type === 'eof' ? 'end of input' : `'${this.sql.slice(t.pos, t.end)}'`;
    throw new SqlError(`syntax error: expected ${expected} but found ${found}`, t.pos);
  }

  private isKw(kw: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === 'keyword' && t.value === kw;
  }

  private acceptKw(kw: string): boolean {
    if (this.isKw(kw)) {
      this.next();
      return true;
    }
    return false;
  }

  private expectKw(kw: string): void {
    if (!this.acceptKw(kw)) this.fail(kw);
  }

  private is(type: 'punct' | 'op', value: string): boolean {
    const t = this.peek();
    return t.type === type && t.value === value;
  }

  private accept(type: 'punct' | 'op', value: string): boolean {
    if (this.is(type, value)) {
      this.next();
      return true;
    }
    return false;
  }

  private expect(type: 'punct' | 'op', value: string): void {
    if (!this.accept(type, value)) this.fail(`'${value}'`);
  }

  private ident(what = 'identifier'): string {
    if (this.peek().type !== 'ident') this.fail(what);
    return this.next().value;
  }

  // ---- statements ----------------------------------------------------------

  parseScript(): Statement[] {
    const statements: Statement[] = [];
    for (;;) {
      while (this.accept('punct', ';')) {
        /* skip empty statements */
      }
      if (this.peek().type === 'eof') break;
      const start = this.peek().pos;
      const stmt = this.statement();
      const end = this.tokens[this.i - 1].end;
      stmt.source = this.sql.slice(start, end);
      statements.push(stmt);
      if (this.peek().type !== 'eof' && !this.is('punct', ';')) this.fail("';' or end of input");
    }
    return statements;
  }

  private statement(): Statement {
    const t = this.peek();
    if (t.type !== 'keyword') this.fail('a SQL statement');
    switch (t.value) {
      case 'SELECT':
        return this.select();
      case 'INSERT':
        return this.insert();
      case 'UPDATE':
        return this.update();
      case 'DELETE':
        return this.delete();
      case 'CREATE':
        return this.create();
      case 'DROP':
        return this.drop();
      case 'EXPLAIN': {
        this.next();
        const analyze = this.acceptKw('ANALYZE');
        if (!this.isKw('SELECT')) this.fail('SELECT after EXPLAIN');
        return { kind: 'explain', analyze, select: this.select() };
      }
      case 'BEGIN':
        this.next();
        this.acceptKw('TRANSACTION');
        return { kind: 'begin' };
      case 'COMMIT':
        this.next();
        this.acceptKw('TRANSACTION');
        return { kind: 'commit' };
      case 'ROLLBACK':
        this.next();
        this.acceptKw('TRANSACTION');
        return { kind: 'rollback' };
      default:
        return this.fail('a SQL statement');
    }
  }

  private select(): SelectStmt {
    this.expectKw('SELECT');
    const distinct = this.acceptKw('DISTINCT');
    const items: SelectItem[] = [];
    do {
      items.push(this.selectItem());
    } while (this.accept('punct', ','));

    const stmt: SelectStmt = { kind: 'select', distinct, items, joins: [], groupBy: [], orderBy: [] };

    if (this.acceptKw('FROM')) {
      stmt.from = this.tableRef();
      for (;;) {
        const join = this.join();
        if (!join) break;
        stmt.joins.push(join);
      }
    }
    if (this.acceptKw('WHERE')) stmt.where = this.expr();
    if (this.acceptKw('GROUP')) {
      this.expectKw('BY');
      do {
        stmt.groupBy.push(this.expr());
      } while (this.accept('punct', ','));
    }
    if (this.acceptKw('HAVING')) stmt.having = this.expr();
    if (this.acceptKw('ORDER')) {
      this.expectKw('BY');
      do {
        const expr = this.expr();
        let desc = false;
        if (this.acceptKw('DESC')) desc = true;
        else this.acceptKw('ASC');
        stmt.orderBy.push({ expr, desc } satisfies OrderItem);
      } while (this.accept('punct', ','));
    }
    if (this.acceptKw('LIMIT')) {
      stmt.limit = this.expr();
      if (this.acceptKw('OFFSET')) stmt.offset = this.expr();
    }
    return stmt;
  }

  private selectItem(): SelectItem {
    if (this.accept('op', '*')) return {};
    // table.*
    if (
      this.peek().type === 'ident' &&
      this.peek(1).value === '.' && this.peek(1).type === 'punct' &&
      this.peek(2).value === '*' && this.peek(2).type === 'op'
    ) {
      const starTable = this.next().value;
      this.next();
      this.next();
      return { starTable };
    }
    const expr = this.expr();
    let alias: string | undefined;
    if (this.acceptKw('AS')) {
      alias = this.peek().type === 'string' ? this.next().value : this.ident('column alias');
    } else if (this.peek().type === 'ident') {
      alias = this.next().value;
    }
    return { expr, alias };
  }

  private tableRef(): TableRef {
    const name = this.ident('table name');
    let alias = name;
    if (this.acceptKw('AS')) alias = this.ident('table alias');
    else if (this.peek().type === 'ident') alias = this.next().value;
    return { name, alias };
  }

  private join(): JoinClause | null {
    if (this.accept('punct', ',')) return { type: 'cross', table: this.tableRef() };
    let type: JoinClause['type'];
    if (this.acceptKw('JOIN')) type = 'inner';
    else if (this.isKw('INNER')) {
      this.next();
      this.expectKw('JOIN');
      type = 'inner';
    } else if (this.isKw('LEFT')) {
      this.next();
      this.acceptKw('OUTER');
      this.expectKw('JOIN');
      type = 'left';
    } else if (this.isKw('CROSS')) {
      this.next();
      this.expectKw('JOIN');
      type = 'cross';
    } else return null;

    const table = this.tableRef();
    if (type === 'cross') return { type, table };
    this.expectKw('ON');
    return { type, table, on: this.expr() };
  }

  private insert(): Statement {
    this.expectKw('INSERT');
    this.expectKw('INTO');
    const table = this.ident('table name');
    let columns: string[] | undefined;
    if (this.accept('punct', '(')) {
      columns = [];
      do {
        columns.push(this.ident('column name'));
      } while (this.accept('punct', ','));
      this.expect('punct', ')');
    }
    this.expectKw('VALUES');
    const rows: Expr[][] = [];
    do {
      this.expect('punct', '(');
      const row: Expr[] = [];
      do {
        row.push(this.expr());
      } while (this.accept('punct', ','));
      this.expect('punct', ')');
      rows.push(row);
    } while (this.accept('punct', ','));
    return { kind: 'insert', table, columns, rows };
  }

  private update(): Statement {
    this.expectKw('UPDATE');
    const table = this.ident('table name');
    this.expectKw('SET');
    const set: { column: string; expr: Expr }[] = [];
    do {
      const column = this.ident('column name');
      this.expect('op', '=');
      set.push({ column, expr: this.expr() });
    } while (this.accept('punct', ','));
    const where = this.acceptKw('WHERE') ? this.expr() : undefined;
    return { kind: 'update', table, set, where };
  }

  private delete(): Statement {
    this.expectKw('DELETE');
    this.expectKw('FROM');
    const table = this.ident('table name');
    const where = this.acceptKw('WHERE') ? this.expr() : undefined;
    return { kind: 'delete', table, where };
  }

  private create(): Statement {
    this.expectKw('CREATE');
    if (this.acceptKw('TABLE')) {
      let ifNotExists = false;
      if (this.acceptKw('IF')) {
        this.expectKw('NOT');
        this.expectKw('EXISTS');
        ifNotExists = true;
      }
      const name = this.ident('table name');
      this.expect('punct', '(');
      const columns: ColumnSpec[] = [];
      do {
        columns.push(this.columnSpec());
      } while (this.accept('punct', ','));
      this.expect('punct', ')');
      return { kind: 'createTable', name, columns, ifNotExists };
    }
    const unique = this.acceptKw('UNIQUE');
    if (!this.acceptKw('INDEX')) this.fail(unique ? 'INDEX' : 'TABLE or INDEX');
    const name = this.ident('index name');
    this.expectKw('ON');
    const table = this.ident('table name');
    this.expect('punct', '(');
    const column = this.ident('column name');
    this.expect('punct', ')');
    return { kind: 'createIndex', name, table, column, unique };
  }

  private columnSpec(): ColumnSpec {
    const name = this.ident('column name');
    const typeTok = this.peek();
    const type = typeTok.type === 'ident' ? TYPE_NAMES[typeTok.value] : undefined;
    if (!type) this.fail('a column type (INTEGER, REAL, TEXT or BOOLEAN)');
    this.next();
    if (this.accept('punct', '(')) {
      // Length / precision arguments such as VARCHAR(255) are accepted and ignored.
      do {
        if (this.peek().type !== 'number') this.fail('a number');
        this.next();
      } while (this.accept('punct', ','));
      this.expect('punct', ')');
    }
    const spec: ColumnSpec = { name, type, notNull: false, primaryKey: false, unique: false };
    for (;;) {
      if (this.acceptKw('PRIMARY')) {
        this.expectKw('KEY');
        spec.primaryKey = true;
      } else if (this.acceptKw('NOT')) {
        this.expectKw('NULL');
        spec.notNull = true;
      } else if (this.acceptKw('UNIQUE')) {
        spec.unique = true;
      } else if (this.acceptKw('DEFAULT')) {
        spec.default = this.prefix();
      } else break;
    }
    return spec;
  }

  private drop(): Statement {
    this.expectKw('DROP');
    const isTable = this.acceptKw('TABLE');
    if (!isTable && !this.acceptKw('INDEX')) this.fail('TABLE or INDEX');
    let ifExists = false;
    if (this.acceptKw('IF')) {
      this.expectKw('EXISTS');
      ifExists = true;
    }
    const name = this.ident(isTable ? 'table name' : 'index name');
    return { kind: isTable ? 'dropTable' : 'dropIndex', name, ifExists };
  }

  // ---- expressions ---------------------------------------------------------

  expr(minPrec = 1): Expr {
    let left = this.prefix();
    for (;;) {
      const t = this.peek();

      if (t.type === 'keyword' && t.value === 'OR' && minPrec <= 1) {
        this.next();
        left = { kind: 'binary', op: 'OR', left, right: this.expr(2) };
        continue;
      }
      if (t.type === 'keyword' && t.value === 'AND' && minPrec <= 2) {
        this.next();
        left = { kind: 'binary', op: 'AND', left, right: this.expr(3) };
        continue;
      }

      if (minPrec <= 4) {
        if (t.type === 'op' && COMPARISON_OPS.has(t.value)) {
          this.next();
          left = { kind: 'binary', op: t.value as BinaryOp, left, right: this.expr(5) };
          continue;
        }
        if (t.type === 'keyword' && t.value === 'IS') {
          this.next();
          const negated = this.acceptKw('NOT');
          this.expectKw('NULL');
          left = { kind: 'isnull', expr: left, negated };
          continue;
        }
        const negated =
          this.isKw('NOT') && (this.isKw('IN', 1) || this.isKw('BETWEEN', 1) || this.isKw('LIKE', 1));
        const kw = this.peek(negated ? 1 : 0);
        if (kw.type === 'keyword' && (kw.value === 'IN' || kw.value === 'BETWEEN' || kw.value === 'LIKE')) {
          if (negated) this.next();
          this.next();
          if (kw.value === 'IN') {
            this.expect('punct', '(');
            if (this.isKw('SELECT')) {
              left = { kind: 'in', expr: left, subquery: this.select(), negated };
            } else {
              const list: Expr[] = [];
              do {
                list.push(this.expr());
              } while (this.accept('punct', ','));
              left = { kind: 'in', expr: left, list, negated };
            }
            this.expect('punct', ')');
          } else if (kw.value === 'BETWEEN') {
            const low = this.expr(5);
            this.expectKw('AND');
            const high = this.expr(5);
            left = { kind: 'between', expr: left, low, high, negated };
          } else {
            const like: Expr = { kind: 'binary', op: 'LIKE', left, right: this.expr(5) };
            left = negated ? { kind: 'unary', op: 'NOT', expr: like } : like;
          }
          continue;
        }
      }

      if (t.type === 'op') {
        const prec = t.value === '||' ? 5 : t.value === '+' || t.value === '-' ? 6 : 7;
        const known = ['||', '+', '-', '*', '/', '%'].includes(t.value);
        if (known && minPrec <= prec) {
          this.next();
          left = { kind: 'binary', op: t.value as BinaryOp, left, right: this.expr(prec + 1) };
          continue;
        }
      }
      return left;
    }
  }

  private prefix(): Expr {
    const t = this.peek();
    switch (t.type) {
      case 'number':
        this.next();
        return { kind: 'literal', value: Number(t.value) };
      case 'string':
        this.next();
        return { kind: 'literal', value: t.value };
      case 'op':
        if (t.value === '-') {
          this.next();
          const operand = this.expr(8);
          if (operand.kind === 'literal' && typeof operand.value === 'number') {
            return { kind: 'literal', value: -operand.value };
          }
          return { kind: 'unary', op: '-', expr: operand };
        }
        if (t.value === '+') {
          this.next();
          return this.expr(8);
        }
        break;
      case 'punct':
        if (t.value === '(') {
          this.next();
          let inner: Expr;
          if (this.isKw('SELECT')) inner = { kind: 'subquery', select: this.select() };
          else inner = this.expr();
          this.expect('punct', ')');
          return inner;
        }
        break;
      case 'keyword':
        switch (t.value) {
          case 'TRUE':
            this.next();
            return { kind: 'literal', value: true };
          case 'FALSE':
            this.next();
            return { kind: 'literal', value: false };
          case 'NULL':
            this.next();
            return { kind: 'literal', value: null };
          case 'NOT':
            this.next();
            return { kind: 'unary', op: 'NOT', expr: this.expr(3) };
          case 'CASE':
            return this.caseExpr();
        }
        break;
      case 'ident': {
        this.next();
        if (this.accept('punct', '(')) return this.call(t.value);
        if (this.accept('punct', '.')) {
          return { kind: 'column', table: t.value, name: this.ident('column name') };
        }
        return { kind: 'column', name: t.value };
      }
    }
    return this.fail('an expression');
  }

  private call(name: string): Expr {
    if (this.accept('op', '*')) {
      this.expect('punct', ')');
      return { kind: 'call', name, args: [], star: true, distinct: false };
    }
    const distinct = this.acceptKw('DISTINCT');
    const args: Expr[] = [];
    if (!this.is('punct', ')')) {
      do {
        args.push(this.expr());
      } while (this.accept('punct', ','));
    }
    this.expect('punct', ')');
    return { kind: 'call', name, args, star: false, distinct };
  }

  private caseExpr(): Expr {
    this.expectKw('CASE');
    // Simple form `CASE x WHEN 1 THEN ...` is desugared to `CASE WHEN x = 1 THEN ...`.
    const subject = this.isKw('WHEN') ? undefined : this.expr();
    const whens: { when: Expr; then: Expr }[] = [];
    while (this.acceptKw('WHEN')) {
      const cond = this.expr();
      this.expectKw('THEN');
      const then = this.expr();
      whens.push({
        when: subject ? { kind: 'binary', op: '=', left: subject, right: cond } : cond,
        then,
      });
    }
    if (whens.length === 0) this.fail('WHEN');
    const otherwise = this.acceptKw('ELSE') ? this.expr() : undefined;
    this.expectKw('END');
    return { kind: 'case', whens, else: otherwise };
  }
}

/** Parse a script of one or more `;`-separated SQL statements. */
export function parse(sql: string): Statement[] {
  return new Parser(sql).parseScript();
}
