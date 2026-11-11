import { splitConjuncts, type Expr, type Statement } from './ast';
import { compile, toBool, type CompileContext } from './expr';
import { parse } from './parser';
import { describePlan, formatPlan, type PlanInfo } from './plan';
import { andAll, planAccess, planSelect, type Catalog } from './planner';
import { Table, type ColumnDef, type Index, type UndoLog } from './storage';
import { SqlError, type Row, type Value } from './values';

export type QueryResult =
  | {
      type: 'rows';
      statement: string;
      columns: string[];
      rows: Row[];
      /** The executed plan with per-operator row counts and timings (SELECT / EXPLAIN only). */
      plan: PlanInfo | null;
      timeMs: number;
    }
  | { type: 'ok'; statement: string; message: string; rowsAffected: number; timeMs: number };

export interface TableInfo {
  name: string;
  rowCount: number;
  columns: ColumnDef[];
  indexes: { name: string; column: string; unique: boolean; entries: number; height: number }[];
}

type Outcome =
  | { columns: string[]; rows: Row[]; plan: PlanInfo | null }
  | { message: string; rowsAffected: number };

/**
 * An in-memory relational database.
 *
 * ```ts
 * const db = new Database();
 * db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
 * db.execute("INSERT INTO t (name) VALUES ('ada'), ('grace')");
 * db.query('SELECT * FROM t WHERE id = 2'); // [{ id: 2, name: 'grace' }]
 * ```
 */
export class Database implements Catalog {
  private readonly tables = new Map<string, Table>();
  /** Undo actions for the open transaction, or null when in autocommit mode. */
  private transaction: (() => void)[] | null = null;

  get inTransaction(): boolean {
    return this.transaction !== null;
  }

  getTable(name: string): Table {
    const table = this.tables.get(name);
    if (!table) throw new SqlError(`table "${name}" does not exist`);
    return table;
  }

  /** Describe every table, for schema browsers. */
  schema(): TableInfo[] {
    return [...this.tables.values()].map((t) => ({
      name: t.name,
      rowCount: t.rows.size,
      columns: t.columns,
      indexes: t.indexes.map((i) => ({
        name: i.name,
        column: i.columnName,
        unique: i.unique,
        entries: i.tree.size,
        height: i.tree.height(),
      })),
    }));
  }

  /** Parse and run a script. Throws {@link SqlError} on the first failing statement. */
  execute(sql: string): QueryResult[] {
    return parse(sql).map((stmt) => this.run(stmt));
  }

  /** Run a script and return the last statement's rows as objects keyed by column name. */
  query(sql: string): Record<string, Value>[] {
    const last = this.execute(sql).at(-1);
    if (!last || last.type !== 'rows') return [];
    return last.rows.map((row) => Object.fromEntries(last.columns.map((c, i) => [c, row[i]])));
  }

  /**
   * Run one parsed statement. Every statement is atomic: if it fails part-way
   * (say, the third row of an INSERT violates a constraint), its earlier effects are undone.
   */
  run(stmt: Statement): QueryResult {
    const statement = stmt.source ?? '';
    const start = performance.now();
    const undo: (() => void)[] = [];
    let outcome: Outcome;
    try {
      outcome = this.dispatch(stmt, (fn) => undo.push(fn));
    } catch (err) {
      for (let i = undo.length - 1; i >= 0; i--) undo[i]();
      throw err;
    }
    this.transaction?.push(...undo);
    const timeMs = performance.now() - start;
    return 'rows' in outcome
      ? { type: 'rows', statement, timeMs, ...outcome }
      : { type: 'ok', statement, timeMs, ...outcome };
  }

