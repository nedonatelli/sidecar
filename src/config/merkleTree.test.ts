import { describe, it, expect } from 'vitest';
import {
  MerkleTree,
  canonicalLeafString,
  hashLeaf,
  hashAggregate,
  meanPoolVectors,
  type MerkleLeaf,
} from './merkleTree.js';

/**
 * Tests for the static Merkle tree primitive (v0.62 d.1). The live-
 * update wiring (d.2) and query-time descent integration (d.3) have
 * their own test files — this module is the pure data structure
 * layer and should stay that way.
 */

/** Build a normalized unit vector from a sparse value list — keeps
 *  test fixtures short. */
function unit(...values: number[]): Float32Array {
  const v = new Float32Array(values);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

function makeLeaf(overrides: Partial<MerkleLeaf> = {}): MerkleLeaf {
  const base: MerkleLeaf = {
    id: 'src/a.ts::foo',
    filePath: 'src/a.ts',
    hash: 'h0',
    vector: unit(1, 0, 0, 0),
    metadata: { qualifiedName: 'foo', kind: 'function', startLine: 1, endLine: 5 },
    ...overrides,
  };
  // When the caller didn't set `hash` explicitly, compute it from
  // the metadata so a leaf built by the helper always matches a
  // `hashLeaf({ ... })` call with the same inputs.
  if (overrides.hash === undefined) {
    base.hash = hashLeaf({
      filePath: base.filePath,
      qualifiedName: base.metadata.qualifiedName,
      kind: base.metadata.kind,
      startLine: base.metadata.startLine,
      endLine: base.metadata.endLine,
      body: 'body-' + base.id,
    });
  }
  return base;
}

describe('canonicalLeafString', () => {
  it('joins fields with a stable separator in a fixed order', () => {
    const s = canonicalLeafString({
      filePath: 'src/a.ts',
      qualifiedName: 'foo',
      kind: 'function',
      startLine: 1,
      endLine: 5,
      body: 'return 1;',
    });
    expect(s).toBe('src/a.ts|foo|function|1-5|return 1;');
  });
});

describe('hashLeaf', () => {
  it('is deterministic — same input → same hash', () => {
    const input = {
      filePath: 'a',
      qualifiedName: 'b',
      kind: 'function',
      startLine: 1,
      endLine: 2,
      body: 'c',
    };
    expect(hashLeaf(input)).toBe(hashLeaf(input));
  });

  it('changes when any field changes', () => {
    const base = { filePath: 'a', qualifiedName: 'b', kind: 'function', startLine: 1, endLine: 2, body: 'c' };
    const h = hashLeaf(base);
    expect(hashLeaf({ ...base, filePath: 'a2' })).not.toBe(h);
    expect(hashLeaf({ ...base, qualifiedName: 'b2' })).not.toBe(h);
    expect(hashLeaf({ ...base, kind: 'class' })).not.toBe(h);
    expect(hashLeaf({ ...base, startLine: 2 })).not.toBe(h);
    expect(hashLeaf({ ...base, endLine: 3 })).not.toBe(h);
    expect(hashLeaf({ ...base, body: 'c2' })).not.toBe(h);
  });

  it('produces a 64-char hex string (SHA-256)', () => {
    const h = hashLeaf({ filePath: 'a', qualifiedName: 'b', kind: 'fn', startLine: 1, endLine: 1, body: 'c' });
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hashAggregate', () => {
  it('is order-independent (inputs sorted before hashing)', () => {
    const a = hashAggregate(['h1', 'h2', 'h3']);
    const b = hashAggregate(['h3', 'h1', 'h2']);
    expect(a).toBe(b);
  });

  it('changes when the input set changes', () => {
    expect(hashAggregate(['h1', 'h2'])).not.toBe(hashAggregate(['h1', 'h2', 'h3']));
  });

  it('is stable across reruns', () => {
    const h = hashAggregate(['x', 'y']);
    expect(hashAggregate(['x', 'y'])).toBe(h);
  });
});

describe('meanPoolVectors', () => {
  it('returns an empty array for empty input', () => {
    expect(meanPoolVectors([]).length).toBe(0);
  });

  it('returns a normalized mean for a single input', () => {
    const v = unit(1, 0, 0, 0);
    const pooled = meanPoolVectors([v]);
    expect(pooled[0]).toBeCloseTo(1);
    expect(pooled[1]).toBeCloseTo(0);
  });

  it('averages multiple vectors and normalizes', () => {
    // Two orthogonal unit vectors — mean is (0.5, 0.5) pre-norm,
    // post-norm (1/√2, 1/√2).
    const pooled = meanPoolVectors([unit(1, 0, 0, 0), unit(0, 1, 0, 0)]);
    expect(pooled[0]).toBeCloseTo(Math.SQRT1_2);
    expect(pooled[1]).toBeCloseTo(Math.SQRT1_2);
    // Output should be unit length.
    let norm = 0;
    for (const x of pooled) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1);
  });

  it('handles a zero mean gracefully (no NaN)', () => {
    // Opposite unit vectors — their mean is the zero vector;
    // normalization would divide by zero, so we leave it as the
    // raw mean. No NaN allowed.
    const pooled = meanPoolVectors([unit(1, 0, 0, 0), unit(-1, 0, 0, 0)]);
    for (const x of pooled) expect(Number.isFinite(x)).toBe(true);
  });
});

describe('MerkleTree — leaf CRUD', () => {
  it('addLeaf stores the leaf and marks its file dirty', () => {
    const tree = new MerkleTree();
    tree.addLeaf(makeLeaf({ id: 'a.ts::foo', filePath: 'a.ts' }));
    tree.rebuild();
    expect(tree.getLeafCount()).toBe(1);
    expect(tree.getFileNodeCount()).toBe(1);
    expect(tree.getFileNode('a.ts')?.childIds).toEqual(['a.ts::foo']);
  });

  it('addLeaf overwrites an existing leaf by ID', () => {
    const tree = new MerkleTree();
    tree.addLeaf(makeLeaf({ id: 'a::b', vector: unit(1, 0, 0, 0) }));
    tree.addLeaf(makeLeaf({ id: 'a::b', vector: unit(0, 1, 0, 0) }));
    tree.rebuild();
    expect(tree.getLeafCount()).toBe(1);
    // The new vector should be reflected in the file node's aggregation.
    const node = tree.getFileNode('src/a.ts');
    expect(node?.aggregatedVector[1]).toBeCloseTo(1);
  });

  it('moving a leaf across files marks BOTH files dirty', () => {
    const tree = new MerkleTree();
    tree.addLeaf(makeLeaf({ id: 'x', filePath: 'old.ts' }));
    tree.rebuild();
    const rootBefore = tree.getRootHash();

    // Move to new file.
    tree.addLeaf(makeLeaf({ id: 'x', filePath: 'new.ts' }));
    tree.rebuild();
    expect(tree.getFileNode('old.ts')).toBeNull();
    expect(tree.getFileNode('new.ts')).not.toBeNull();
    expect(tree.getRootHash()).not.toBe(rootBefore);
  });

  it('removeLeaf returns true iff the leaf existed', () => {
    const tree = new MerkleTree();
    tree.addLeaf(makeLeaf({ id: 'x' }));
    expect(tree.removeLeaf('x')).toBe(true);
    expect(tree.removeLeaf('x')).toBe(false);
    tree.rebuild();
    expect(tree.getLeafCount()).toBe(0);
  });

  it('removeFile drops every leaf in the file and returns the count', () => {
    const tree = new MerkleTree();
    tree.addLeaf(makeLeaf({ id: 'a::1', filePath: 'a.ts' }));
    tree.addLeaf(makeLeaf({ id: 'a::2', filePath: 'a.ts' }));
    tree.addLeaf(makeLeaf({ id: 'b::1', filePath: 'b.ts' }));
    tree.rebuild();

    const removed = tree.removeFile('a.ts');
    expect(removed).toBe(2);
    tree.rebuild();

    expect(tree.getLeafCount()).toBe(1);
    expect(tree.getFileNode('a.ts')).toBeNull();
    expect(tree.getFileNode('b.ts')).not.toBeNull();
  });

  it('rejects a leaf whose vector dimension does not match the tree', () => {
    const tree = new MerkleTree();
    tree.addLeaf(makeLeaf({ id: 'first', vector: unit(1, 0, 0, 0) }));
    expect(() => tree.addLeaf(makeLeaf({ id: 'bad', vector: new Float32Array([1, 0, 0]) }))).toThrow(/dimension/);
  });
});

describe('MerkleTree — root hash', () => {
  it('root hash is empty string when the tree has no leaves', () => {
    const tree = new MerkleTree();
    tree.rebuild();
    expect(tree.getRootHash()).toBe('');
  });

  it('root hash is deterministic — same leaves → same root', () => {
    const tree1 = new MerkleTree();
    const tree2 = new MerkleTree();
    for (const leaf of [
      makeLeaf({ id: 'a::1', filePath: 'a.ts' }),
      makeLeaf({ id: 'a::2', filePath: 'a.ts' }),
      makeLeaf({ id: 'b::1', filePath: 'b.ts' }),
    ]) {
      tree1.addLeaf(leaf);
    }
    tree1.rebuild();

    // Insert in a different order — root should match.
    tree2.addLeaf(makeLeaf({ id: 'b::1', filePath: 'b.ts' }));
    tree2.addLeaf(makeLeaf({ id: 'a::2', filePath: 'a.ts' }));
    tree2.addLeaf(makeLeaf({ id: 'a::1', filePath: 'a.ts' }));
    tree2.rebuild();

    expect(tree1.getRootHash()).toBe(tree2.getRootHash());
  });

  it('root hash changes when any leaf hash changes', () => {
    const tree = new MerkleTree();
    tree.addLeaf(makeLeaf({ id: 'a', hash: 'h1' }));
    tree.addLeaf(makeLeaf({ id: 'b', hash: 'h2', filePath: 'b.ts' }));
    tree.rebuild();
    const rootBefore = tree.getRootHash();

    tree.addLeaf(makeLeaf({ id: 'a', hash: 'h1-updated' }));
    tree.rebuild();
    expect(tree.getRootHash()).not.toBe(rootBefore);
  });

  it('root hash restored when a change is reverted', () => {
    const tree = new MerkleTree();
    tree.addLeaf(makeLeaf({ id: 'a', hash: 'h1' }));
    tree.rebuild();
    const originalRoot = tree.getRootHash();

    // Mutate then revert — root should return to the original.
    tree.addLeaf(makeLeaf({ id: 'a', hash: 'h1-different' }));
    tree.rebuild();
    expect(tree.getRootHash()).not.toBe(originalRoot);

    tree.addLeaf(makeLeaf({ id: 'a', hash: 'h1' }));
    tree.rebuild();
    expect(tree.getRootHash()).toBe(originalRoot);
  });
});

describe('MerkleTree — file node aggregation', () => {
  it('mean-pools leaf vectors into the file-node aggregated vector', () => {
    const tree = new MerkleTree();
    tree.addLeaf(makeLeaf({ id: 'a.ts::x', filePath: 'a.ts', vector: unit(1, 0, 0, 0) }));
    tree.addLeaf(makeLeaf({ id: 'a.ts::y', filePath: 'a.ts', vector: unit(0, 1, 0, 0) }));
    tree.rebuild();
    const node = tree.getFileNode('a.ts')!;
    expect(node.aggregatedVector[0]).toBeCloseTo(Math.SQRT1_2);
    expect(node.aggregatedVector[1]).toBeCloseTo(Math.SQRT1_2);
  });

  it('file node hash is order-independent across its children', () => {
    const tree1 = new MerkleTree();
    const tree2 = new MerkleTree();
    // Identical leaves, different insertion order within a file.
    tree1.addLeaf(makeLeaf({ id: 'a::1', filePath: 'a.ts' }));
    tree1.addLeaf(makeLeaf({ id: 'a::2', filePath: 'a.ts' }));
    tree1.rebuild();

    tree2.addLeaf(makeLeaf({ id: 'a::2', filePath: 'a.ts' }));
    tree2.addLeaf(makeLeaf({ id: 'a::1', filePath: 'a.ts' }));
    tree2.rebuild();

    expect(tree1.getFileNode('a.ts')?.hash).toBe(tree2.getFileNode('a.ts')?.hash);
  });
});

describe('MerkleTree — descend', () => {
  it('picks the top-k files by aggregated-vector similarity', () => {
    const tree = new MerkleTree();
    // File a.ts pools to (1, 0, 0, 0); b.ts pools to (0, 1, 0, 0).
    tree.addLeaf(makeLeaf({ id: 'a::1', filePath: 'a.ts', vector: unit(1, 0, 0, 0) }));
    tree.addLeaf(makeLeaf({ id: 'b::1', filePath: 'b.ts', vector: unit(0, 1, 0, 0) }));
    tree.rebuild();

    const result = tree.descend(unit(1, 0, 0, 0), 1);
    expect(result.pickedFiles).toHaveLength(1);
    expect(result.pickedFiles[0].filePath).toBe('a.ts');
    expect(result.leafIds).toEqual(['a::1']);
  });

  it('top-k > file count returns every file', () => {
    const tree = new MerkleTree();
    tree.addLeaf(makeLeaf({ id: 'a::1', filePath: 'a.ts', vector: unit(1, 0, 0, 0) }));
    tree.addLeaf(makeLeaf({ id: 'b::1', filePath: 'b.ts', vector: unit(0, 1, 0, 0) }));
    tree.rebuild();
    const result = tree.descend(unit(1, 0, 0, 0), 5);
    expect(result.pickedFiles).toHaveLength(2);
    expect(result.leafIds).toEqual(expect.arrayContaining(['a::1', 'b::1']));
  });

  it('returns empty when k = 0 or the tree is empty', () => {
    const tree = new MerkleTree();
    expect(tree.descend(unit(1, 0, 0, 0), 5).pickedFiles).toEqual([]);
    tree.addLeaf(makeLeaf({ id: 'a', filePath: 'a.ts' }));
    tree.rebuild();
    expect(tree.descend(unit(1, 0, 0, 0), 0).pickedFiles).toEqual([]);
    expect(tree.descend(new Float32Array(0), 5).pickedFiles).toEqual([]);
  });

  it('emits leafIds in picked-file order', () => {
    const tree = new MerkleTree();
    tree.addLeaf(makeLeaf({ id: 'a::1', filePath: 'a.ts', vector: unit(1, 0, 0, 0) }));
    tree.addLeaf(makeLeaf({ id: 'a::2', filePath: 'a.ts', vector: unit(1, 0, 0, 0) }));
    tree.addLeaf(makeLeaf({ id: 'b::1', filePath: 'b.ts', vector: unit(0.5, 0.5, 0, 0) }));
    tree.rebuild();
    // Query matches a.ts strongly, b.ts weakly. Top-2 = a.ts then b.ts.
    const result = tree.descend(unit(1, 0, 0, 0), 2);
    expect(result.pickedFiles.map((p) => p.filePath)).toEqual(['a.ts', 'b.ts']);
    // Leaf IDs from a.ts should appear before b.ts.
    expect(result.leafIds.slice(0, 2).sort()).toEqual(['a::1', 'a::2']);
    expect(result.leafIds[2]).toBe('b::1');
  });
});
