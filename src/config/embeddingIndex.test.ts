import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { cosine, EmbeddingIndex } from './embeddingIndex.js';

describe('cosine', () => {
  it('returns 1 for identical unit vectors', () => {
    const v = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    // Normalize
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    const unit = new Float32Array(v.map((x) => x / norm));
    expect(cosine(unit, unit)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosine(a, b)).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosine(a, b)).toBeCloseTo(-1, 5);
  });

  it('computes correct similarity for arbitrary vectors', () => {
    // Dot product of [0.6, 0.8] and [1, 0] = 0.6
    // Both are unit vectors (0.6^2 + 0.8^2 = 1)
    const a = new Float32Array([0.6, 0.8]);
    const b = new Float32Array([1, 0]);
    expect(cosine(a, b)).toBeCloseTo(0.6, 5);
  });

  it('handles zero-length overlap gracefully', () => {
    const a = new Float32Array(0);
    const b = new Float32Array(0);
    expect(cosine(a, b)).toBe(0);
  });
});

describe('EmbeddingIndex', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-embed-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates an instance with no sidecarDir', () => {
    const index = new EmbeddingIndex(null);
    expect(index.isReady()).toBe(false);
    expect(index.getCount()).toBe(0);
  });

  it('isReady returns false before model loads', () => {
    const index = new EmbeddingIndex(null);
    expect(index.isReady()).toBe(false);
  });

  it('search returns empty when not ready', async () => {
    const index = new EmbeddingIndex(null);
    const results = await index.search('test query');
    expect(results).toEqual([]);
  });

  it('removeFile is a no-op for unknown paths', () => {
    const index = new EmbeddingIndex(null);
    // Should not throw
    index.removeFile('nonexistent.ts');
    expect(index.getCount()).toBe(0);
  });

  it('dispose cleans up timers without throwing', () => {
    const index = new EmbeddingIndex(null);
    // Should not throw even when nothing is initialized
    index.dispose();
  });

  it('queuePath reads file and queues update', () => {
    const filePath = path.join(tempDir, 'test.ts');
    fs.writeFileSync(filePath, 'export function hello() { return "world"; }');

    const index = new EmbeddingIndex(null);
    // Should not throw — queues the file for embedding
    index.queuePath('test.ts', tempDir);
    index.dispose(); // cleanup timer
  });

  it('queuePath silently ignores missing files', () => {
    const index = new EmbeddingIndex(null);
    // Should not throw for nonexistent file
    expect(() => index.queuePath('nonexistent.ts', tempDir)).not.toThrow();
    index.dispose();
  });

  it('removeFile decrements count for known paths', () => {
    // Access internal state to simulate a stored entry
    const index = new EmbeddingIndex(null);
    const meta = (index as unknown as { meta: { entries: Record<string, unknown>; count: number } }).meta;
    meta.entries['src/app.ts'] = { offset: 0, hash: 'abc123' };
    meta.count = 1;

    expect(index.getCount()).toBe(1);
    index.removeFile('src/app.ts');
    expect(index.getCount()).toBe(0);
  });
});
