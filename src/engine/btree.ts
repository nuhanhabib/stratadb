/**
 * An in-memory B+tree.
 *
 * - All entries live in the leaves; internal nodes hold separator keys only.
 * - Leaves are chained left-to-right, so range scans are a descent plus a linked-list walk.
 * - Deletion rebalances by borrowing from a sibling or merging, keeping every
 *   non-root node at least half full.
 *
 * Invariant for an internal node: every key in `children[i]` is < `keys[i]`, and
 * every key in `children[i + 1]` is >= `keys[i]`.
 */
export interface BTreeNode<K, V> {
  leaf: boolean;
  keys: K[];
  /** Leaf only: `values[i]` belongs to `keys[i]`. */
  values: V[];
  /** Internal only: `children.length === keys.length + 1`. */
  children: BTreeNode<K, V>[];
  /** Leaf only: the next leaf to the right. */
  next: BTreeNode<K, V> | null;
}

export class BPlusTree<K, V> {
  root: BTreeNode<K, V>;
  size = 0;
  readonly maxKeys: number;
  readonly minKeys: number;

  /**
   * @param compare total order over keys
   * @param order   maximum number of children per internal node (>= 3)
   */
  constructor(
    private readonly compare: (a: K, b: K) => number,
    public readonly order = 64,
  ) {
    if (order < 3) throw new Error('B+tree order must be at least 3');
    this.maxKeys = order - 1;
    this.minKeys = Math.floor(this.maxKeys / 2);
    this.root = this.makeLeaf();
  }

  private makeLeaf(): BTreeNode<K, V> {
    return { leaf: true, keys: [], values: [], children: [], next: null };
  }