  private dispatch(stmt: Statement, log: UndoLog): Outcome {
    switch (stmt.kind) {
      case 'select': {
        const { plan, columns } = planSelect(this, stmt);
        const rows = [...plan.run()];
        return { columns, rows, plan: describePlan(plan) };
      }
      case 'explain': {
        const { plan } = planSelect(this, stmt.select);
        if (stmt.analyze) for (const _ of plan.run()) void _;
        const info = describePlan(plan);
        return {
          columns: ['QUERY PLAN'],
          rows: formatPlan(info, stmt.analyze).map((line) => [line]),
          plan: info,
        };
      }
      case 'insert':
        return this.insert(stmt, log);
      case 'update':
        return this.update(stmt, log);
      case 'delete':
        return this.delete(stmt, log);
      case 'createTable': {
        if (this.tables.has(stmt.name)) {
          if (stmt.ifNotExists) return { message: `table "${stmt.name}" already exists, skipped`, rowsAffected: 0 };
          throw new SqlError(`table "${stmt.name}" already exists`);
        }
        const columns: ColumnDef[] = stmt.columns.map((c) => ({
          name: c.name,
          type: c.type,
          notNull: c.notNull,
          primaryKey: c.primaryKey,
          unique: c.unique,
          default: c.default ? compile(c.default, [])([]) : null,
        }));
        this.tables.set(stmt.name, new Table(stmt.name, columns));
        log(() => this.tables.delete(stmt.name));
        return { message: `created table ${stmt.name}`, rowsAffected: 0 };
      }
      case 'dropTable': {
        const table = this.tables.get(stmt.name);
        if (!table) {
          if (stmt.ifExists) return { message: `table "${stmt.name}" does not exist, skipped`, rowsAffected: 0 };
          throw new SqlError(`table "${stmt.name}" does not exist`);
        }
        this.tables.delete(stmt.name);
        log(() => this.tables.set(stmt.name, table));
        return { message: `dropped table ${stmt.name}`, rowsAffected: 0 };
      }
      case 'createIndex': {
        if (this.findIndex(stmt.name)) throw new SqlError(`index "${stmt.name}" already exists`);
        const table = this.getTable(stmt.table);
        const index = table.createIndex(stmt.name, stmt.column, stmt.unique);
        log(() => table.dropIndex(index));
        return { message: `created index ${stmt.name} on ${stmt.table}(${stmt.column})`, rowsAffected: 0 };
      }
      case 'dropIndex': {
        const found = this.findIndex(stmt.name);
        if (!found) {
          if (stmt.ifExists) return { message: `index "${stmt.name}" does not exist, skipped`, rowsAffected: 0 };
          throw new SqlError(`index "${stmt.name}" does not exist`);
        }
        found.table.dropIndex(found.index);
        log(() => found.table.indexes.push(found.index));
        return { message: `dropped index ${stmt.name}`, rowsAffected: 0 };
      }
      case 'begin':
        if (this.transaction) throw new SqlError('a transaction is already in progress');
        this.transaction = [];
        return { message: 'transaction started', rowsAffected: 0 };
      case 'commit':
        if (!this.transaction) throw new SqlError('no transaction is in progress');
        this.transaction = null;
        return { message: 'transaction committed', rowsAffected: 0 };
      case 'rollback': {
        if (!this.transaction) throw new SqlError('no transaction is in progress');
        const actions = this.transaction;
        this.transaction = null;
        for (let i = actions.length - 1; i >= 0; i--) actions[i]();
        return { message: 'transaction rolled back', rowsAffected: 0 };
      }
    }
  }

  private findIndex(name: string): { table: Table; index: Index } | null {
    for (const table of this.tables.values()) {
      const index = table.indexes.find((i) => i.name === name);
      if (index) return { table, index };
    }
    return null;
  }

  private readonly subqueries: CompileContext = {
    subquery: (select) => [...planSelect(this, select).plan.run()],
  };

  private insert(stmt: Extract<Statement, { kind: 'insert' }>, log: UndoLog): Outcome {
    const table = this.getTable(stmt.table);
    const targets = (stmt.columns ?? table.columns.map((c) => c.name)).map((name) => {
      const i = table.columnIndex(name);
      if (i < 0) throw new SqlError(`column "${name}" does not exist in table "${table.name}"`);
      return i;
    });
    if (new Set(targets).size !== targets.length) throw new SqlError('column specified more than once');

    for (const exprs of stmt.rows) {
      if (exprs.length !== targets.length) {
        throw new SqlError(`INSERT has ${exprs.length} values but ${targets.length} target columns`);
      }
      const row: Row = table.columns.map((c) => c.default);
      exprs.forEach((e, i) => (row[targets[i]] = compile(e, [], this.subqueries)([])));
      table.insert(row, log);
    }
    const n = stmt.rows.length;
    return { message: `inserted ${n} row${n === 1 ? '' : 's'}`, rowsAffected: n };
  }

  /** Find the rows a WHERE clause selects, using an index when one applies. */
  private matching(table: Table, where: Expr | undefined) {
    const { scan, residual } = planAccess(table, table.name, splitConjuncts(where));
    const predicate = residual.length ? compile(andAll(residual), scan.schema, this.subqueries) : null;
    // Materialise first: mutating a table while scanning it would corrupt the iteration.
    const matches: [number, Row][] = [];
    for (const entry of scan.scanIds()) {
      if (!predicate || toBool(predicate(entry[1])) === true) matches.push(entry);
    }
    return { matches, schema: scan.schema };
  }

  private update(stmt: Extract<Statement, { kind: 'update' }>, log: UndoLog): Outcome {
    const table = this.getTable(stmt.table);
    const { matches, schema } = this.matching(table, stmt.where);
    const setters = stmt.set.map(({ column, expr }) => {
      const i = table.columnIndex(column);
      if (i < 0) throw new SqlError(`column "${column}" does not exist in table "${table.name}"`);
      return { i, value: compile(expr, schema, this.subqueries) };
    });
    for (const [rowId, row] of matches) {
      const next = row.slice();
      // Every SET expression sees the row as it was before the update.
      for (const s of setters) next[s.i] = s.value(row);
      table.update(rowId, next, log);
    }
    const n = matches.length;
    return { message: `updated ${n} row${n === 1 ? '' : 's'}`, rowsAffected: n };
  }

  private delete(stmt: Extract<Statement, { kind: 'delete' }>, log: UndoLog): Outcome {
    const table = this.getTable(stmt.table);
    const { matches } = this.matching(table, stmt.where);
    for (const [rowId] of matches) table.delete(rowId, log);
    const n = matches.length;
    return { message: `deleted ${n} row${n === 1 ? '' : 's'}`, rowsAffected: n };
  }
}
