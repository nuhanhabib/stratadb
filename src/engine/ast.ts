import type { ColumnType, Value } from './values';

export type BinaryOp =
  | 'OR' | 'AND'
  | '=' | '<>' | '<' | '<=' | '>' | '>='
  | 'LIKE' | '||'
  | '+' | '-' | '*' | '/' | '%';

export type Expr =
  | { kind: 'literal'; value: Value }
  | { kind: 'column'; table?: string; name: string }
  /** A column already resolved to a position in the input row (produced by the planner). */
  | { kind: 'slot'; index: number; name: string }
  | { kind: 'unary'; op: '-' | 'NOT'; expr: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'between'; expr: Expr; low: Expr; high: Expr; negated: boolean }
  | { kind: 'in'; expr: Expr; list?: Expr[]; subquery?: SelectStmt; negated: boolean }
  | { kind: 'isnull'; expr: Expr; negated: boolean }
  | { kind: 'call'; name: string; args: Expr[]; star: boolean; distinct: boolean }
  | { kind: 'case'; whens: { when: Expr; then: Expr }[]; else?: Expr }
  | { kind: 'subquery'; select: SelectStmt };

export interface SelectItem {
  /** `undefined` expr means a star: `*` or `table.*`. */
  expr?: Expr;
  starTable?: string;
  alias?: string;
}

export interface TableRef {
  name: string;
  alias: string;
}

export interface JoinClause {
  type: 'inner' | 'left' | 'cross';
  table: TableRef;
  on?: Expr;
}

export interface OrderItem {
  expr: Expr;
  desc: boolean;
}

export interface SelectStmt {
  kind: 'select';
  distinct: boolean;
  items: SelectItem[];
  from?: TableRef;
  joins: JoinClause[];
  where?: Expr;
  groupBy: Expr[];
  having?: Expr;
  orderBy: OrderItem[];
  limit?: Expr;
  offset?: Expr;
}

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  default?: Expr;
}

export type Statement = (
  | SelectStmt
  | { kind: 'insert'; table: string; columns?: string[]; rows: Expr[][] }
  | { kind: 'update'; table: string; set: { column: string; expr: Expr }[]; where?: Expr }
  | { kind: 'delete'; table: string; where?: Expr }
  | { kind: 'createTable'; name: string; columns: ColumnSpec[]; ifNotExists: boolean }
  | { kind: 'createIndex'; name: string; table: string; column: string; unique: boolean }
  | { kind: 'dropTable'; name: string; ifExists: boolean }
  | { kind: 'dropIndex'; name: string; ifExists: boolean }
  | { kind: 'explain'; analyze: boolean; select: SelectStmt }
  | { kind: 'begin' }
  | { kind: 'commit' }
  | { kind: 'rollback' }
) & { source?: string };

export const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max']);

export function isAggregateCall(e: Expr): boolean {
  return e.kind === 'call' && AGGREGATES.has(e.name);
}

/** Rebuild an expression with each direct child replaced by `f(child)`. Does not enter subqueries. */
export function mapChildren(e: Expr, f: (child: Expr) => Expr): Expr {
  switch (e.kind) {
    case 'literal':
    case 'column':
    case 'slot':
    case 'subquery':
      return e;
    case 'unary':
      return { ...e, expr: f(e.expr) };
    case 'binary':
      return { ...e, left: f(e.left), right: f(e.right) };
    case 'between':
      return { ...e, expr: f(e.expr), low: f(e.low), high: f(e.high) };
    case 'in':
      return { ...e, expr: f(e.expr), list: e.list?.map(f) };
    case 'isnull':
      return { ...e, expr: f(e.expr) };
    case 'call':
      return { ...e, args: e.args.map(f) };
    case 'case':
      return {
        ...e,
        whens: e.whens.map((w) => ({ when: f(w.when), then: f(w.then) })),
        else: e.else ? f(e.else) : undefined,
      };
  }
}

/** Visit every node of an expression tree (pre-order). Does not enter subqueries. */
export function walk(e: Expr, visit: (e: Expr) => void): void {
  visit(e);
  mapChildren(e, (c) => {
    walk(c, visit);
    return c;
  });
}

/** Split `a AND b AND c` into `[a, b, c]`. */
export function splitConjuncts(e: Expr | undefined): Expr[] {
  if (!e) return [];
  if (e.kind === 'binary' && e.op === 'AND') {
    return [...splitConjuncts(e.left), ...splitConjuncts(e.right)];
  }
  return [e];
}

const PRECEDENCE: Record<string, number> = {
  OR: 1, AND: 2,
  '=': 4, '<>': 4, '<': 4, '<=': 4, '>': 4, '>=': 4, LIKE: 4,
  '||': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7,
};

function precedenceOf(e: Expr): number {
  if (e.kind === 'binary') return PRECEDENCE[e.op];
  if (e.kind === 'between' || e.kind === 'in' || e.kind === 'isnull') return 4;
  if (e.kind === 'unary') return e.op === 'NOT' ? 3 : 8;
  return 9;
}

/** Render an expression back to SQL text (used for column headers and plan descriptions). */
export function exprToString(e: Expr): string {
  const child = (c: Expr, minPrec: number) => {
    const s = exprToString(c);
    return precedenceOf(c) < minPrec ? `(${s})` : s;
  };
  switch (e.kind) {
    case 'literal':
      if (e.value === null) return 'NULL';
      if (typeof e.value === 'string') return `'${e.value.replace(/'/g, "''")}'`;
      return String(e.value).toUpperCase();
    case 'column':
      return e.table ? `${e.table}.${e.name}` : e.name;
    case 'slot':
      return e.name;
    case 'unary':
      return e.op === 'NOT' ? `NOT ${child(e.expr, 3)}` : `-${child(e.expr, 8)}`;
    case 'binary': {
      const p = PRECEDENCE[e.op];
      return `${child(e.left, p)} ${e.op} ${child(e.right, p + 1)}`;
    }
    case 'between':
      return `${child(e.expr, 5)} ${e.negated ? 'NOT ' : ''}BETWEEN ${child(e.low, 5)} AND ${child(e.high, 5)}`;
    case 'in':
      return `${child(e.expr, 5)} ${e.negated ? 'NOT ' : ''}IN (${
        e.subquery ? 'subquery' : e.list!.map(exprToString).join(', ')
      })`;
    case 'isnull':
      return `${child(e.expr, 5)} IS ${e.negated ? 'NOT ' : ''}NULL`;
    case 'call':
      if (e.star) return `${e.name}(*)`;
      return `${e.name}(${e.distinct ? 'DISTINCT ' : ''}${e.args.map(exprToString).join(', ')})`;
    case 'case':
      return `CASE ${e.whens
        .map((w) => `WHEN ${exprToString(w.when)} THEN ${exprToString(w.then)}`)
        .join(' ')}${e.else ? ` ELSE ${exprToString(e.else)}` : ''} END`;
    case 'subquery':
      return '(subquery)';
  }
}
