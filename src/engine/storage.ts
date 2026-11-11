import { BPlusTree } from './btree';
import { compareValues, SqlError, typeName, type ColumnType, type Row, type Value } from './values';

export interface ColumnDef {
  name: string;
  type: ColumnType;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  default: Value;
}

/** Records how to reverse a mutation; used for statement atomicity and ROLLBACK. */
export type UndoLog = (undo: () => void) => void;

/**
 * Index entries are keyed by (column value, row id). Including the row id makes
 * every key unique, so one B+tree implementation serves unique and non-unique indexes.
 */
type IndexKey = [Value, number];

const compareIndexKeys = (a: IndexKey, b: IndexKey) => compareValues(a[0], b[0]) || a[1] - b[1];

export class Index {
  readonly tree = new BPlusTree<IndexKey, number>(compareIndexKeys);

  constructor(
    readonly name: string,
    readonly tableName: string,
    readonly column: number,
    readonly columnName: string,
    readonly unique: boolean,
  ) {}

  // NULLs are not indexed: no index lookup can match them, and UNIQUE permits many NULLs.
  add(value: Value, rowId: number): void {
    if (value !== null) this.tree.insert([value, rowId], rowId);
  }

  remove(value: Value, rowId: number): void {
    if (value !== null) this.tree.delete([value, rowId]);
  }

  /** Row ids whose value falls in the given range, in index order. */
  *scan(lo?: Value, loInclusive = true, hi?: Value, hiInclusive = true): Generator<number> {
    const loKey: IndexKey | undefined =
      lo === undefined ? undefined : [lo, loInclusive ? -Infinity : Infinity];
    const hiKey: IndexKey | undefined =
      hi === undefined ? undefined : [hi, hiInclusive ? Infinity : -Infinity];
    for (const [, rowId] of this.tree.range(loKey, hiKey)) yield rowId;
  }

  hasValue(value: Value, exceptRowId?: number): boolean {
    for (const rowId of this.scan(value, true, value, true)) {
      if (rowId !== exceptRowId) return true;
    }
    return false;
  }
}

export class Table {
  /** Heap storage: row id -> row. A Map iterates in insertion order. */
  readonly rows = new Map<number, Row>();
  readonly indexes: Index[] = [];
  private nextRowId = 1;
  /** Position of an INTEGER PRIMARY KEY column that auto-increments, or -1. */
  private readonly autoColumn: number;
  private autoNext = 1;
  private readonly columnPositions = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly columns: ColumnDef[],
  ) {
    columns.forEach((c, i) => {
      if (this.columnPositions.has(c.name)) {
        throw new SqlError(`duplicate column "${c.name}" in table "${name}"`);
      }
      this.columnPositions.set(c.name, i);
    });
    const pks = columns.filter((c) => c.primaryKey);
    if (pks.length > 1) throw new SqlError(`table "${name}" has more than one primary key`);
    this.autoColumn = columns.findIndex((c) => c.primaryKey && c.type === 'INTEGER');

    columns.forEach((c, i) => {
      if (c.primaryKey) this.indexes.push(new Index(`${name}_pkey`, name, i, c.name, true));
      else if (c.unique) this.indexes.push(new Index(`${name}_${c.name}_key`, name, i, c.name, true));
    });
  }

  columnIndex(name: string): number {
    return this.columnPositions.get(name) ?? -1;
  }

  /** Type-check a value against a column, applying the few implicit conversions we allow. */
  private coerce(col: ColumnDef, value: Value): Value {
    if (value === null) {
      if (col.notNull || col.primaryKey) {
        throw new SqlError(`null value in column "${col.name}" violates NOT NULL constraint`);
      }
      return null;
    }
    const ok =
      (col.type === 'INTEGER' && typeof value === 'number' && Number.isInteger(value)) ||
      (col.type === 'REAL' && typeof value === 'number') ||
      (col.type === 'TEXT' && typeof value === 'string') ||
      (col.type === 'BOOLEAN' && typeof value === 'boolean');
    if (!ok) {
      throw new SqlError(
        `column "${col.name}" is ${col.type} but the value ${JSON.stringify(value)} is ${typeName(value)}`,
      );
    }
    return value;
  }

  private checkRow(input: Row, exceptRowId?: number): Row {
    const row = this.columns.map((col, i) => this.coerce(col, input[i]));
    for (const index of this.indexes) {
      const v = row[index.column];
      if (index.unique && v !== null && index.hasValue(v, exceptRowId)) {
        throw new SqlError(
          `duplicate value ${JSON.stringify(v)} violates unique constraint "${index.name}"`,
        );
      }
    }
    return row;
  }

  insert(input: Row, log?: UndoLog): number {
    const values = input.slice();
    if (this.autoColumn >= 0 && values[this.autoColumn] === null) {
      values[this.autoColumn] = this.autoNext;
    }
    const row = this.checkRow(values);
    if (this.autoColumn >= 0) {
      this.autoNext = Math.max(this.autoNext, (row[this.autoColumn] as number) + 1);
    }
    const rowId = this.nextRowId++;
    this.rawInsert(rowId, row);
    log?.(() => this.rawDelete(rowId));
    return rowId;
  }

  update(rowId: number, input: Row, log?: UndoLog): void {
    const old = this.rows.get(rowId)!;
    const row = this.checkRow(input, rowId);
    this.rawDelete(rowId);
    this.rawInsert(rowId, row);
    log?.(() => {
      this.rawDelete(rowId);
      this.rawInsert(rowId, old);
    });
  }

  delete(rowId: number, log?: UndoLog): void {
    const old = this.rows.get(rowId)!;
    this.rawDelete(rowId);
    log?.(() => this.rawInsert(rowId, old));
  }

  private rawInsert(rowId: number, row: Row): void {
    this.rows.set(rowId, row);
    for (const index of this.indexes) index.add(row[index.column], rowId);
  }

  private rawDelete(rowId: number): void {
    const row = this.rows.get(rowId);
    if (!row) return;
    this.rows.delete(rowId);
    for (const index of this.indexes) index.remove(row[index.column], rowId);
  }

  /** Build a new index over the existing rows. */
  createIndex(name: string, columnName: string, unique: boolean): Index {
    const column = this.columnIndex(columnName);
    if (column < 0) throw new SqlError(`column "${columnName}" does not exist in table "${this.name}"`);
    const index = new Index(name, this.name, column, columnName, unique);
    for (const [rowId, row] of this.rows) {
      const v = row[column];
      if (unique && v !== null && index.hasValue(v)) {
        throw new SqlError(
          `cannot create unique index "${name}": duplicate value ${JSON.stringify(v)} in column "${columnName}"`,
        );
      }
      index.add(v, rowId);
    }
    this.indexes.push(index);
    return index;
  }

  dropIndex(index: Index): void {
    const i = this.indexes.indexOf(index);
    if (i >= 0) this.indexes.splice(i, 1);
  }
}
