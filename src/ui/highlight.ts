import { tokenize } from '../engine';

const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/**
 * Syntax-highlight SQL using the engine's own lexer, so the editor colours text
 * exactly the way the database will read it.
 */
export function highlight(sql: string): string {
  const tokens = tokenize(sql, true);
  let html = '';
  tokens.forEach((token, i) => {
    const text = escapeHtml(sql.slice(token.pos, token.end));
    let cls = '';
    switch (token.type) {
      case 'keyword':
      case 'string':
      case 'number':
      case 'comment':
      case 'error':
        cls = token.type;
        break;
      case 'ident': {
        const next = tokens[i + 1];
        if (next && next.type === 'punct' && next.value === '(' && sql[token.pos] !== '"') cls = 'func';
        break;
      }
    }
    html += cls ? `<span class="tok-${cls}">${text}</span>` : text;
  });
  // A trailing newline keeps the highlighted layer the same height as the textarea.
  return html + '\n';
}
