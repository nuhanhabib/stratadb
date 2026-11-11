/** A single SQL value. `null` is SQL NULL. */
export type Value = number | string | boolean | null;
export type Row = Value[];
export type ColumnType = 'INTEGER' | 'REAL' | 'TEXT' | 'BOOLEAN';

/** Any error raised by the engine: syntax errors, constraint violations, type errors. */
export class SqlError extends Error {
  constructor(
    message: string,
    /** Character offset into the source SQL, when known. */
    public readonly position?: number,
  ) {
    super(message);
    this.name = 'SqlError';
  }
}

function typeRank(v: Value): number {
  if (v === null) return 0;
  switch (typeof v) {
    case 'boolean':
      return 1;
    case 'number':
      return 2;
    default:
      return 3;
  }
}

/**
 * Total order over SQL values, used by indexes and ORDER BY.
 * NULL sorts first; values of different types are ordered by type.
 */
export function compareValues(a: Value, b: Value): number {
  if (a === b) return 0;
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  return (a as number | string | boolean) < (b as number | string | boolean) ? -1 : 1;
}

export function typeName(v: Value): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isInteger(v) ? 'integer' : 'real';
    default:
      return 'text';
  }
}
