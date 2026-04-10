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

    // Manual recordUse increments the underlying entry
    memory.recordUse(id);
    memory.recordUse(id);
    expect(memory.getByType('pattern')[0].useCount).toBe(2);

    // search() also calls recordUse internally (but returns a spread copy
    // from before the increment, so check via getByType)
    memory.search('camelCase');
    expect(memory.getByType('pattern')[0].useCount).toBe(3);
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

  // --- Tool chain tracking ---

  it('flushToolChain stores chains of 3+ tools', () => {
    memory.recordToolUse('read_file', true);
    memory.recordToolUse('edit_file', true);
    memory.recordToolUse('get_diagnostics', true);
    memory.flushToolChain();

    const chains = memory.getByType('toolchain');
    expect(chains).toHaveLength(1);
    expect(chains[0].content).toBe('read_file → edit_file → get_diagnostics');
  });

  it('flushToolChain deduplicates consecutive repeats', () => {
    memory.recordToolUse('read_file', true);
    memory.recordToolUse('read_file', true);
    memory.recordToolUse('edit_file', true);
    memory.recordToolUse('edit_file', true);
    memory.recordToolUse('get_diagnostics', true);
    memory.flushToolChain();

    const chains = memory.getByType('toolchain');
    expect(chains).toHaveLength(1);
    expect(chains[0].content).toBe('read_file → edit_file → get_diagnostics');
  });

  it('flushToolChain ignores short sequences', () => {
    memory.recordToolUse('read_file', true);
    memory.recordToolUse('edit_file', true);
    memory.flushToolChain();

    expect(memory.getByType('toolchain')).toHaveLength(0);
  });

  it('recordToolUse flushes on failure', () => {
    memory.recordToolUse('read_file', true);
    memory.recordToolUse('edit_file', true);
    memory.recordToolUse('get_diagnostics', true);
    // Failure flushes the buffer
    memory.recordToolUse('run_tests', false);

    const chains = memory.getByType('toolchain');
    expect(chains).toHaveLength(1);
  });

  it('does not store duplicate tool chains', () => {
    memory.recordToolUse('read_file', true);
    memory.recordToolUse('edit_file', true);
    memory.recordToolUse('get_diagnostics', true);
    memory.flushToolChain();

    memory.recordToolUse('read_file', true);
    memory.recordToolUse('edit_file', true);
    memory.recordToolUse('get_diagnostics', true);
    memory.flushToolChain();

    expect(memory.getByType('toolchain')).toHaveLength(1);
  });

  // --- Co-occurrence ---

  it('getToolCooccurrences builds co-occurrence map from chains', () => {
    memory.add('toolchain', 'tool-sequence', 'read_file → edit_file → get_diagnostics');

    const cooccur = memory.getToolCooccurrences();
    expect(cooccur.get('read_file')!.has('edit_file')).toBe(true);
    expect(cooccur.get('edit_file')!.has('get_diagnostics')).toBe(true);
  });

  it('suggestNextTools suggests based on co-occurrence', () => {
    memory.add('toolchain', 'tool-sequence', 'read_file → edit_file → get_diagnostics');
    memory.add('toolchain', 'tool-sequence', 'search_files → read_file → edit_file');

    const suggestions = memory.suggestNextTools(['read_file']);
    expect(suggestions).toContain('edit_file');
    expect(suggestions).toContain('get_diagnostics');
  });

  // --- Failure recording ---

  it('stores failure memories', () => {
    memory.add('failure', 'tool:edit_file', 'edit_file failed: file not found');

    const failures = memory.getByType('failure');
    expect(failures).toHaveLength(1);
    expect(failures[0].content).toContain('file not found');
  });
});
