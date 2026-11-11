import type { PlanInfo } from '../engine';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export const formatMs = (ms: number) =>
  ms >= 100 ? `${ms.toFixed(0)} ms` : ms >= 1 ? `${ms.toFixed(1)} ms` : `${ms.toFixed(2)} ms`;

function kindOf(name: string): string {
  if (name.includes('Index Scan')) return 'index';
  if (name.includes('Seq Scan')) return 'scan';
  if (name.includes('Join')) return 'join';
  if (name.includes('Aggregate')) return 'agg';
  return 'other';
}

/** Time spent in the operator itself, excluding the children it pulled rows from. */
const selfTime = (node: PlanInfo) =>
  Math.max(0, node.timeMs - node.children.reduce((sum, c) => sum + c.timeMs, 0));

function flatten(node: PlanInfo): PlanInfo[] {
  return [node, ...node.children.flatMap(flatten)];
}

/**
 * Render an executed plan as a tree. Data flows upward: leaves read tables,
 * each parent consumes its children's rows.
 */
export function renderPlan(plan: PlanInfo, executed: boolean, statement: string): HTMLElement {
  const root = el('div');
  const all = flatten(plan);
  const total = Math.max(plan.timeMs, 1e-9);
  const hottest = executed ? all.reduce((a, b) => (selfTime(b) > selfTime(a) ? b : a)) : null;

  const head = el('div', 'plan-head');
  head.append(el('strong', undefined, executed ? 'Executed plan' : 'Estimated plan (not executed)'));
  if (executed) {
    head.append(
      el('span', undefined, `${all.length} operator${all.length === 1 ? '' : 's'}`),
      el('span', undefined, `total ${formatMs(plan.timeMs)}`),
      el('span', undefined, 'bars show each operator’s own share of the time'),
    );
  }
  head.title = statement;
  root.append(head);

  const build = (node: PlanInfo): HTMLLIElement => {
    const li = el('li');
    const card = el('div', 'plan-node');
    card.dataset.kind = kindOf(node.name);
    if (node === hottest && all.length > 1) card.classList.add('hot');

    const op = el('span', 'op');
    op.append(el('i'), node.name);
    card.append(op);

    const metrics = el('span', 'metrics');
    if (executed) {
      const rows = el('b', undefined, node.rows.toLocaleString('en-US'));
      metrics.append(rows, ` row${node.rows === 1 ? '' : 's'} · ${formatMs(node.timeMs)}`);
    }
    card.append(metrics);
    if (node.detail) card.append(el('span', 'detail', node.detail));
    if (executed) {
      const bar = el('div', 'bar');
      const fill = el('span');
      fill.style.width = `${Math.min(100, (selfTime(node) / total) * 100).toFixed(1)}%`;
      bar.append(fill);
      card.append(bar);
    }
    li.append(card);

    if (node.children.length) {
      const ul = el('ul');
      node.children.forEach((child) => ul.append(build(child)));
      li.append(ul);
    }
    return li;
  };

  const tree = el('ul', 'plan-tree');
  tree.append(build(plan));
  root.append(tree);
  return root;
}
