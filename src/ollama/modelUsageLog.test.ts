import { describe, it, expect, beforeEach } from 'vitest';
import { ModelUsageLog } from './modelUsageLog.js';

describe('ModelUsageLog', () => {
  let log: ModelUsageLog;

  beforeEach(() => {
    log = new ModelUsageLog();
  });

  it('starts empty', () => {
    expect(log.size).toBe(0);
    expect(log.getAll()).toEqual([]);
  });

  it('records a single push and retrieves it', () => {
    const ts = new Date();
    log.push({ model: 'gemma4:e4b', role: 'chat', timestamp: ts });
    expect(log.size).toBe(1);
    const all = log.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({ model: 'gemma4:e4b', role: 'chat', timestamp: ts });
  });

  it('preserves insertion order', () => {
    const t1 = new Date(1000);
    const t2 = new Date(2000);
    const t3 = new Date(3000);
    log.push({ model: 'a', role: 'chat', timestamp: t1 });
    log.push({ model: 'b', role: 'complete', timestamp: t2 });
    log.push({ model: 'c', role: 'chat', timestamp: t3 });
    const all = log.getAll();
    expect(all.map((e) => e.model)).toEqual(['a', 'b', 'c']);
  });

  it('clear resets size and entries', () => {
    log.push({ model: 'x', role: 'chat', timestamp: new Date() });
    log.clear();
    expect(log.size).toBe(0);
    expect(log.getAll()).toEqual([]);
  });

  it('wraps around the ring buffer at MAX_ENTRIES', () => {
    const cap = ModelUsageLog.MAX_ENTRIES;
    for (let i = 0; i < cap + 5; i++) {
      log.push({ model: `m${i}`, role: 'chat', timestamp: new Date(i) });
    }
    expect(log.size).toBe(cap);
    const all = log.getAll();
    // Oldest surviving entry should be m5 (the 6th pushed, since first 5 were overwritten)
    expect(all[0].model).toBe('m5');
    expect(all[cap - 1].model).toBe(`m${cap + 4}`);
  });

  describe('buildTrailers', () => {
    it('returns fallback trailer when log is empty', () => {
      expect(log.buildTrailers('my-model')).toBe('X-AI-Model: my-model');
    });

    it('builds a single trailer for one model', () => {
      log.push({ model: 'claude-sonnet-4-6', role: 'chat', timestamp: new Date() });
      const trailers = log.buildTrailers('claude-sonnet-4-6');
      expect(trailers).toBe('X-AI-Model: claude-sonnet-4-6 (chat, 1 call)');
    });

    it('counts multiple calls to the same model', () => {
      log.push({ model: 'gemma4:e4b', role: 'chat', timestamp: new Date() });
      log.push({ model: 'gemma4:e4b', role: 'chat', timestamp: new Date() });
      log.push({ model: 'gemma4:e4b', role: 'complete', timestamp: new Date() });
      const trailers = log.buildTrailers('gemma4:e4b');
      expect(trailers).toContain('3 calls');
      expect(trailers).toContain('gemma4:e4b');
      expect(trailers).not.toContain('X-AI-Model-Count');
    });

    it('emits X-AI-Model-Count when two models are used', () => {
      log.push({ model: 'claude-haiku-4-5', role: 'complete', timestamp: new Date() });
      log.push({ model: 'gemma4:e4b', role: 'chat', timestamp: new Date() });
      const trailers = log.buildTrailers('gemma4:e4b');
      expect(trailers).toContain('X-AI-Model-Count: 2');
    });

    it('deduplicates roles in the trailer', () => {
      log.push({ model: 'model-a', role: 'chat', timestamp: new Date() });
      log.push({ model: 'model-a', role: 'chat', timestamp: new Date() });
      const trailers = log.buildTrailers('model-a');
      // "chat" should appear only once, not "chat, chat"
      expect(trailers).toMatch(/model-a \(chat, \d+ calls\)/);
    });

    it('includes both roles when both are used', () => {
      log.push({ model: 'model-a', role: 'chat', timestamp: new Date() });
      log.push({ model: 'model-a', role: 'complete', timestamp: new Date() });
      const trailers = log.buildTrailers('model-a');
      expect(trailers).toContain('chat');
      expect(trailers).toContain('complete');
    });
  });
});
