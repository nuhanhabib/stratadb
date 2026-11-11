import { toBool, type Col, type Evaluator } from './expr';
import type { Index, Table } from './storage';
import { compareValues, SqlError, type Row, type Value } from './values';

const now = () => performance.now();

/**
 * A node of the physical query plan.
 *
 * Execution follows the Volcano (iterator) model: each operator pulls rows from
 * its children on demand, expressed here with generators. Rows flow one at a
 * time, so `LIMIT 10` over a million-row scan stops after ten rows.
 */
export abstract class PlanNode {
  abstract readonly name: string;
  abstract readonly schema: Col[];
  children: PlanNode[] = [];

  /** Rows produced, recorded during execution for EXPLAIN ANALYZE. */
  rows = 0;
  /** Time spent producing rows, including time spent in children. */
  timeMs = 0;

  /** Human-readable description of what this operator does. */
  detail(): string {
    return '';
  }

  protected abstract exec(): Generator<Row>;

  /** Run the operator, recording row counts and timings as rows are pulled. */
  *run(): Generator<Row> {
    const it = this.exec();
    for (;;) {
      const start = now();
      const result = it.next();
      this.timeMs += now() - start;
      if (result.done) return;
      this.rows++;
      yield result.value;
    }
  }
}

/** Produces a single empty row: the input of a `SELECT` with no `FROM`. */
export class ResultNode extends PlanNode {
  readonly name = 'Result';
  readonly schema: Col[] = [];
  protected *exec(): Generator<Row> {
    yield [];
  }
}

export abstract class ScanNode extends PlanNode {
  readonly schema: Col[];
  constructor(
    readonly table: Table,
    readonly alias: string,
  ) {
    super();
    this.schema = table.columns.map((c) => ({ table: alias, name: c.name }));
  }

  /** Yields `[rowId, row]`; UPDATE and DELETE need the row id. */
  abstract scanIds(): Generator<[number, Row]>;

  protected *exec(): Generator<Row> {
    for (const [, row] of this.scanIds()) yield row;
  }

  protected label(): string {
    return this.alias === this.table.name ? this.table.name : `${this.table.name} AS ${this.alias}`;
  }
}

export class SeqScanNode extends ScanNode {
  readonly name = 'Seq Scan';
  detail(): string {
    return `on ${this.label()}`;
  }
  *scanIds(): Generator<[number, Row]> {
    yield* this.table.rows;
  }
}

export interface IndexBounds {
  lo?: Value;
  loInclusive: boolean;
  hi?: Value;
  hiInclusive: boolean;
  /** e.g. `customer_id = 42` */
  description: string;
}

export class IndexScanNode extends ScanNode {
  readonly name = 'Index Scan';
  constructor(
    table: Table,
    alias: string,
    readonly index: Index,
    readonly bounds: IndexBounds,
  ) {
    super(table, alias);
  }
  detail(): string {
    return `on ${this.label()} using ${this.index.name} (${this.bounds.description})`;
  }
  *scanIds(): Generator<[number, Row]> {
    const { lo, loInclusive, hi, hiInclusive } = this.bounds;
    for (const rowId of this.index.scan(lo, loInclusive, hi, hiInclusive)) {
      yield [rowId, this.table.rows.get(rowId)!];
    }
  }
}

export class FilterNode extends PlanNode {
  readonly name = 'Filter';
  readonly schema: Col[];
  constructor(
    child: PlanNode,
    private readonly predicate: Evaluator,
    private readonly description: string,
  ) {
    super();
    this.children = [child];
    this.schema = child.schema;
  }
  detail(): string {
    return this.description;
  }
  protected *exec(): Generator<Row> {
    const predicate = this.predicate;
    for (const row of this.children[0].run()) {
      if (toBool(predicate(row)) === true) yield row;
    }
  }
}

export class ProjectNode extends PlanNode {
  readonly name = 'Project';
  constructor(
    child: PlanNode,
    private readonly exprs: Evaluator[],
    readonly schema: Col[],
  ) {
    super();
    this.children = [child];
  }
  detail(): string {
    return this.schema.map((c) => c.name).join(', ');
  }
  protected *exec(): Generator<Row> {
    const exprs = this.exprs;
    for (const row of this.children[0].run()) yield exprs.map((f) => f(row));
  }
}

export type JoinType = 'inner' | 'left' | 'cross';

