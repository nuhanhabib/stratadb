import { isAggregateCall, type Expr, type SelectStmt } from './ast';
import { compareValues, SqlError, typeName, type Row, type Value } from './values';

/** One column of an operator's output: the table alias it came from (if any) and its name. */
export interface Col {
  table: string | null;
  name: string;
}

export type Evaluator = (row: Row) => Value;

export interface CompileContext {
  /** Runs an uncorrelated subquery and returns its rows. */
  subquery?: (select: SelectStmt) => Row[];
}

export function resolveColumn(schema: Col[], table: string | undefined, name: string): number {
  let found = -1;
  for (let i = 0; i < schema.length; i++) {
    const c = schema[i];
    if (c.name !== name || (table !== undefined && c.table !== table)) continue;
    if (found >= 0) throw new SqlError(`column reference "${name}" is ambiguous`);
    found = i;
  }
  if (found < 0) {
    throw new SqlError(`column "${table ? `${table}.` : ''}${name}" does not exist`);
  }
  return found;
}

/** SQL truthiness: NULL stays NULL (unknown). */
export function toBool(v: Value): boolean | null {
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return v.length > 0;
}

function likeToRegExp(pattern: string): RegExp {
  let source = '';
  for (const ch of pattern) {
    if (ch === '%') source += '[\\s\\S]*';
    else if (ch === '_') source += '[\\s\\S]';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

function num(v: Value, op: string): number {
  if (typeof v !== 'number') throw new SqlError(`operator ${op} cannot be applied to ${typeName(v)}`);
  return v;
}

type ScalarFn = (args: Value[]) => Value;

const text = (v: Value, fn: string): string => {
  if (typeof v !== 'string') throw new SqlError(`${fn}() expects text but got ${typeName(v)}`);
  return v;
};

/** Scalar functions. Unless noted, a NULL argument yields NULL. */
const FUNCTIONS: Record<string, { arity: [number, number]; nullSafe?: boolean; fn: ScalarFn }> = {
  upper: { arity: [1, 1], fn: ([s]) => text(s, 'upper').toUpperCase() },
  lower: { arity: [1, 1], fn: ([s]) => text(s, 'lower').toLowerCase() },
  length: { arity: [1, 1], fn: ([s]) => text(s, 'length').length },
  trim: { arity: [1, 1], fn: ([s]) => text(s, 'trim').trim() },
  abs: { arity: [1, 1], fn: ([n]) => Math.abs(num(n, 'abs()')) },
  floor: { arity: [1, 1], fn: ([n]) => Math.floor(num(n, 'floor()')) },
  ceil: { arity: [1, 1], fn: ([n]) => Math.ceil(num(n, 'ceil()')) },
  round: {
    arity: [1, 2],
    fn: ([n, digits]) => {
      const scale = 10 ** (digits === undefined ? 0 : num(digits, 'round()'));
      return Math.round(num(n, 'round()') * scale) / scale;
    },
  },
  substr: {
    arity: [2, 3],
    fn: ([s, start, len]) => {
      const from = Math.max(num(start, 'substr()') - 1, 0);
      const str = text(s, 'substr');
      return len === undefined ? str.slice(from) : str.slice(from, from + Math.max(num(len, 'substr()'), 0));
    },
  },
  coalesce: {
    arity: [1, Infinity],
    nullSafe: true,
    fn: (args) => args.find((a) => a !== null) ?? null,
  },
  nullif: {
    arity: [2, 2],
    nullSafe: true,
    fn: ([a, b]) => (a !== null && b !== null && compareValues(a, b) === 0 ? null : a),
  },
};

/**
 * Compile an expression tree into a JavaScript closure.
 *
 * Column references are resolved to array positions once, here, so evaluating
 * the expression per row is just closure calls and array reads: no name lookups
 * and no tree walking on the hot path.
 */
export function compile(e: Expr, schema: Col[], ctx: CompileContext = {}): Evaluator {
  switch (e.kind) {
    case 'literal': {
      const v = e.value;
      return () => v;
    }
    case 'slot': {
      const i = e.index;
      return (row) => row[i];
    }
    case 'column': {
      const i = resolveColumn(schema, e.table, e.name);
      return (row) => row[i];
    }
    case 'unary': {
      const inner = compile(e.expr, schema, ctx);
      if (e.op === 'NOT') {
        return (row) => {
          const b = toBool(inner(row));
          return b === null ? null : !b;
        };
      }
      return (row) => {
        const v = inner(row);
        return v === null ? null : -num(v, '-');
      };
    }
    case 'binary':
      return compileBinary(e, schema, ctx);
    case 'between': {
      const value = compile(e.expr, schema, ctx);
      const low = compile(e.low, schema, ctx);
      const high = compile(e.high, schema, ctx);
      const negated = e.negated;
      return (row) => {
        const v = value(row);
        const lo = low(row);
        const hi = high(row);
        if (v === null || lo === null || hi === null) return null;
        const inside = compareValues(v, lo) >= 0 && compareValues(v, hi) <= 0;
        return inside !== negated;
      };
    }
    case 'in': {
      const value = compile(e.expr, schema, ctx);
      const negated = e.negated;
      let items: Evaluator[];
      if (e.subquery) {
        const select = e.subquery;
        if (!ctx.subquery) throw new SqlError('subqueries are not allowed here');
        const run = ctx.subquery;
        // Uncorrelated: evaluated once, on first use, then cached.
        let cached: Evaluator[] | null = null;
        const load = () => {
          if (!cached) {
            const rows = run(select);
            if (rows.length > 0 && rows[0].length !== 1) {
              throw new SqlError('subquery used with IN must return exactly one column');
            }
            cached = rows.map((r) => () => r[0]);
          }
          return cached;
        };
        return (row) => evalIn(value(row), load(), row, negated);
      }
      items = e.list!.map((item) => compile(item, schema, ctx));
      return (row) => evalIn(value(row), items, row, negated);
    }
    case 'isnull': {
      const inner = compile(e.expr, schema, ctx);
      const negated = e.negated;
      return (row) => (inner(row) === null) !== negated;
    }
    case 'case': {
      const whens = e.whens.map((w) => ({
        when: compile(w.when, schema, ctx),
        then: compile(w.then, schema, ctx),
      }));
      const otherwise = e.else ? compile(e.else, schema, ctx) : null;
      return (row) => {
        for (const w of whens) if (toBool(w.when(row)) === true) return w.then(row);
        return otherwise ? otherwise(row) : null;
      };
    }
    case 'call': {
      if (isAggregateCall(e)) {
        throw new SqlError(`aggregate function ${e.name}() is not allowed here`);
      }
      const def = FUNCTIONS[e.name];
      if (!def || e.star) throw new SqlError(`function ${e.name}() does not exist`);
      if (e.args.length < def.arity[0] || e.args.length > def.arity[1]) {
        throw new SqlError(`wrong number of arguments to ${e.name}()`);
      }
      const args = e.args.map((a) => compile(a, schema, ctx));
      const { fn, nullSafe } = def;
      return (row) => {
        const values = args.map((a) => a(row));
        if (!nullSafe && values.includes(null)) return null;
        return fn(values);
      };
    }
    case 'subquery': {
      if (!ctx.subquery) throw new SqlError('subqueries are not allowed here');
      const run = ctx.subquery;
      const select = e.select;
      let cached: { value: Value } | null = null;
      return () => {
        if (!cached) {
          const rows = run(select);
          if (rows.length > 1) throw new SqlError('scalar subquery returned more than one row');
          if (rows.length === 1 && rows[0].length !== 1) {
            throw new SqlError('scalar subquery must return exactly one column');
          }
          cached = { value: rows.length ? rows[0][0] : null };
        }
        return cached.value;
      };
    }
  }
}

function evalIn(v: Value, items: Evaluator[], row: Row, negated: boolean): Value {
  if (v === null) return null;
  let sawNull = false;
  for (const item of items) {
    const candidate = item(row);
    if (candidate === null) sawNull = true;
    else if (compareValues(v, candidate) === 0) return !negated;
  }
  return sawNull ? null : negated;
}

function compileBinary(
  e: Extract<Expr, { kind: 'binary' }>,
  schema: Col[],
  ctx: CompileContext,
): Evaluator {
  const left = compile(e.left, schema, ctx);
  const right = compile(e.right, schema, ctx);
  const op = e.op;

  switch (op) {
    // Three-valued logic: FALSE AND NULL is FALSE, TRUE OR NULL is TRUE.
    case 'AND':
      return (row) => {
        const a = toBool(left(row));
        if (a === false) return false;
        const b = toBool(right(row));
        if (b === false) return false;
        return a === null || b === null ? null : true;
      };
    case 'OR':
      return (row) => {
        const a = toBool(left(row));
        if (a === true) return true;
        const b = toBool(right(row));
        if (b === true) return true;
        return a === null || b === null ? null : false;
      };
    case '=':
    case '<>':
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const test: (c: number) => boolean = {
        '=': (c: number) => c === 0,
        '<>': (c: number) => c !== 0,
        '<': (c: number) => c < 0,
        '<=': (c: number) => c <= 0,
        '>': (c: number) => c > 0,
        '>=': (c: number) => c >= 0,
      }[op];
      return (row) => {
        const a = left(row);
        const b = right(row);
        return a === null || b === null ? null : test(compareValues(a, b));
      };
    }
    case 'LIKE': {
      // Compile the pattern once when it is a literal, which is almost always the case.
      const fixed =
        e.right.kind === 'literal' && typeof e.right.value === 'string'
          ? likeToRegExp(e.right.value)
          : null;
      return (row) => {
        const a = left(row);
        const b = right(row);
        if (a === null || b === null) return null;
        return (fixed ?? likeToRegExp(String(b))).test(String(a));
      };
    }
    case '||':
      return (row) => {
        const a = left(row);
        const b = right(row);
        return a === null || b === null ? null : String(a) + String(b);
      };
    default: {
      const apply: (a: number, b: number) => Value = {
        '+': (a: number, b: number) => a + b,
        '-': (a: number, b: number) => a - b,
        '*': (a: number, b: number) => a * b,
        // Division by zero yields NULL rather than raising, as in SQLite.
        '/': (a: number, b: number) => (b === 0 ? null : a / b),
        '%': (a: number, b: number) => (b === 0 ? null : a % b),
      }[op];
      return (row) => {
        const a = left(row);
        const b = right(row);
        if (a === null || b === null) return null;
        return apply(num(a, op), num(b, op));
      };
    }
  }
}
