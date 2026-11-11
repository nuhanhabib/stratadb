import {
  exprToString, isAggregateCall, mapChildren, splitConjuncts, walk,
  type Expr, type JoinClause, type SelectStmt,
} from './ast';
import { compile, resolveColumn, type Col, type CompileContext } from './expr';
import {
  AggregateNode, DistinctNode, FilterNode, HashJoinNode, IndexScanNode, LimitNode,
  NestedLoopJoinNode, ProjectNode, ResultNode, SeqScanNode, SortNode,
  type AggregateSpec, type IndexBounds, type PlanNode, type ScanNode,
} from './plan';
import type { Index, Table } from './storage';
import { compareValues, SqlError, type Value } from './values';

export interface Catalog {
  getTable(name: string): Table;
}

export function andAll(exprs: Expr[]): Expr {
  return exprs.reduce((left, right) => ({ kind: 'binary', op: 'AND', left, right }));
}

const describe = (exprs: Expr[]) => exprs.map(exprToString).join(' AND ');

// ---------------------------------------------------------------------------
// Access path selection: sequential scan vs. index scan
// ---------------------------------------------------------------------------

type CompareOp = '=' | '<' | '<=' | '>' | '>=';

interface Bound {
  column: number;
  op: CompareOp;
  value: Value;
  /** The WHERE conjunct this bound came from. */
  source: Expr;
}

const FLIPPED: Record<CompareOp, CompareOp> = { '=': '=', '<': '>', '<=': '>=', '>': '<', '>=': '<=' };

/** Evaluate an expression that references no columns, or return null if it is not constant. */
function constantValue(e: Expr): { value: Value } | null {
  let constant = true;
  walk(e, (n) => {
    if (
      n.kind === 'column' || n.kind === 'slot' || n.kind === 'subquery' ||
      (n.kind === 'in' && n.subquery) || isAggregateCall(n)
    ) {
      constant = false;
    }
  });
  if (!constant) return null;
  try {
    return { value: compile(e, [])([]) };
  } catch {
    return null;
  }
}

/** Recognise `column <op> constant` (either way round) and `column BETWEEN a AND b`. */
function extractBounds(e: Expr, table: Table, alias: string): Bound[] {
  const columnOf = (c: Expr): number =>
    c.kind === 'column' && (c.table === undefined || c.table === alias) ? table.columnIndex(c.name) : -1;

  if (e.kind === 'between' && !e.negated) {
    const column = columnOf(e.expr);
    const lo = constantValue(e.low);
    const hi = constantValue(e.high);
    if (column < 0 || !lo || !hi || lo.value === null || hi.value === null) return [];
    return [
      { column, op: '>=', value: lo.value, source: e },
      { column, op: '<=', value: hi.value, source: e },
    ];
  }
  if (e.kind !== 'binary' || !(e.op in FLIPPED)) return [];
  const op = e.op as CompareOp;
  for (const [colSide, constSide, actualOp] of [
    [e.left, e.right, op],
    [e.right, e.left, FLIPPED[op]],
  ] as const) {
    const column = columnOf(colSide);
    if (column < 0) continue;
    const constant = constantValue(constSide);
    if (constant && constant.value !== null) {
      return [{ column, op: actualOp, value: constant.value, source: e }];
    }
  }
  return [];
}

/**
 * Choose how to read one table given the predicates that apply to it alone.
 * Returns the scan plus the predicates the scan does not already guarantee.
 *
 * Rule-based ranking: unique equality > equality > two-sided range > one-sided range > seq scan.
 */
