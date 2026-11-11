import { describe, expect, it } from 'vitest';
import { BPlusTree } from '../src/engine/btree';

const numeric = (a: number, b: number) => a - b;

/** Small deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe('BPlusTree', () => {
  it('stores and retrieves values', () => {
    const tree = new BPlusTree<number, string>(numeric, 4);
    for (let i = 0; i < 100; i++) tree.insert(i, `v${i}`);
    expect(tree.size).toBe(100);
    expect(tree.get(42)).toBe('v42');
    expect(tree.get(100)).toBeUndefined();
    expect(tree.height()).toBeGreaterThan(2);
    tree.validate();
  });

  it('overwrites existing keys without growing', () => {
    const tree = new BPlusTree<number, string>(numeric, 4);
    expect(tree.insert(1, 'a')).toBe(true);
    expect(tree.insert(1, 'b')).toBe(false);
    expect(tree.size).toBe(1);
    expect(tree.get(1)).toBe('b');
  });

  it('iterates in key order regardless of insertion order', () => {
    const tree = new BPlusTree<number, number>(numeric, 5);
    const keys = [50, 3, 99, 17, 42, 8, 77, 61, 25, 1, 90, 33];
    keys.forEach((k) => tree.insert(k, k * 2));
    expect([...tree.entries()].map(([k]) => k)).toEqual([...keys].sort(numeric));
  });

  it('supports inclusive range scans', () => {
    const tree = new BPlusTree<number, number>(numeric, 4);
    for (let i = 0; i < 200; i += 2) tree.insert(i, i);
    const keys = (lo?: number, hi?: number) => [...tree.range(lo, hi)].map(([k]) => k);
    expect(keys(10, 20)).toEqual([10, 12, 14, 16, 18, 20]);
    expect(keys(11, 19)).toEqual([12, 14, 16, 18]);
    expect(keys(undefined, 4)).toEqual([0, 2, 4]);
    expect(keys(194)).toEqual([194, 196, 198]);
    expect(keys(500)).toEqual([]);
    expect(keys(20, 10)).toEqual([]);
  });

  it('shrinks back to a single leaf when emptied', () => {
    const tree = new BPlusTree<number, number>(numeric, 4);
    for (let i = 0; i < 500; i++) tree.insert(i, i);
    for (let i = 0; i < 500; i++) {
      expect(tree.delete(i)).toBe(true);
      tree.validate();
    }
    expect(tree.size).toBe(0);
    expect(tree.height()).toBe(1);
    expect(tree.delete(1)).toBe(false);
  });

  // Model-based test: apply the same random operations to the tree and to a plain
  // Map, and require that they always agree and that every invariant holds.
  for (const order of [3, 4, 5, 8, 64]) {
    it(`matches a reference model under random operations (order ${order})`, () => {
      const random = rng(order * 7919);
      const tree = new BPlusTree<number, number>(numeric, order);
      const model = new Map<number, number>();
      for (let step = 0; step < 6000; step++) {
        const key = Math.floor(random() * 400);
        if (random() < 0.55) {
          expect(tree.insert(key, step)).toBe(!model.has(key));
          model.set(key, step);
        } else {
          expect(tree.delete(key)).toBe(model.delete(key));
        }
        if (step % 50 === 0) tree.validate();
      }
      tree.validate();
      const expected = [...model.entries()].sort((a, b) => a[0] - b[0]);
      expect([...tree.entries()]).toEqual(expected);
      const lo = 100;
      const hi = 250;
      expect([...tree.range(lo, hi)]).toEqual(expected.filter(([k]) => k >= lo && k <= hi));
    });
  }
});
