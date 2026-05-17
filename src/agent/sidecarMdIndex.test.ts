import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SidecarMdIndex } from './sidecarMdIndex.js';

// Deterministic fake embedder: returns a vector where dim[0] = char-code of
// first char of the first word in the text, normalised to unit length.
// This makes "build" and "Build" queries retrieve the Build section, etc.
function makeFakePipeline() {
  return vi.fn(async (texts: string[], _opts: unknown) => {
    const text = texts[0] ?? '';
    const dim = 384;
    const data = new Float32Array(dim);
    // Use the first non-space character to seed the vector so different
    // sections produce meaningfully different unit vectors.
    const seed = text.trim().charCodeAt(0) || 65;
    data[seed % dim] = 1.0; // unit vector with a single hot dimension
    return { data };
  });
}

function makeSidecarDir() {
  return {
    isReady: () => false, // disables persist/restore
    getPath: (..._: string[]) => '',
    writeJson: vi.fn(),
    readJson: vi.fn(() => null),
  };
}

const BASIC_CONTENT = `
# My Project

Preamble text here.

## Build

Run \`npm run build\` to compile.

## Conventions
<!-- @paths: src/**, tests/** -->

Use camelCase for variables.

## Glossary

A list of terms.
`.trim();

describe('SidecarMdIndex', () => {
  let index: SidecarMdIndex;

  beforeEach(() => {
    index = new SidecarMdIndex(makeSidecarDir() as never);
    index.setPipelineForTests(makeFakePipeline() as never);
  });

  it('starts empty', () => {
    expect(index.size()).toBe(0);
  });

  it('indexes sections on update', async () => {
    await index.update(BASIC_CONTENT);
    expect(index.size()).toBe(3); // Build, Conventions, Glossary
  });

  it('returns search hits above minScore', async () => {
    await index.update(BASIC_CONTENT);
    const hits = await index.search('Build section', 5, 0.0);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toBe('sidecarMd');
    expect(hits[0].title).toContain('Build');
    expect(hits[0].content).toContain('[SIDECAR.md · §Build]');
  });

  it('filters out hits below minScore', async () => {
    await index.update(BASIC_CONTENT);
    // With minScore = 1.0, only exact-match vectors pass (in practice none)
    const hits = await index.search('anything', 5, 1.0);
    // The fake pipeline produces unit vectors; a query not seeded to the same
    // hot dim as any section returns similarity 0 — so all should be filtered.
    expect(hits.every((h) => h.score >= 1.0)).toBe(true);
  });

  it('does not re-embed unchanged sections', async () => {
    const pipeline = makeFakePipeline();
    index.setPipelineForTests(pipeline as never);

    await index.update(BASIC_CONTENT);
    const firstCallCount = pipeline.mock.calls.length;

    // Second update with identical content — no re-embeds expected
    await index.update(BASIC_CONTENT);
    expect(pipeline.mock.calls.length).toBe(firstCallCount);
  });

  it('re-embeds a section whose body changed', async () => {
    const pipeline = makeFakePipeline();
    index.setPipelineForTests(pipeline as never);

    await index.update(BASIC_CONTENT);
    const firstCallCount = pipeline.mock.calls.length;

    const modified = BASIC_CONTENT.replace('Run `npm run build` to compile.', 'Run `make` to compile.');
    await index.update(modified);
    expect(pipeline.mock.calls.length).toBeGreaterThan(firstCallCount);
  });

  it('prunes sections removed from the document', async () => {
    await index.update(BASIC_CONTENT);
    expect(index.size()).toBe(3);

    const withoutGlossary = BASIC_CONTENT.replace(/^## Glossary[\s\S]*$/m, '').trim();
    await index.update(withoutGlossary);
    expect(index.size()).toBe(2);
  });

  it('returns empty array when embedding model fails', async () => {
    index.setPipelineForTests(null);
    await index.update(BASIC_CONTENT);
    expect(index.size()).toBe(0);
    const hits = await index.search('build', 5, 0.0);
    expect(hits).toEqual([]);
  });
});
