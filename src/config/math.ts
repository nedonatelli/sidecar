/**
 * Shared math primitives for the config/embedding layer.
 * Kept in a standalone module so vectorStore, embeddingIndex, and
 * merkleTree can all import without creating circular dependencies.
 */

/**
 * Cosine similarity between two unit vectors. Since embeddings are
 * L2-normalised before storage, this reduces to a dot product.
 * Truncates to the shorter input length so callers never need to
 * guard dimension mismatches explicitly.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}
