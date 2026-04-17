/**
 * Merkle-Addressed Semantic Fingerprint (v0.62 d.1) — structural
 * addressing layer for the Project Knowledge Index. Every symbol
 * becomes a leaf with a content hash; every file becomes an interior
 * node aggregating its leaves' hashes + embeddings; the root is a
 * single fingerprint that changes iff any symbol in the workspace
 * changed.
 *
 * This primitive is static (build it, query it); keystroke-live
 * updates and integration with `SymbolEmbeddingIndex` land in d.2
 * and d.3. Keeping the tree as a pure data structure here means the
 * wiring layers can test against it without spinning up the full
 * embedding pipeline.
 *
 * Tree shape (MVP — 3 levels):
 *   leaves   symbol per chunk
 *   level 1  one file node per file, aggregating all symbols in it
 *   root     one root aggregating all file nodes
 *
 * Future work extends this to a directory-aware hierarchy so the
 * root's fanout doesn't blow up on >10k-file workspaces. For now,
 * flat fanout is fine — scoring 5000 file nodes at the root level
 * is still sub-ms with a pure cosine scan.
 *
 * Hashing: SHA-256 for MVP. The ROADMAP calls for blake3 as the
 * default with sha256 as a fallback — we ship the fallback now and
 * add a blake3 adapter later, same pattern as the PKI backend
 * abstraction (`VectorStore` interface; flat store first, Lance
 * later).
 */

import * as crypto from 'crypto';

const HASH_ALGO = 'sha256';
/** Separator for canonical-string construction. `|` is rare in
 *  code bodies; a collision would only affect determinism of the
 *  hash, not correctness of retrieval. */
const HASH_SEP = '|';

export interface MerkleLeaf {
  /** Deterministic ID — `filePath::qualifiedName`. */
  id: string;
  /** Workspace-relative file the symbol lives in. Groups leaves
   *  into file nodes during tree construction. */
  filePath: string;
  /** Hash over the leaf's content — changes iff body, kind, or
   *  range changes. Computed via `hashLeaf`. */
  hash: string;
  /** Unit-length embedding of the symbol body. Interior nodes
   *  aggregate these for query-time descent. */
  vector: Float32Array;
  /** Pass-through metadata for the descent layer to surface in
   *  retrieval results without re-reading the source. */
  metadata: {
    qualifiedName: string;
    kind: string;
    startLine: number;
    endLine: number;
  };
}

export interface MerkleFileNode {
  filePath: string;
  /** Aggregated hash over this file's leaf hashes (sorted by leaf
   *  ID for determinism). */
  hash: string;
  /** Mean-pooled unit vector over all children's vectors. Used by
   *  `descend` to prune uninteresting file subtrees without
   *  scoring their leaves. */
  aggregatedVector: Float32Array;
  /** IDs of the leaves in this file. */
  childIds: string[];
}

/**
 * Result of a `descend(queryVec, k)` call. `pickedFiles` carries
 * the file subtrees whose aggregated vectors scored in the top-k;
 * `leafIds` flattens those subtrees to the leaf level for downstream
 * HNSW / flat scanning. Returning both means the caller can either
 * render a file-level summary or expand to the leaf layer as needed.
 */
export interface MerkleDescendResult {
  pickedFiles: Array<{ filePath: string; score: number }>;
  leafIds: string[];
}

/**
 * Produce the canonical string that feeds the leaf hash. Separated
 * so tests can pin its shape — changes here invalidate every
 * previously-computed leaf hash, which is what we want on schema
 * bumps and what we DON'T want on incidental refactors.
 */
export function canonicalLeafString(input: {
  filePath: string;
  qualifiedName: string;
  kind: string;
  startLine: number;
  endLine: number;
  body: string;
}): string {
  return [input.filePath, input.qualifiedName, input.kind, `${input.startLine}-${input.endLine}`, input.body].join(
    HASH_SEP,
  );
}

/** Compute the leaf content hash. */
export function hashLeaf(input: {
  filePath: string;
  qualifiedName: string;
  kind: string;
  startLine: number;
  endLine: number;
  body: string;
}): string {
  return crypto.createHash(HASH_ALGO).update(canonicalLeafString(input)).digest('hex');
}

/**
 * Aggregate multiple child hashes into a single parent hash. Sorts
 * inputs before concatenating so the result is order-independent —
 * two trees with the same leaves in different insertion orders
 * produce the same root hash.
 */
export function hashAggregate(childHashes: string[]): string {
  const sorted = [...childHashes].sort();
  return crypto.createHash(HASH_ALGO).update(sorted.join(HASH_SEP)).digest('hex');
}

/**
 * Mean-pool a set of unit vectors into a single aggregated unit
 * vector. Dimension is taken from the first vector — callers must
 * ensure every input has the same dimension or behavior is
 * undefined (we don't want to pay a length check on every pool).
 *
 * Returns a fresh Float32Array so callers can't mutate the
 * computed pool through an aliasing surprise.
 */
export function meanPoolVectors(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) return new Float32Array(0);
  const dim = vectors[0].length;
  const sum = new Float32Array(dim);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  // Mean + normalize to unit length. For nearly-zero sums (all
  // input vectors cancel) we return the raw mean — downstream
  // cosine math will produce 0 similarity, which is what you'd
  // want for an empty-information node.
  let normSq = 0;
  for (let i = 0; i < dim; i++) {
    sum[i] /= vectors.length;
    normSq += sum[i] * sum[i];
  }
  const norm = Math.sqrt(normSq);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) sum[i] /= norm;
  }
  return sum;
}