  /** First index whose key is >= `key`. */
  private lowerBound(keys: K[], key: K): number {
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compare(keys[mid], key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** First index whose key is > `key`; also the child to descend into. */
  private upperBound(keys: K[], key: K): number {
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compare(keys[mid], key) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private findLeaf(key: K): BTreeNode<K, V> {
    let node = this.root;
    while (!node.leaf) node = node.children[this.upperBound(node.keys, key)];
    return node;
  }

  get(key: K): V | undefined {
    const leaf = this.findLeaf(key);
    const i = this.lowerBound(leaf.keys, key);
    return i < leaf.keys.length && this.compare(leaf.keys[i], key) === 0 ? leaf.values[i] : undefined;
  }

  has(key: K): boolean {
    const leaf = this.findLeaf(key);
    const i = this.lowerBound(leaf.keys, key);
    return i < leaf.keys.length && this.compare(leaf.keys[i], key) === 0;
  }

  /** Insert or overwrite. Returns true if the key was not present before. */
  insert(key: K, value: V): boolean {
    const before = this.size;
    const split = this.insertInto(this.root, key, value);
    if (split) {
      this.root = {
        leaf: false,
        keys: [split.key],
        values: [],
        children: [this.root, split.right],
        next: null,
      };
    }
    return this.size > before;
  }

  private insertInto(
    node: BTreeNode<K, V>,
    key: K,
    value: V,
  ): { key: K; right: BTreeNode<K, V> } | null {
    if (node.leaf) {
      const i = this.lowerBound(node.keys, key);
      if (i < node.keys.length && this.compare(node.keys[i], key) === 0) {
        node.values[i] = value;
        return null;
      }
      node.keys.splice(i, 0, key);
      node.values.splice(i, 0, value);
      this.size++;
      if (node.keys.length <= this.maxKeys) return null;

      const mid = Math.ceil(node.keys.length / 2);
      const right = this.makeLeaf();
      right.keys = node.keys.splice(mid);
      right.values = node.values.splice(mid);
      right.next = node.next;
      node.next = right;
      return { key: right.keys[0], right };
    }

    const i = this.upperBound(node.keys, key);
    const split = this.insertInto(node.children[i], key, value);
    if (!split) return null;
    node.keys.splice(i, 0, split.key);
    node.children.splice(i + 1, 0, split.right);
    if (node.keys.length <= this.maxKeys) return null;

    // Split an internal node: the middle key moves up rather than being copied.
    const mid = Math.floor(node.keys.length / 2);
    const upKey = node.keys[mid];
    const right: BTreeNode<K, V> = {
      leaf: false,
      keys: node.keys.splice(mid + 1),
      values: [],
      children: node.children.splice(mid + 1),
      next: null,
    };
    node.keys.pop();
    return { key: upKey, right };
  }

  /** Remove a key. Returns true if it was present. */
  delete(key: K): boolean {
    const removed = this.deleteFrom(this.root, key);
    if (!this.root.leaf && this.root.keys.length === 0) this.root = this.root.children[0];
    return removed;
  }

  private deleteFrom(node: BTreeNode<K, V>, key: K): boolean {
    if (node.leaf) {
      const i = this.lowerBound(node.keys, key);
      if (i >= node.keys.length || this.compare(node.keys[i], key) !== 0) return false;
      node.keys.splice(i, 1);
      node.values.splice(i, 1);
      this.size--;
      return true;
    }
    const i = this.upperBound(node.keys, key);
    const child = node.children[i];
    const removed = this.deleteFrom(child, key);
    if (removed && child.keys.length < this.minKeys) this.rebalance(node, i);
    return removed;
  }

  /** Fix an underfull `parent.children[i]` by borrowing from a sibling or merging with one. */
  private rebalance(parent: BTreeNode<K, V>, i: number): void {
    const child = parent.children[i];
    const left = i > 0 ? parent.children[i - 1] : null;
    const right = i < parent.children.length - 1 ? parent.children[i + 1] : null;

    if (left && left.keys.length > this.minKeys) {
      if (child.leaf) {
        child.keys.unshift(left.keys.pop()!);
        child.values.unshift(left.values.pop()!);
        parent.keys[i - 1] = child.keys[0];
      } else {
        child.keys.unshift(parent.keys[i - 1]);
        parent.keys[i - 1] = left.keys.pop()!;
        child.children.unshift(left.children.pop()!);
      }
      return;
    }
    if (right && right.keys.length > this.minKeys) {
      if (child.leaf) {
        child.keys.push(right.keys.shift()!);
        child.values.push(right.values.shift()!);
        parent.keys[i] = right.keys[0];
      } else {
        child.keys.push(parent.keys[i]);
        parent.keys[i] = right.keys.shift()!;
        child.children.push(right.children.shift()!);
      }
      return;
    }
    if (left) this.merge(parent, i - 1);
    else this.merge(parent, i);
  }

  /** Merge `parent.children[i + 1]` into `parent.children[i]`. */
  private merge(parent: BTreeNode<K, V>, i: number): void {
    const left = parent.children[i];
    const right = parent.children[i + 1];
    if (left.leaf) {
      left.keys.push(...right.keys);
      left.values.push(...right.values);
      left.next = right.next;
    } else {
      left.keys.push(parent.keys[i], ...right.keys);
      left.children.push(...right.children);
    }
    parent.keys.splice(i, 1);
    parent.children.splice(i + 1, 1);
  }

  /** Iterate entries with `lo <= key <= hi` in key order. Either bound may be omitted. */
  *range(lo?: K, hi?: K): Generator<[K, V]> {
    let leaf: BTreeNode<K, V> | null;
    let i: number;
    if (lo === undefined) {
      leaf = this.root;
      while (!leaf.leaf) leaf = leaf.children[0];
      i = 0;
    } else {
      leaf = this.findLeaf(lo);
      i = this.lowerBound(leaf.keys, lo);
    }
    while (leaf) {
      for (; i < leaf.keys.length; i++) {
        if (hi !== undefined && this.compare(leaf.keys[i], hi) > 0) return;
        yield [leaf.keys[i], leaf.values[i]];
      }
      leaf = leaf.next;
      i = 0;
    }
  }

  entries(): Generator<[K, V]> {
    return this.range();
  }

  height(): number {
    let h = 1;
    for (let node = this.root; !node.leaf; node = node.children[0]) h++;
    return h;
  }

  nodeCount(): number {
    const count = (n: BTreeNode<K, V>): number =>
      n.leaf ? 1 : 1 + n.children.reduce((sum, c) => sum + count(c), 0);
    return count(this.root);
  }

  /** Check every structural invariant; throws on the first violation. Used by the test suite. */
  validate(): void {
    let leafDepth = -1;
    let entries = 0;
    const check = (node: BTreeNode<K, V>, depth: number, lo?: K, hi?: K) => {
      if (node !== this.root && node.keys.length < this.minKeys) throw new Error('node underflow');
      if (node.keys.length > this.maxKeys) throw new Error('node overflow');
      for (let i = 0; i < node.keys.length; i++) {
        const k = node.keys[i];
        if (i > 0 && this.compare(node.keys[i - 1], k) >= 0) throw new Error('keys out of order');
        if (lo !== undefined && this.compare(k, lo) < 0) throw new Error('key below subtree bound');
        if (hi !== undefined && this.compare(k, hi) >= 0) throw new Error('key above subtree bound');
      }
      if (node.leaf) {
        if (leafDepth === -1) leafDepth = depth;
        else if (leafDepth !== depth) throw new Error('leaves at different depths');
        if (node.values.length !== node.keys.length) throw new Error('leaf keys/values mismatch');
        entries += node.keys.length;
        return;
      }
      if (node.children.length !== node.keys.length + 1) throw new Error('bad child count');
      node.children.forEach((c, i) =>
        check(c, depth + 1, i === 0 ? lo : node.keys[i - 1], i === node.keys.length ? hi : node.keys[i]),
      );
    };
    check(this.root, 0);
    if (entries !== this.size) throw new Error(`size mismatch: counted ${entries}, size ${this.size}`);

    let chained = 0;
    let prev: K | undefined;
    for (const [k] of this.entries()) {
      if (prev !== undefined && this.compare(prev, k) >= 0) throw new Error('leaf chain out of order');
      prev = k;
      chained++;
    }
    if (chained !== this.size) throw new Error('leaf chain does not cover all entries');
  }
}
