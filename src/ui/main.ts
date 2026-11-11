import './style.css';
import { Database, parse, SqlError, type PlanInfo, type QueryResult, type Value } from '../engine';
import { loadSampleData } from '../sample/ecommerce';
import { mountBTreeLab } from './btreeLab';
import { EXAMPLES } from './examples';
import { highlight } from './highlight';
import { formatMs, renderPlan } from './planView';

const MAX_ROWS_SHOWN = 500;
const STORAGE_KEY = 'stratadb.editor';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const editor = $<HTMLTextAreaElement>('sql');
const highlightLayer = $('highlight');
const resultsPane = $('output-results');
const planPane = $('output-plan');
const statusLine = $('status');
const schemaPane = $('schema');

let db = new Database();

// ---- editor ----------------------------------------------------------------

function syncHighlight(): void {
  highlightLayer.innerHTML = highlight(editor.value);
  highlightLayer.scrollTop = editor.scrollTop;
  highlightLayer.scrollLeft = editor.scrollLeft;
}

function setEditor(sql: string): void {
  editor.value = sql;
  editor.scrollTop = 0;
  syncHighlight();
  remember();
}

function remember(): void {
  try {
    localStorage.setItem(STORAGE_KEY, editor.value);
  } catch {
    /* storage may be unavailable (private mode); the editor works without it */
  }
}

editor.addEventListener('input', () => {
  syncHighlight();
  remember();
});
editor.addEventListener('scroll', () => {
  highlightLayer.scrollTop = editor.scrollTop;
  highlightLayer.scrollLeft = editor.scrollLeft;
});
editor.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    runEditor();
  } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
    syncHighlight();
    remember();
  }
});

// ---- running SQL -----------------------------------------------------------

function formatCell(value: Value): { text: string; cls: string } {
  if (value === null) return { text: 'NULL', cls: 'null' };
  if (typeof value === 'number') {
    // Trim binary floating-point noise such as 0.30000000000000004.
    return { text: String(Number.isInteger(value) ? value : parseFloat(value.toFixed(6))), cls: 'num' };
  }
  if (typeof value === 'boolean') return { text: String(value), cls: 'bool' };
  return { text: value, cls: '' };
}