export function planAccess(
  table: Table,
  alias: string,
  conjuncts: Expr[],
): { scan: ScanNode; residual: Expr[] } {
  const bounds = conjuncts.flatMap((c) => extractBounds(c, table, alias));

  interface Candidate {
    score: number;
    index: Index;
    bounds: IndexBounds;
    consumed: Set<Expr>;
  }
  let best = null as Candidate | null;
  for (const index of table.indexes) {
    const mine = bounds.filter((b) => b.column === index.column);
    if (mine.length === 0) continue;
    const column = index.columnName;
    const lit = (v: Value) => exprToString({ kind: 'literal', value: v });

    const eq = mine.find((b) => b.op === '=');
    let candidate: Candidate;
    if (eq) {
      candidate = {
        score: index.unique ? 4 : 3,
        index,
        bounds: {
          lo: eq.value, loInclusive: true, hi: eq.value, hiInclusive: true,
          description: `${column} = ${lit(eq.value)}`,
        },
        consumed: new Set([eq.source]),
      };
    } else {
      // Intersect all range predicates on this column into the tightest interval.
      let lo: Bound | undefined;
      let hi: Bound | undefined;
      for (const b of mine) {
        if (b.op === '>' || b.op === '>=') {
          const c = lo ? compareValues(b.value, lo.value) : 1;
          if (c > 0 || (c === 0 && b.op === '>')) lo = b;
        } else {
          const c = hi ? compareValues(b.value, hi.value) : -1;
          if (c < 0 || (c === 0 && b.op === '<')) hi = b;
        }
      }
      const parts: string[] = [];
      if (lo) parts.push(`${column} ${lo.op} ${lit(lo.value)}`);
      if (hi) parts.push(`${column} ${hi.op} ${lit(hi.value)}`);
      candidate = {
        score: lo && hi ? 2 : 1,
        index,
        bounds: {
          lo: lo?.value, loInclusive: lo?.op === '>=',
          hi: hi?.value, hiInclusive: hi?.op === '<=',
          description: parts.join(' AND '),
        },
        consumed: new Set(mine.map((b) => b.source)),
      };
    }
    if (!best || candidate.score > best.score) best = candidate;
  }

  if (!best) return { scan: new SeqScanNode(table, alias), residual: conjuncts };
  const consumed = best.consumed;
  return {
    scan: new IndexScanNode(table, alias, best.index, best.bounds),
    residual: conjuncts.filter((c) => !consumed.has(c)),
  };
}

// ---------------------------------------------------------------------------
// SELECT planning
// ---------------------------------------------------------------------------

interface Source {
  alias: string;
  table: Table;
  join: JoinClause | null;
}

interface Predicate {
  expr: Expr;
  /** Aliases of the tables this predicate reads. */
  tables: Set<string>;
  used: boolean;
}

function tablesOf(e: Expr, sources: Source[]): Set<string> {
  const out = new Set<string>();
  walk(e, (n) => {
    if (n.kind !== 'column') return;
    if (n.table !== undefined) {
      const source = sources.find((s) => s.alias === n.table);
      if (!source) throw new SqlError(`missing FROM-clause entry for table "${n.table}"`);
      if (source.table.columnIndex(n.name) < 0) {
        throw new SqlError(`column "${n.table}.${n.name}" does not exist`);
      }
      out.add(source.alias);
      return;
    }
    const matches = sources.filter((s) => s.table.columnIndex(n.name) >= 0);
    if (matches.length === 0) throw new SqlError(`column "${n.name}" does not exist`);
    if (matches.length > 1) throw new SqlError(`column reference "${n.name}" is ambiguous`);
    out.add(matches[0].alias);
  });
  return out;
}

const isSubset = (a: Set<string>, b: Set<string>) => [...a].every((x) => b.has(x));
const onlyTable = (p: Predicate, alias: string) => p.tables.size === 1 && p.tables.has(alias);

function containsAggregate(e: Expr | undefined): boolean {
  let found = false;
  if (e) walk(e, (n) => (found ||= isAggregateCall(n)));
  return found;
}

export interface SelectPlan {
  plan: PlanNode;
  columns: string[];
}

/**
 * Turn a parsed SELECT into a tree of physical operators:
 *
 *   scans -> joins -> filter -> aggregate -> having -> sort -> project -> distinct -> limit
 *
 * Optimisations applied:
 *  - predicate pushdown: single-table predicates are evaluated at the scan, below joins
 *  - index selection: pushed-down predicates on indexed columns become index scans
 *  - hash joins: equality join conditions are executed as hash joins, not nested loops
 */
