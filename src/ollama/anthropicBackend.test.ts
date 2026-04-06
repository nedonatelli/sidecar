import { describe, it, expect } from 'vitest';
import { buildSystemBlocks } from './anthropicBackend.js';

describe('buildSystemBlocks', () => {
  it('caches entire prompt when no workspace context present', () => {
    const prompt = 'You are SideCar, an AI coding assistant.';
    const blocks = buildSystemBlocks(prompt);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(prompt);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('splits into cached prefix and uncached workspace context', () => {
    const prefix = 'You are SideCar.\n\nProject instructions from SIDECAR.md:\nUse TypeScript.\n\n';
    const context =
      '## Workspace Structure\n```\nsrc/index.ts\n```\n\n## Relevant Files\n### src/index.ts\n```\nconst x = 1;\n```';
    const prompt = prefix + context;

    const blocks = buildSystemBlocks(prompt);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe(prefix.trimEnd());
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1].text).toBe(context);
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it('caches full prompt when workspace marker is at position 0', () => {
    const prompt = '## Workspace Structure\nsome content';
    const blocks = buildSystemBlocks(prompt);
    // Marker at position 0 means no stable prefix to cache separately
    expect(blocks).toHaveLength(1);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('handles empty prompt', () => {
    const blocks = buildSystemBlocks('');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('');
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});
