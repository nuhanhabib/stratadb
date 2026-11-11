import { SqlError } from './values';

export type TokenType =
  | 'keyword'
  | 'ident'
  | 'number'
  | 'string'
  | 'op'
  | 'punct'
  | 'comment'
  | 'ws'
  | 'error'
  | 'eof';

export interface Token {
  type: TokenType;
  /** Keywords are upper-cased, unquoted identifiers lower-cased, strings unescaped. */
  value: string;
  pos: number;
  end: number;
}

export const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'INDEX',
  'UNIQUE', 'ON', 'DROP', 'PRIMARY', 'KEY', 'NOT', 'NULL', 'DEFAULT', 'AND', 'OR',
  'IN', 'BETWEEN', 'LIKE', 'IS', 'AS', 'JOIN', 'INNER', 'LEFT', 'OUTER', 'CROSS',
  'DISTINCT', 'ASC', 'DESC', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'TRUE', 'FALSE',
  'EXPLAIN', 'ANALYZE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'IF', 'EXISTS',
]);

const TWO_CHAR_OPS = new Set(['<>', '!=', '<=', '>=', '||']);
const ONE_CHAR_OPS = new Set(['=', '<', '>', '+', '-', '*', '/', '%']);
const PUNCT = new Set(['(', ')', ',', ';', '.']);

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);

/**
 * Convert SQL text into tokens.
 *
 * With `trivia: true` the lexer never throws and also emits whitespace, comment
 * and error tokens, so the token stream covers every character of the input.
 * The playground's syntax highlighter relies on that mode.
 */
export function tokenize(sql: string, trivia = false): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  const push = (type: TokenType, value: string, pos: number, end: number) =>
    tokens.push({ type, value, pos, end });

  while (i < n) {
    const c = sql[i];
    const start = i;

    if (/\s/.test(c)) {
      while (i < n && /\s/.test(sql[i])) i++;
      if (trivia) push('ws', sql.slice(start, i), start, i);
      continue;
    }

    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      if (trivia) push('comment', sql.slice(start, i), start, i);
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(sql[i + 1] ?? ''))) {
      while (i < n && isDigit(sql[i])) i++;
      if (sql[i] === '.' && isDigit(sql[i + 1] ?? '')) {
        i++;
        while (i < n && isDigit(sql[i])) i++;
      }
      push('number', sql.slice(start, i), start, i);
      continue;
    }

    if (isIdentStart(c)) {
      while (i < n && isIdentPart(sql[i])) i++;
      const word = sql.slice(start, i);
      const upper = word.toUpperCase();
      if (KEYWORDS.has(upper)) push('keyword', upper, start, i);
      else push('ident', word.toLowerCase(), start, i);
      continue;
    }

    if (c === "'" || c === '"') {
      // 'string literal' or "quoted identifier"; the quote is escaped by doubling it.
      let value = '';
      let closed = false;
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            value += c;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += sql[i++];
      }
      if (!closed) {
        if (!trivia) {
          throw new SqlError(
            c === "'" ? 'unterminated string literal' : 'unterminated quoted identifier',
            start,
          );
        }
        push('error', sql.slice(start, i), start, i);
        continue;
      }
      push(c === "'" ? 'string' : 'ident', value, start, i);
      continue;
    }

    const two = sql.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      i += 2;
      push('op', two === '!=' ? '<>' : two, start, i);
      continue;
    }
    if (ONE_CHAR_OPS.has(c)) {
      i++;
      push('op', c, start, i);
      continue;
    }
    if (PUNCT.has(c)) {
      i++;
      push('punct', c, start, i);
      continue;
    }

    if (!trivia) throw new SqlError(`unexpected character '${c}'`, start);
    i++;
    push('error', c, start, i);
  }

  if (!trivia) push('eof', '', n, n);
  return tokens;
}
