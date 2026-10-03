import { describe, it, expect } from 'vitest';
import {
  versionRequest,
  tagsRequest,
  parseRuntimeProvenance,
  formatRuntimeProvenance,
  fetchRuntimeProvenance,
  UNKNOWN_PROVENANCE,
} from './runtimeProvenance.js';

// Shapes copied from a live Ollama 0.34.2 on this workstation.
const VERSION = { version: '0.34.2' };
const TAGS = {
  models: [
    { name: 'llama3.2:latest', model: 'llama3.2:latest', digest: 'a'.repeat(64), size: 2019393189 },
    {
      name: 'gemma4:e4b',
      model: 'gemma4:e4b',
      digest: 'c6eb396dbd5992bbe3f5cdb947e8bbc0ee413d7c17e2beaae69f5d569cf982eb',
      size: 9608350718,
      modified_at: '2026-09-01T10:40:17.0175801-04:00',
    },
  ],
};

const ok = (body: unknown) => ({ ok: true, json: async () => body });

describe('request builders', () => {
  it('hits the documented endpoints and tolerates a trailing slash', () => {
    expect(versionRequest('http://127.0.0.1:11434').url).toBe('http://127.0.0.1:11434/api/version');
    expect(tagsRequest('http://127.0.0.1:11434///').url).toBe('http://127.0.0.1:11434/api/tags');
  });
});

describe('parseRuntimeProvenance', () => {
  it('pulls the version and the digest of the requested model, not the first one', () => {
    const p = parseRuntimeProvenance('gemma4:e4b', VERSION, TAGS);
    expect(p.ollamaVersion).toBe('0.34.2');
    expect(p.modelDigest).toBe('c6eb396dbd5992bbe3f5cdb947e8bbc0ee413d7c17e2beaae69f5d569cf982eb');
    expect(p.modelSizeBytes).toBe(9608350718);
    expect(p.modelModifiedAt).toBe('2026-09-01T10:40:17.0175801-04:00');
  });

  it('falls back to the `model` field when `name` is absent', () => {
    const tags = { models: [{ model: 'gemma4:e4b', digest: 'd'.repeat(64) }] };
    expect(parseRuntimeProvenance('gemma4:e4b', VERSION, tags).modelDigest).toBe('d'.repeat(64));
  });

  it('records a MISSING model as null rather than borrowing another entry', () => {
    const p = parseRuntimeProvenance('ministral-3:latest', VERSION, TAGS);
    expect(p.ollamaVersion).toBe('0.34.2');
    expect(p.modelDigest).toBeNull();
    expect(p.modelSizeBytes).toBeNull();
  });

  // The module exists because an unrecorded runtime change produced a five-fold
  // swing that nearly became a wrong conclusion. Degrading to null keeps "we do
  // not know" visible; throwing, or inventing a value, does not.
  it.each([
    ['null payloads', null, null],
    ['empty objects', {}, {}],
    ['wrong types', { version: 42 }, { models: 'nope' }],
    ['models not an array', VERSION, { models: { name: 'gemma4:e4b' } }],
  ])('degrades to null on %s instead of throwing', (_label, v, t) => {
    expect(() => parseRuntimeProvenance('gemma4:e4b', v, t)).not.toThrow();
    const p = parseRuntimeProvenance('gemma4:e4b', v, t);
    expect(p.modelDigest).toBeNull();
  });

  it('treats an empty version string as unknown', () => {
    expect(parseRuntimeProvenance('gemma4:e4b', { version: '' }, TAGS).ollamaVersion).toBeNull();
  });
});

describe('formatRuntimeProvenance', () => {
  it('shortens the digest for a log line', () => {
    expect(formatRuntimeProvenance(parseRuntimeProvenance('gemma4:e4b', VERSION, TAGS))).toBe(
      'ollama 0.34.2 model c6eb396dbd59',
    );
  });

  it('says so when nothing was readable', () => {
    expect(formatRuntimeProvenance(UNKNOWN_PROVENANCE)).toBe('ollama version? model digest?');
  });
});

describe('fetchRuntimeProvenance', () => {
  it('combines both endpoints', async () => {
    const p = await fetchRuntimeProvenance('http://h:11434', 'gemma4:e4b', async (url) =>
      ok(url.endsWith('/api/version') ? VERSION : TAGS),
    );
    expect(p.ollamaVersion).toBe('0.34.2');
    expect(p.modelDigest).toMatch(/^c6eb396/);
  });

  // A provenance probe must never take a benchmark down on its way to recording
  // a version string. Each of these used to be a plausible way to do exactly that.
  it('returns nulls when the connection is refused', async () => {
    const p = await fetchRuntimeProvenance('http://h:11434', 'gemma4:e4b', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(p).toEqual(UNKNOWN_PROVENANCE);
  });

  it('returns nulls on a non-ok response', async () => {
    const p = await fetchRuntimeProvenance('http://h:11434', 'gemma4:e4b', async () => ({
      ok: false,
      json: async () => ({}),
    }));
    expect(p).toEqual(UNKNOWN_PROVENANCE);
  });

  it('returns nulls when the body is not JSON', async () => {
    const p = await fetchRuntimeProvenance('http://h:11434', 'gemma4:e4b', async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }));
    expect(p).toEqual(UNKNOWN_PROVENANCE);
  });

  it('gives up rather than hanging when the host never answers', async () => {
    const p = await fetchRuntimeProvenance('http://h:11434', 'gemma4:e4b', () => new Promise(() => {}) as never, 20);
    expect(p).toEqual(UNKNOWN_PROVENANCE);
  });

  it('keeps the half it could read when only one endpoint is down', async () => {
    const p = await fetchRuntimeProvenance('http://h:11434', 'gemma4:e4b', async (url) => {
      if (url.endsWith('/api/tags')) throw new Error('boom');
      return ok(VERSION);
    });
    expect(p.ollamaVersion).toBe('0.34.2');
    expect(p.modelDigest).toBeNull();
  });
});