function renderRows(result: Extract<QueryResult, { type: 'rows' }>): HTMLElement {
  const wrap = el('div');
  const isPlanText = result.columns.length === 1 && result.columns[0] === 'QUERY PLAN';
  const table = el('table', isPlanText ? 'grid plan-text' : 'grid');
  const shown = result.rows.slice(0, MAX_ROWS_SHOWN);

  const numeric = result.columns.map((_, i) => shown.some((r) => typeof r[i] === 'number'));
  const headRow = el('tr');
  result.columns.forEach((name, i) => headRow.append(el('th', numeric[i] ? 'num' : '', name)));
  const thead = el('thead');
  thead.append(headRow);

  const tbody = el('tbody');
  for (const row of shown) {
    const tr = el('tr');
    for (const value of row) {
      const { text, cls } = formatCell(value);
      tr.append(el('td', cls, text));
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);

  const scroller = el('div', 'table-wrap');
  scroller.append(table);
  wrap.append(scroller);
  if (result.rows.length === 0) wrap.append(el('div', 'note', 'No rows.'));
  else if (result.rows.length > shown.length) {
    wrap.append(
      el('div', 'note', `Showing the first ${shown.length.toLocaleString('en-US')} of ${result.rows.length.toLocaleString('en-US')} rows.`),
    );
  }
  return wrap;
}

function renderError(err: unknown, source: string): HTMLElement {
  const box = el('div', 'error-msg');
  const message = err instanceof Error ? err.message : String(err);
  box.textContent = err instanceof SqlError ? `Error: ${message}` : `Internal error: ${message}`;
  if (err instanceof SqlError && err.position !== undefined) {
    // Point at the offending character, compiler-style.
    const before = source.slice(0, err.position);
    const lineNo = before.split('\n').length;
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineEnd = source.indexOf('\n', err.position);
    const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    const gutter = `${lineNo} | `;
    const caret = ' '.repeat(gutter.length + (err.position - lineStart)) + '^';
    box.append(el('span', 'where', `${gutter}${line}\n${caret}`));
  }
  return box;
}

const oneLine = (sql: string) => sql.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();

function run(sql: string): void {
  resultsPane.replaceChildren();
  const started = performance.now();
  let lastPlan: { plan: PlanInfo; executed: boolean; statement: string } | null = null;
  let completed = 0;
  let failed = false;

  try {
    const statements = parse(sql);
    if (statements.length === 0) {
      resultsPane.append(el('div', 'placeholder', 'Nothing to run: the editor has no SQL statements.'));
    }
    for (const stmt of statements) {
      const block = el('div', 'result');
      const head = el('div', 'result-head');
      const label = el('code', undefined, oneLine(stmt.source ?? ''));
      label.title = stmt.source ?? '';
      head.append(label);
      block.append(head);
      resultsPane.append(block);
      try {
        const result = db.run(stmt);
        completed++;
        if (result.type === 'rows') {
          const n = result.rows.length;
          const isExplain = stmt.kind === 'explain';
          head.append(
            el('span', 'meta', isExplain ? formatMs(result.timeMs) : `${n.toLocaleString('en-US')} row${n === 1 ? '' : 's'} · ${formatMs(result.timeMs)}`),
          );
          block.append(renderRows(result));
          if (result.plan) {
            lastPlan = {
              plan: result.plan,
              executed: !(stmt.kind === 'explain' && !stmt.analyze),
              statement: stmt.source ?? '',
            };
          }
        } else {
          head.append(el('span', 'meta', formatMs(result.timeMs)));
          block.append(el('div', 'ok-msg', result.message));
        }
      } catch (err) {
        block.append(renderError(err, ''));
        failed = true;
        break;
      }
    }
  } catch (err) {
    // A syntax error anywhere means nothing ran.
    resultsPane.append(renderError(err, sql));
    failed = true;
  }

  if (lastPlan) {
    planPane.replaceChildren(renderPlan(lastPlan.plan, lastPlan.executed, lastPlan.statement));
  } else {
    planPane.replaceChildren(
      el('div', 'placeholder', 'Run a SELECT to see how the engine executed it: which indexes it used, how it joined, and where the time went.'),
    );
  }

  const elapsed = formatMs(performance.now() - started);
  const summary = failed
    ? `Stopped on an error after ${completed} statement${completed === 1 ? '' : 's'}`
    : `${completed} statement${completed === 1 ? '' : 's'} in ${elapsed}`;
  statusLine.textContent = db.inTransaction ? `${summary} · transaction open` : summary;
  statusLine.classList.toggle('txn', db.inTransaction);
  renderSchema();
}

/** Run the selected text if there is a selection, otherwise the whole editor. */
function runEditor(): void {
  const { selectionStart: a, selectionEnd: b, value } = editor;
  run(a !== b ? value.slice(a, b) : value);
}

// ---- schema browser --------------------------------------------------------

const openTables = new Set<string>();

function renderSchema(): void {
  const tables = db.schema();
  schemaPane.replaceChildren();
  if (tables.length === 0) {
    schemaPane.append(el('div', 'empty', 'No tables. Create one, or reset the database.'));
    return;
  }
  for (const table of tables) {
    const details = el('details');
    details.open = openTables.has(table.name);
    details.addEventListener('toggle', () => {
      if (details.open) openTables.add(table.name);
      else openTables.delete(table.name);
    });

    const summary = el('summary');
    summary.append(
      el('span', 'tname', table.name),
      el('span', 'count', `${table.rowCount.toLocaleString('en-US')} rows`),
    );
    details.append(summary);

    const list = el('ul');
    for (const col of table.columns) {
      const li = el('li');
      const flags = [col.type.toLowerCase(), col.primaryKey ? 'pk' : '', col.unique ? 'unique' : '', col.notNull && !col.primaryKey ? 'not null' : '']
        .filter(Boolean)
        .join(' · ');
      li.append(el('span', undefined, col.name), el('span', 'type', flags));
      list.append(li);
    }
    for (const index of table.indexes) {
      const li = el('li', 'index');
      li.title = `B+tree index on ${index.column}: ${index.entries.toLocaleString('en-US')} entries, height ${index.height}`;
      li.append(el('span', undefined, `⌁ ${index.name}`), el('span', 'type', 'index'));
      list.append(li);
    }
    details.append(list);

    const peek = el('button', 'peek', 'Preview rows');
    peek.addEventListener('click', () => {
      setEditor(`SELECT * FROM ${table.name} LIMIT 100;`);
      runEditor();
    });
    details.append(peek);
    schemaPane.append(details);
  }
}

// ---- examples, tabs, startup -----------------------------------------------

const examplesPane = $('examples');
for (const example of EXAMPLES) {
  const button = el('button');
  button.append(el('strong', undefined, example.title), el('span', undefined, example.blurb));
  button.addEventListener('click', () => {
    setEditor(example.sql);
    runEditor();
  });
  examplesPane.append(button);
}

function selectOutput(which: 'results' | 'plan'): void {
  for (const name of ['results', 'plan'] as const) {
    $(`tab-${name}`).setAttribute('aria-selected', String(name === which));
    $(`output-${name}`).hidden = name !== which;
  }
}
$('tab-results').addEventListener('click', () => selectOutput('results'));
$('tab-plan').addEventListener('click', () => selectOutput('plan'));

let labMounted = false;
function selectView(which: 'playground' | 'btree'): void {
  for (const name of ['playground', 'btree'] as const) {
    $(`tab-${name}`).setAttribute('aria-selected', String(name === which));
    $(`view-${name}`).hidden = name !== which;
  }
  if (which === 'btree' && !labMounted) {
    mountBTreeLab();
    labMounted = true;
  }
}
$('tab-playground').addEventListener('click', () => selectView('playground'));
$('tab-btree').addEventListener('click', () => selectView('btree'));

function resetDatabase(): void {
  db = new Database();
  loadSampleData(db);
  openTables.clear();
  openTables.add('orders');
}

$('run').addEventListener('click', runEditor);
$('reset').addEventListener('click', () => {
  resetDatabase();
  runEditor();
  statusLine.textContent = 'Database reset to the sample dataset';
});

if (/Mac|iPhone|iPad/.test(navigator.platform)) $('run-key').textContent = '⌘ ↵';

resetDatabase();
let initial = EXAMPLES[0].sql;
try {
  initial = localStorage.getItem(STORAGE_KEY) || initial;
} catch {
  /* ignore */
}
setEditor(initial);
runEditor();