export function planSelect(catalog: Catalog, stmt: SelectStmt): SelectPlan {
  const ctx: CompileContext = {
    subquery: (select) => [...planSelect(catalog, select).plan.run()],
  };
  const filter = (child: PlanNode, exprs: Expr[]): PlanNode =>
    exprs.length === 0
      ? child
      : new FilterNode(child, compile(andAll(exprs), child.schema, ctx), describe(exprs));

  // ---- FROM / JOIN / WHERE -------------------------------------------------

  let current: PlanNode;
  if (!stmt.from) {
    current = filter(new ResultNode(), splitConjuncts(stmt.where));
  } else {
    const sources: Source[] = [
      { alias: stmt.from.alias, table: catalog.getTable(stmt.from.name), join: null },
      ...stmt.joins.map((join) => ({
        alias: join.table.alias,
        table: catalog.getTable(join.table.name),
        join,
      })),
    ];
    const aliases = new Set<string>();
    for (const s of sources) {
      if (aliases.has(s.alias)) throw new SqlError(`table name "${s.alias}" specified more than once`);
      aliases.add(s.alias);
    }

    const toPredicate = (expr: Expr): Predicate => ({ expr, tables: tablesOf(expr, sources), used: false });
    const take = (preds: Predicate[]): Expr[] =>
      preds.map((p) => {
        p.used = true;
        return p.expr;
      });

    // WHERE and INNER JOIN ... ON conditions are interchangeable, so they share one pool.
    // LEFT JOIN conditions decide which rows get NULL-extended and must stay with their join.
    const pool: Predicate[] = splitConjuncts(stmt.where).map(toPredicate);
    const leftJoinConditions = new Map<Source, Predicate[]>();
    for (const s of sources) {
      if (!s.join?.on) continue;
      const preds = splitConjuncts(s.join.on).map(toPredicate);
      if (s.join.type === 'left') leftJoinConditions.set(s, preds);
      else pool.push(...preds);
    }

    // Predicate pushdown. A WHERE predicate on the nullable side of a LEFT JOIN must run
    // after the join (it sees the NULL-extended rows), so only that join's own ON
    // conditions may be pushed into its scan.
    const scans = sources.map((s) => {
      const candidates = s.join?.type === 'left' ? leftJoinConditions.get(s)! : pool;
      const pushed = take(candidates.filter((p) => !p.used && onlyTable(p, s.alias)));
      const { scan, residual } = planAccess(s.table, s.alias, pushed);
      return filter(scan, residual);
    });

    // Left-deep join tree, in the order the tables were written.
    current = scans[0];
    const available = new Set([sources[0].alias]);
    for (let i = 1; i < sources.length; i++) {
      const source = sources[i];
      const right = scans[i];
      const type = source.join!.type;
      const withRight = new Set(available).add(source.alias);

      const conditions =
        type === 'left'
          ? take(leftJoinConditions.get(source)!.filter((p) => !p.used))
          : take(pool.filter((p) => !p.used && p.tables.has(source.alias) && isSubset(p.tables, withRight)));

      // Split conditions into hashable equalities (left expr = right expr) and the rest.
      const leftKeys: Expr[] = [];
      const rightKeys: Expr[] = [];
      const residual: Expr[] = [];
      for (const cond of conditions) {
        if (cond.kind === 'binary' && cond.op === '=') {
          const lt = tablesOf(cond.left, sources);
          const rt = tablesOf(cond.right, sources);
          const rightOnly = (t: Set<string>) => t.size === 1 && t.has(source.alias);
          const leftOnly = (t: Set<string>) => t.size > 0 && isSubset(t, available);
          if (leftOnly(lt) && rightOnly(rt)) {
            leftKeys.push(cond.left);
            rightKeys.push(cond.right);
            continue;
          }
          if (leftOnly(rt) && rightOnly(lt)) {
            leftKeys.push(cond.right);
            rightKeys.push(cond.left);
            continue;
          }
        }
        residual.push(cond);
      }

      const joined: Col[] = [...current.schema, ...right.schema];
      if (leftKeys.length > 0) {
        current = new HashJoinNode(
          current,
          right,
          type,
          leftKeys.map((k) => compile(k, current.schema, ctx)),
          rightKeys.map((k) => compile(k, right.schema, ctx)),
          residual.length ? compile(andAll(residual), joined, ctx) : null,
          `on ${describe(conditions)}`,
        );
      } else {
        current = new NestedLoopJoinNode(
          current,
          right,
          type,
          conditions.length ? compile(andAll(conditions), joined, ctx) : null,
          conditions.length ? `on ${describe(conditions)}` : '(cross product)',
        );
      }
      available.add(source.alias);

      // Predicates that became evaluable only now (e.g. WHERE on a LEFT JOIN's nullable side).
      current = filter(
        current,
        take(pool.filter((p) => !p.used && p.tables.size > 0 && isSubset(p.tables, available))),
      );
    }
    current = filter(current, take(pool.filter((p) => !p.used)));
  }

  // ---- SELECT list ---------------------------------------------------------

  const input = current.schema;
  const slotName = (i: number) => {
    const col = input[i];
    const unique = input.filter((c) => c.name === col.name).length === 1;
    return unique || !col.table ? col.name : `${col.table}.${col.name}`;
  };
  /** Resolve column names to positions in the joined row. */
  const bind = (e: Expr): Expr =>
    e.kind === 'column'
      ? (() => {
          const index = resolveColumn(input, e.table, e.name);
          return { kind: 'slot', index, name: slotName(index) } as Expr;
        })()
      : mapChildren(e, bind);

  const outputs: { expr: Expr; name: string; alias?: string }[] = [];
  for (const item of stmt.items) {
    if (item.expr) {
      const name =
        item.alias ?? (item.expr.kind === 'column' ? item.expr.name : exprToString(item.expr));
      outputs.push({ expr: bind(item.expr), name, alias: item.alias });
      continue;
    }
    if (!stmt.from) throw new SqlError('SELECT * requires a FROM clause');
    const before = outputs.length;
    input.forEach((col, index) => {
      if (item.starTable && col.table !== item.starTable) return;
      outputs.push({ expr: { kind: 'slot', index, name: slotName(index) }, name: col.name });
    });
    if (outputs.length === before) {
      throw new SqlError(`missing FROM-clause entry for table "${item.starTable}"`);
    }
  }

  /** GROUP BY / ORDER BY may name an output column by position (`ORDER BY 2`) or alias. */
  const resolveOutputRef = (e: Expr, clause: string, aliasWins: boolean): Expr => {
    if (e.kind === 'literal' && typeof e.value === 'number' && Number.isInteger(e.value)) {
      const out = outputs[e.value - 1];
      if (!out) throw new SqlError(`${clause} position ${e.value} is not in the select list`);
      return out.expr;
    }
    if (e.kind === 'column' && e.table === undefined) {
      const byAlias = outputs.find((o) => o.alias === e.name);
      const isInputColumn = input.some((c) => c.name === e.name);
      if (byAlias && (aliasWins || !isInputColumn)) return byAlias.expr;
    }
    return bind(e);
  };

  let outputExprs = outputs.map((o) => o.expr);
  let orderExprs = stmt.orderBy.map((o) => resolveOutputRef(o.expr, 'ORDER BY', true));

  // ---- GROUP BY / aggregates / HAVING --------------------------------------

  const aggregated =
    stmt.groupBy.length > 0 ||
    stmt.items.some((i) => containsAggregate(i.expr)) ||
    containsAggregate(stmt.having) ||
    stmt.orderBy.some((o) => containsAggregate(o.expr));

  if (aggregated) {
    const groupExprs = stmt.groupBy.map((g) => resolveOutputRef(g, 'GROUP BY', false));
    for (const g of groupExprs) {
      if (containsAggregate(g)) throw new SqlError('aggregate functions are not allowed in GROUP BY');
    }
    const groupKeys = groupExprs.map((g) => JSON.stringify(g));
    const aggregates: { key: string; call: Extract<Expr, { kind: 'call' }> }[] = [];

    // Rewrite an expression over the joined row into one over the aggregate's output row:
    // group-by expressions and aggregate calls become references to output positions.
    const rewrite = (e: Expr): Expr => {
      const key = JSON.stringify(e);
      const g = groupKeys.indexOf(key);
      if (g >= 0) return { kind: 'slot', index: g, name: exprToString(e) };
      if (e.kind === 'call' && isAggregateCall(e)) {
        if (e.args.some(containsAggregate)) throw new SqlError('aggregate function calls cannot be nested');
        let a = aggregates.findIndex((x) => x.key === key);
        if (a < 0) a = aggregates.push({ key, call: e }) - 1;
        return { kind: 'slot', index: groupExprs.length + a, name: exprToString(e) };
      }
      if (e.kind === 'slot') {
        throw new SqlError(
          `column "${e.name}" must appear in the GROUP BY clause or be used in an aggregate function`,
        );
      }
      return mapChildren(e, rewrite);
    };

    outputExprs = outputExprs.map(rewrite);
    const having = stmt.having ? rewrite(bind(stmt.having)) : null;
    orderExprs = orderExprs.map(rewrite);

    const specs: AggregateSpec[] = aggregates.map(({ call }) => {
      if (call.star && call.name !== 'count') throw new SqlError(`${call.name}(*) is not supported`);
      if (!call.star && call.args.length !== 1) {
        throw new SqlError(`${call.name}() takes exactly one argument`);
      }
      return {
        fn: call.name as AggregateSpec['fn'],
        arg: call.star ? null : compile(call.args[0], input, ctx),
        distinct: call.distinct,
        label: exprToString(call),
      };
    });

    const parts: string[] = [];
    if (groupExprs.length) parts.push(`group by ${groupExprs.map(exprToString).join(', ')}`);
    if (specs.length) parts.push(specs.map((s) => s.label).join(', '));
    current = new AggregateNode(
      current,
      groupExprs.map((g) => compile(g, input, ctx)),
      specs,
      [...groupExprs.map(exprToString), ...specs.map((s) => s.label)].map((name) => ({ table: null, name })),
      parts.join(' · '),
    );
    if (having) current = new FilterNode(current, compile(having, current.schema, ctx), exprToString(having));
  } else if (stmt.having) {
    throw new SqlError('HAVING requires GROUP BY or an aggregate function');
  }

  // ---- ORDER BY / projection / DISTINCT / LIMIT ----------------------------

  if (orderExprs.length > 0) {
    current = new SortNode(
      current,
      orderExprs.map((e, i) => ({ expr: compile(e, current.schema, ctx), desc: stmt.orderBy[i].desc })),
      stmt.orderBy.map((o) => `${exprToString(o.expr)}${o.desc ? ' DESC' : ''}`).join(', '),
    );
  }

  const identity =
    outputExprs.length === current.schema.length &&
    outputExprs.every((e, i) => e.kind === 'slot' && e.index === i);
  if (!identity) {
    current = new ProjectNode(
      current,
      outputExprs.map((e) => compile(e, current.schema, ctx)),
      outputs.map((o) => ({ table: null, name: o.name })),
    );
  }

  if (stmt.distinct) current = new DistinctNode(current);

  if (stmt.limit) {
    const constant = (e: Expr, clause: string): number => {
      const v = constantValue(e)?.value;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new SqlError(`${clause} must be a non-negative integer`);
      }
      return v;
    };
    current = new LimitNode(
      current,
      constant(stmt.limit, 'LIMIT'),
      stmt.offset ? constant(stmt.offset, 'OFFSET') : 0,
    );
  }

  return { plan: current, columns: outputs.map((o) => o.name) };
}