/**
 * The Merkle tree itself. Mutable by design — callers invoke
 * `addLeaf` / `removeLeaf` as the workspace changes, then
 * `rebuild()` to refresh file-node aggregations + root hash. The
 * dirty set means rebuilds only touch affected files; untouched
 * files keep their precomputed aggregation.
 */
export class MerkleTree {
  private leaves = new Map<string, MerkleLeaf>();
  private fileNodes = new Map<string, MerkleFileNode>();
  private rootHash = '';
  private dirtyFiles = new Set<string>();
  private dimension = 0;

  /** Add or replace a leaf. Marks its file as dirty for next
   *  rebuild. Safe to call repeatedly with the same ID — latest
   *  wins. */
  addLeaf(leaf: MerkleLeaf): void {
    if (this.dimension === 0) this.dimension = leaf.vector.length;
    else if (leaf.vector.length !== this.dimension) {
      throw new Error(
        `MerkleTree.addLeaf: vector length ${leaf.vector.length} does not match tree dimension ${this.dimension}`,
      );
    }
    // If the leaf's filePath changed (symbol moved across files),
    // mark both the old and new file dirty so both nodes rebuild.
    const existing = this.leaves.get(leaf.id);
    if (existing && existing.filePath !== leaf.filePath) {
      this.dirtyFiles.add(existing.filePath);
    }
    this.leaves.set(leaf.id, leaf);
    this.dirtyFiles.add(leaf.filePath);
  }

  /** Remove a leaf. Returns true iff something was removed. */
  removeLeaf(id: string): boolean {
    const leaf = this.leaves.get(id);
    if (!leaf) return false;
    this.leaves.delete(id);
    this.dirtyFiles.add(leaf.filePath);
    return true;
  }

  /** Drop every leaf under a file — used when a file is deleted
   *  or renamed, when per-leaf calls would be wasteful. Returns
   *  the number of leaves dropped. */
  removeFile(filePath: string): number {
    let removed = 0;
    for (const [id, leaf] of this.leaves.entries()) {
      if (leaf.filePath === filePath) {
        this.leaves.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) this.dirtyFiles.add(filePath);
    return removed;
  }

  /**
   * Refresh every file node marked dirty, then recompute the root
   * hash from all file nodes. Pure — idempotent, no disk I/O.
   *
   * The caller decides when to rebuild: after a batch of updates
   * to amortize cost, or immediately after each edit for
   * keystroke-live semantics. d.2 wires the event-driven side.
   */
  rebuild(): void {
    for (const filePath of this.dirtyFiles) {
      this.rebuildFileNode(filePath);
    }
    this.dirtyFiles.clear();
    this.recomputeRoot();
  }

  private rebuildFileNode(filePath: string): void {
    const leavesInFile = [...this.leaves.values()].filter((l) => l.filePath === filePath);
    if (leavesInFile.length === 0) {
      this.fileNodes.delete(filePath);
      return;
    }
    // Sort by leaf ID for deterministic aggregation.
    leavesInFile.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const hash = hashAggregate(leavesInFile.map((l) => l.hash));
    const aggregatedVector = meanPoolVectors(leavesInFile.map((l) => l.vector));
    this.fileNodes.set(filePath, {
      filePath,
      hash,
      aggregatedVector,
      childIds: leavesInFile.map((l) => l.id),
    });
  }

  private recomputeRoot(): void {
    const hashes = [...this.fileNodes.values()].map((n) => n.hash);
    this.rootHash = hashes.length === 0 ? '' : hashAggregate(hashes);
  }

  /** Current root hash — empty string iff the tree has no leaves. */
  getRootHash(): string {
    return this.rootHash;
  }

  /** Total leaf count. */
  getLeafCount(): number {
    return this.leaves.size;
  }

  /** File-node count (live, not including deleted). */
  getFileNodeCount(): number {
    return this.fileNodes.size;
  }

  /** Look up a leaf by ID — null if not indexed. */
  getLeaf(id: string): MerkleLeaf | null {
    return this.leaves.get(id) ?? null;
  }

  /** Look up a file node by path. */
  getFileNode(filePath: string): MerkleFileNode | null {
    return this.fileNodes.get(filePath) ?? null;
  }

  /**
   * Score every file node's aggregated vector against `queryVec`,
   * pick the top-k files, and flatten their leaves into a single
   * ID list. Used by the descent-based retriever (d.3) to prune
   * uninteresting subtrees before doing leaf-level cosine.
   *
   * `k = 0` or an empty query returns empty. Cosine assumes both
   * sides are unit-length; vectors built via `meanPoolVectors` +
   * `SymbolEmbeddingIndex.embed` both normalize, so that holds.
   */
  descend(queryVec: Float32Array, k: number): MerkleDescendResult {
    if (k <= 0 || queryVec.length === 0 || this.fileNodes.size === 0) {
      return { pickedFiles: [], leafIds: [] };
    }
    const scored: Array<{ filePath: string; score: number }> = [];
    for (const node of this.fileNodes.values()) {
      scored.push({ filePath: node.filePath, score: cosine(queryVec, node.aggregatedVector) });
    }
    scored.sort((a, b) => b.score - a.score);
    const pickedFiles = scored.slice(0, k);
    const leafIds: string[] = [];
    for (const p of pickedFiles) {
      const node = this.fileNodes.get(p.filePath);
      if (node) leafIds.push(...node.childIds);
    }
    return { pickedFiles, leafIds };
  }
}

/** Cosine similarity for unit vectors. Inlined rather than imported
 *  from `vectorStore.ts` so this module stays standalone — callers
 *  that want to use just the Merkle primitive shouldn't need to
 *  pull in the whole PKI vector backend. */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}