export class NestedLoopJoinNode extends PlanNode {
  readonly name: string;
  readonly schema: Col[];
  constructor(
    left: PlanNode,
    right: PlanNode,
    private readonly type: JoinType,
    private readonly predicate: Evaluator | null,
    private readonly description: string,
  ) {
    super();
    this.children = [left, right];
    this.schema = [...left.schema, ...right.schema];
    this.name = type === 'left' ? 'Nested Loop Left Join' : 'Nested Loop Join';
  }
  detail(): string {
    return this.description;
  }
  protected *exec(): Generator<Row> {
    const [left, right] = this.children;
    const inner = [...right.run()];
    const nulls: Row = right.schema.map(() => null);
    const predicate = this.predicate;
    for (const l of left.run()) {
      let matched = false;
      for (const r of inner) {
        const row = l.concat(r);
        if (predicate && toBool(predicate(row)) !== true) continue;
        matched = true;
        yield row;
      }
      if (!matched && this.type === 'left') yield l.concat(nulls);
    }
  }
}

/** Build a hashable key from one or more values; `undefined` means "contains NULL, cannot match". */
function hashKey(evals: Evaluator[], row: Row): Value | undefined {
  if (evals.length === 1) {
    const v = evals[0](row);
    return v === null ? undefined : v;
  }
  let key = '';
  for (const f of evals) {
    const v = f(row);
    if (v === null) return undefined;
    key += `${typeof v}:${v}\u0000`;
  }
  return key;
}

/**
 * Equi-join in O(left + right): hash the right input on its join keys, then
 * probe it once per left row. Output keeps the left input's order.
 */
export class HashJoinNode extends PlanNode {
  readonly name: string;
  readonly schema: Col[];
  constructor(
    left: PlanNode,
    right: PlanNode,
    private readonly type: JoinType,
    private readonly leftKeys: Evaluator[],
    private readonly rightKeys: Evaluator[],
    /** Extra non-equality conditions, evaluated on the joined row. */
    private readonly residual: Evaluator | null,
    private readonly description: string,
  ) {
    super();
    this.children = [left, right];
    this.schema = [...left.schema, ...right.schema];
    this.name = type === 'left' ? 'Hash Left Join' : 'Hash Join';
  }
  detail(): string {
    return this.description;
  }
  protected *exec(): Generator<Row> {
    const [left, right] = this.children;
    const buckets = new Map<Value, Row[]>();
    for (const r of right.run()) {
      const key = hashKey(this.rightKeys, r);
      if (key === undefined) continue;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(r);
      else buckets.set(key, [r]);
    }
    const nulls: Row = right.schema.map(() => null);
    const residual = this.residual;
    for (const l of left.run()) {
      const key = hashKey(this.leftKeys, l);
      const bucket = key === undefined ? undefined : buckets.get(key);
      let matched = false;
      if (bucket) {
        for (const r of bucket) {
          const row = l.concat(r);
          if (residual && toBool(residual(row)) !== true) continue;
          matched = true;
          yield row;
        }
      }
      if (!matched && this.type === 'left') yield l.concat(nulls);
    }
  }
}

export interface AggregateSpec {
  fn: 'count' | 'sum' | 'avg' | 'min' | 'max';
  /** `null` for `COUNT(*)`. */
  arg: Evaluator | null;
  distinct: boolean;
  label: string;
}

class Accumulator {
  private count = 0;
  private sum = 0;
  private extreme: Value = null;
  private seen: Set<Value> | null;

  constructor(private readonly spec: AggregateSpec) {
    this.seen = spec.distinct ? new Set() : null;
  }

  add(row: Row): void {
    const { fn, arg } = this.spec;
    if (!arg) {
      this.count++;
      return;
    }
    const v = arg(row);
    if (v === null) return; // aggregates skip NULLs
    if (this.seen) {
      if (this.seen.has(v)) return;
      this.seen.add(v);
    }
    this.count++;
    if (fn === 'sum' || fn === 'avg') {
      if (typeof v !== 'number') throw new SqlError(`${fn}() expects a number`);
      this.sum += v;
    } else if (fn === 'min') {
      if (this.extreme === null || compareValues(v, this.extreme) < 0) this.extreme = v;
    } else if (fn === 'max') {
      if (this.extreme === null || compareValues(v, this.extreme) > 0) this.extreme = v;
    }
  }

  result(): Value {
    switch (this.spec.fn) {
      case 'count':
        return this.count;
      case 'sum':
        return this.count ? this.sum : null;
      case 'avg':
        return this.count ? this.sum / this.count : null;
      default:
        return this.extreme;
    }
  }
}

