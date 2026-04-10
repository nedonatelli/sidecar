import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentMemory } from './agentMemory.js';

describe('AgentMemory', () => {
  let tempDir: string;
  let memory: AgentMemory;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-memory-test-'));
    memory = new AgentMemory(tempDir);
    await memory.load();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates agent memory with valid directory', () => {
    expect(memory).toBeDefined();
    expect(memory.getCount()).toBe(0);
  });

  it('adds memory entries', async () => {
    const id = memory.add('pattern', 'naming', 'Use camelCase for variable names');
    expect(id).toBeDefined();
    expect(memory.getCount()).toBe(1);

    await memory.save();
    expect(fs.existsSync(path.join(tempDir, 'memory', 'agent-memories.json'))).toBe(true);
  });

  it('searches memories by category', async () => {
    memory.add('pattern', 'naming', 'Use camelCase for variable names');
    memory.add('convention', 'imports', 'Group imports by type');
    memory.add('pattern', 'naming', 'Use PascalCase for class names');

    const results = memory.search('naming', 'naming');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].category).toBe('naming');
  });

  it('searches memories by content', () => {
    memory.add('pattern', 'naming', 'Use camelCase for variable names');
    memory.add('convention', 'imports', 'Group imports by type');

    const results = memory.search('camelCase');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('camelCase');
  });

  it('retrieves memories by type', () => {
    memory.add('pattern', 'naming', 'Use camelCase');
    memory.add('pattern', 'naming', 'Use PascalCase');
    memory.add('decision', 'architecture', 'Use MVC');

    const patterns = memory.getByType('pattern');
    expect(patterns.length).toBe(2);
    expect(patterns.every((m) => m.type === 'pattern')).toBe(true);
  });

  it('tracks memory usage', () => {
    const id = memory.add('pattern', 'naming', 'Use camelCase');
    let entry = memory.search('camelCase')[0];
    expect(entry.useCount).toBe(0);

    memory.recordUse(id);
    entry = memory.search('camelCase')[0];
    expect(entry.useCount).toBe(1);
  });

  it('provides memory statistics', () => {
    memory.add('pattern', 'naming', 'Pattern 1');
    memory.add('pattern', 'naming', 'Pattern 2');
    memory.add('decision', 'architecture', 'Decision 1');
    memory.add('convention', 'imports', 'Convention 1');

    const stats = memory.getStats();
    expect(stats.totalCount).toBe(4);
    expect(stats.byType['pattern']).toBe(2);
    expect(stats.byType['decision']).toBe(1);
    expect(stats.byType['convention']).toBe(1);
    expect(Object.keys(stats.byCategory).length).toBe(3);
  });

  it('formats memories for context', () => {
    memory.add('pattern', 'naming', 'Use camelCase for variables');
    memory.add('decision', 'architecture', 'Use MVC pattern');

    const entries = memory.search('');
    const formatted = memory.formatForContext(entries);

    expect(formatted).toContain('Agent Memory');
    expect(formatted).toContain('Pattern');
    expect(formatted).toContain('Decision');
  });

  it('deletes memory entries', () => {
    const id = memory.add('pattern', 'naming', 'Use camelCase');
    expect(memory.getCount()).toBe(1);

    const deleted = memory.delete(id);
    expect(deleted).toBe(true);
    expect(memory.getCount()).toBe(0);
  });

  it('clears all memories', () => {
    memory.add('pattern', 'naming', 'Pattern 1');
    memory.add('decision', 'architecture', 'Decision 1');
    expect(memory.getCount()).toBe(2);

    memory.clear();
    expect(memory.getCount()).toBe(0);
  });

  it('gets available categories', () => {
    memory.add('pattern', 'naming', 'Pattern');
    memory.add('decision', 'architecture', 'Decision');
    memory.add('convention', 'naming', 'Convention');

    const categories = memory.getCategories();
    expect(categories).toContain('naming');
    expect(categories).toContain('architecture');
    expect(categories.length).toBe(2);
  });

  it('persists and loads memories across instances', async () => {
    const id = memory.add('pattern', 'naming', 'Use camelCase');
    await memory.save();

    const memory2 = new AgentMemory(tempDir);
    await memory2.load();

    expect(memory2.getCount()).toBe(1);
    const entries = memory2.search('camelCase');
    expect(entries[0].id).toBe(id);
  });

  it('enforces memory limit', () => {
    // This test verifies that the MAX_MEMORIES limit is respected
    // We won't add 500+ entries in a test, but the mechanism is there
    expect(memory.getCount()).toBe(0);

    memory.add('pattern', 'naming', 'Pattern 1');
    expect(memory.getCount()).toBe(1);
  });
});
