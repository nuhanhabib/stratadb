import { BPlusTree, type BTreeNode } from '../engine';

type Node = BTreeNode<number, number>;

const CELL = 36;
const NODE_H = 30;
const GAP_X = 16;
const LEVEL_H = 78;
const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

interface Placed {
  node: Node;
  x: number;
  y: number;
  width: number;
  children: Placed[];
}

/** Interactive visualisation of the engine's B+tree with a small node size. */
export function mountBTreeLab(): void {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const canvas = $('bt-canvas');
  const caption = $('bt-caption');
  const keyInput = $<HTMLInputElement>('bt-key');
  const orderSelect = $<HTMLSelectElement>('bt-order');

  let tree = new BPlusTree<number, number>((a, b) => a - b, Number(orderSelect.value));
  let lastKey: number | null = null;
  let nextSequential = 1;

  /** Nodes visited when searching for `key`, mirroring the tree's own descent. */
  const searchPath = (key: number): Set<Node> => {
    const path = new Set<Node>();
    let node = tree.root;
    for (;;) {
      path.add(node);
      if (node.leaf) return path;
      node = node.children[node.keys.filter((k) => k <= key).length];
    }
  };

  const draw = () => {
    const path = lastKey === null ? new Set<Node>() : searchPath(lastKey);
    let cursor = 0;
    let depthMax = 0;

    // Leaves are placed left to right; each internal node is centred over its children.
    const place = (node: Node, depth: number): Placed => {
      depthMax = Math.max(depthMax, depth);
      const width = Math.max(node.keys.length, 1) * CELL;
      const y = depth * LEVEL_H;
      if (node.leaf) {
        const placed = { node, x: cursor, y, width, children: [] };
        cursor += width + GAP_X;
        return placed;
      }
      const children = node.children.map((c) => place(c, depth + 1));
      const first = children[0];
      const last = children[children.length - 1];
      const centre = (first.x + first.width / 2 + last.x + last.width / 2) / 2;
      return { node, x: centre - width / 2, y, width, children };
    };
    const root = place(tree.root, 0);

    const width = Math.max(cursor - GAP_X, root.width);
    const height = depthMax * LEVEL_H + NODE_H;
    const pad = 4;
    const out = svg('svg', {
      width: width + pad * 2,
      height: height + pad * 2,
      viewBox: `${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}`,
      role: 'img',
      'aria-label': `B+tree with ${tree.size} keys and height ${tree.height()}`,
    });
    const edges = svg('g', {});
    const nodes = svg('g', {});
    out.append(edges, nodes);

    const leaves: Placed[] = [];
    const render = (p: Placed) => {
      const onPath = path.has(p.node);
      const g = svg('g', { class: `bt-node ${p.node.leaf ? 'leaf' : 'internal'}${onPath ? ' on-path' : ''}` });
      g.append(svg('rect', { x: p.x, y: p.y, width: p.width, height: NODE_H, rx: 6 }));
      p.node.keys.forEach((key, i) => {
        if (i > 0) {
          g.append(svg('line', { x1: p.x + i * CELL, y1: p.y + 5, x2: p.x + i * CELL, y2: p.y + NODE_H - 5 }));
        }
        const text = svg('text', { x: p.x + i * CELL + CELL / 2, y: p.y + NODE_H / 2 + 0.5 });
        if (p.node.leaf && key === lastKey) text.setAttribute('class', 'hit');
        text.textContent = String(key);
        g.append(text);
      });
      nodes.append(g);
      if (p.node.leaf) leaves.push(p);

      p.children.forEach((child, i) => {
        // Child i hangs from the boundary between key i-1 and key i.
        const x1 = p.x + i * CELL;
        const y1 = p.y + NODE_H;
        const x2 = child.x + child.width / 2;
        const y2 = child.y;
        const mid = (y1 + y2) / 2;
        edges.append(
          svg('path', {
            class: `bt-edge${onPath && path.has(child.node) ? ' on-path' : ''}`,
            d: `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`,
          }),
        );
        render(child);
      });
    };
    render(root);

    for (let i = 0; i + 1 < leaves.length; i++) {
      const a = leaves[i];
      const b = leaves[i + 1];
      const y = a.y + NODE_H / 2;
      edges.append(svg('path', { class: 'bt-chain', d: `M${a.x + a.width},${y} L${b.x},${y}` }));
    }
    canvas.replaceChildren(out);
  };

  const stats = () => {
    const nodes = tree.nodeCount();
    return `${tree.size} key${tree.size === 1 ? '' : 's'} · height ${tree.height()} · ${nodes} node${nodes === 1 ? '' : 's'}`;
  };

  const say = (html: string) => {
    caption.innerHTML = `${html} <span style="color:var(--muted)">— ${stats()}</span>`;
  };

  const insert = (key: number): boolean => {
    lastKey = key;
    return tree.insert(key, key);
  };

  const readKey = (): number | null => {
    const value = keyInput.value.trim();
    const key = Number(value);
    if (value === '' || !Number.isInteger(key) || Math.abs(key) > 9999) {
      caption.textContent = 'Enter a whole number between -9999 and 9999.';
      keyInput.focus();
      return null;
    }
    return key;
  };

  $('bt-insert').addEventListener('click', () => {
    const key = readKey();
    if (key === null) return;
    const before = tree.height();
    const added = insert(key);
    draw();
    if (!added) say(`<b>${key}</b> is already in the tree.`);
    else if (tree.height() > before) say(`Inserted <b>${key}</b>. The root was full and split, so the tree grew a level.`);
    else say(`Inserted <b>${key}</b>.`);
    keyInput.value = '';
    keyInput.focus();
  });

  $('bt-delete').addEventListener('click', () => {
    const key = readKey();
    if (key === null) return;
    const before = tree.height();
    lastKey = key;
    const removed = tree.delete(key);
    draw();
    if (!removed) say(`<b>${key}</b> is not in the tree; the highlighted path shows where it would be.`);
    else if (tree.height() < before) say(`Deleted <b>${key}</b>. Nodes merged all the way up, so the tree lost a level.`);
    else say(`Deleted <b>${key}</b>.`);
    keyInput.value = '';
    keyInput.focus();
  });

  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('bt-insert').click();
  });

  $('bt-random').addEventListener('click', () => {
    let added = 0;
    for (let attempts = 0; added < 10 && attempts < 500; attempts++) {
      if (insert(1 + Math.floor(Math.random() * 999))) added++;
    }
    draw();
    say(`Inserted ${added} random keys; the last was <b>${lastKey}</b>.`);
  });

  $('bt-sequence').addEventListener('click', () => {
    const from = nextSequential;
    for (let i = 0; i < 10; i++) insert(nextSequential++);
    draw();
    say(`Inserted <b>${from}–${nextSequential - 1}</b> in ascending order: only the rightmost leaf ever splits.`);
  });

  const reset = (message: string) => {
    tree = new BPlusTree<number, number>((a, b) => a - b, Number(orderSelect.value));
    lastKey = null;
    nextSequential = 1;
    draw();
    say(message);
  };
  $('bt-clear').addEventListener('click', () => reset('Tree cleared.'));
  orderSelect.addEventListener('change', () => {
    const keys = [...tree.entries()].map(([k]) => k);
    const next = nextSequential;
    reset('');
    keys.forEach((k) => tree.insert(k, k));
    nextSequential = next;
    draw();
    say(`Rebuilt with up to <b>${orderSelect.value}</b> children per node.`);
  });

  for (const key of [41, 7, 63, 18, 90, 29, 55, 3, 76, 34, 12, 68, 47, 85, 22]) tree.insert(key, key);
  draw();
  say('A starter tree. Try inserting a key, or add ten in order and watch the right edge split.');
}