/** Hash aggregation. Output row layout: group-by values, then one value per aggregate. */
export class AggregateNode extends PlanNode {
  readonly name: string;
  constructor(
    child: PlanNode,
    private readonly groupBy: Evaluator[],
    private readonly aggregates: AggregateSpec[],
    readonly schema: Col[],
    private readonly description: string,
  ) {
    super();
    this.children = [child];
    this.name = groupBy.length ? 'Hash Aggregate' : 'Aggregate';
  }
  detail(): string {
    return this.description;
  }
  protected *exec(): Generator<Row> {
    const groups = new Map<string, { key: Row; accs: Accumulator[] }>();
    const fresh = () => this.aggregates.map((spec) => new Accumulator(spec));
    for (const row of this.children[0].run()) {
      const key = this.groupBy.map((f) => f(row));
      const id = key.map((v) => `${typeof v}:${v}`).join('\u0000');
      let group = groups.get(id);
      if (!group) groups.set(id, (group = { key, accs: fresh() }));
      for (const acc of group.accs) acc.add(row);
    }
    // Without GROUP BY an aggregate query always returns exactly one row, even on empty input.
    if (groups.size === 0 && this.groupBy.length === 0) {
      yield fresh().map((a) => a.result());
      return;
    }
    for (const { key, accs } of groups.values()) yield [...key, ...accs.map((a) => a.result())];
  }
}

export interface SortKey {
  expr: Evaluator;
  desc: boolean;
}

export class SortNode extends PlanNode {
  readonly name = 'Sort';
  readonly schema: Col[];
  constructor(
    child: PlanNode,
    private readonly keys: SortKey[],
    private readonly description: string,
  ) {
    super();
    this.children = [child];
    this.schema = child.schema;
  }
  detail(): string {
    return this.description;
  }
  protected *exec(): Generator<Row> {
    // Decorate-sort-undecorate: evaluate each sort key once per row, not once per comparison.
    const decorated = [...this.children[0].run()].map((row) => ({
      row,
      keys: this.keys.map((k) => k.expr(row)),
    }));
    const keys = this.keys;
    decorated.sort((a, b) => {
      for (let i = 0; i < keys.length; i++) {
        const c = compareValues(a.keys[i], b.keys[i]);
        if (c !== 0) return keys[i].desc ? -c : c;
      }
      return 0;
    });
    for (const d of decorated) yield d.row;
  }
}

export class DistinctNode extends PlanNode {
  readonly name = 'Distinct';
  readonly schema: Col[];
  constructor(child: PlanNode) {
    super();
    this.children = [child];
    this.schema = child.schema;
  }
  protected *exec(): Generator<Row> {
    const seen = new Set<string>();
    for (const row of this.children[0].run()) {
      const id = row.map((v) => `${typeof v}:${v}`).join('\u0000');
      if (seen.has(id)) continue;
      seen.add(id);
      yield row;
    }
  }
}

export class LimitNode extends PlanNode {
  readonly name = 'Limit';
  readonly schema: Col[];
  constructor(
    child: PlanNode,
    private readonly limit: number,
    private readonly offset: number,
  ) {
    super();
    this.children = [child];
    this.schema = child.schema;
  }
  detail(): string {
    return this.offset ? `${this.limit} offset ${this.offset}` : `${this.limit}`;
  }
  protected *exec(): Generator<Row> {
    if (this.limit <= 0) return;
    let skipped = 0;
    let produced = 0;
    for (const row of this.children[0].run()) {
      if (skipped < this.offset) {
        skipped++;
        continue;
      }
      yield row;
      // Stop pulling from the child as soon as we have enough rows.
      if (++produced >= this.limit) return;
    }
  }
}

/** A plain-data snapshot of a plan tree, safe to hand to a UI or serialize. */
export interface PlanInfo {
  name: string;
  detail: string;
  rows: number;
  timeMs: number;
  children: PlanInfo[];
}

export function describePlan(node: PlanNode): PlanInfo {
  return {
    name: node.name,
    detail: node.detail(),
    rows: node.rows,
    timeMs: node.timeMs,
    children: node.children.map(describePlan),
  };
}

/** Render a plan as an indented text tree, as shown by EXPLAIN. */
export function formatPlan(plan: PlanInfo, analyze: boolean): string[] {
  const lines: string[] = [];
  const visit = (node: PlanInfo, prefix: string, childPrefix: string) => {
    let line = `${prefix}${node.name}${node.detail ? ` ${node.detail}` : ''}`;
    if (analyze) line += `  (rows=${node.rows}, time=${node.timeMs.toFixed(3)}ms)`;
    lines.push(line);
    node.children.forEach((child, i) => {
      const last = i === node.children.length - 1;
      visit(child, `${childPrefix}${last ? '└─ ' : '├─ '}`, `${childPrefix}${last ? '   ' : '│  '}`);
    });
  };
  visit(plan, '', '');
  return lines;
}
