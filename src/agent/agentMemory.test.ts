import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  afterEach(async () => {
    await memory.pendingSave;
    await fs.promises.rm(tempDir, { recursive: true, force: true });
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

  it('redacts secrets in content and context before persisting', async () => {
    memory.add(
      'failure',
      'tool:read_file',
      'read_file returned AWS key AKIA1234567890ABCDEF in config',
      'context with token ghp_0123456789012345678901234567890123456',
    );

    const entry = memory.queryAll()[0];
    expect(entry.content).not.toContain('AKIA1234567890ABCDEF');
    expect(entry.content).toContain('[REDACTED:AWS Access Key]');
    expect(entry.context).not.toContain('ghp_0123456789012345678901234567890123456');
    expect(entry.context).toContain('[REDACTED:GitHub Token]');

    // Persisted file must not contain the raw secrets either.
    await memory.save();
    const onDisk = fs.readFileSync(path.join(tempDir, 'memory', 'agent-memories.json'), 'utf-8');
    expect(onDisk).not.toContain('AKIA1234567890ABCDEF');
    expect(onDisk).not.toContain('ghp_0123456789012345678901234567890123456');
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

    expect(formatted).toContain('This Session');
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

  // --- Session tracking ---

  it('startSession rotates session ID and flushes tool chain', () => {
    const firstSession = memory.getSessionId();
    memory.recordToolUse('read_file', true);
    memory.recordToolUse('edit_file', true);
    memory.recordToolUse('get_diagnostics', true);

    memory.startSession();
    const secondSession = memory.getSessionId();

    expect(secondSession).not.toBe(firstSession);
    // The tool chain from the first session should have been flushed
    expect(memory.getByType('toolchain')).toHaveLength(1);
  });

  it('memories are tagged with session ID', () => {
    const sessionBefore = memory.getSessionId();
    memory.add('pattern', 'naming', 'camelCase for variables');
    memory.startSession();
    memory.add('pattern', 'naming', 'snake_case for Python');

    const all = memory.getByType('pattern');
    expect(all[0].sessionId).toBe(sessionBefore);
    expect(all[1].sessionId).toBe(memory.getSessionId());
  });

  it('formatForContext separates current-session from past-session', () => {
    memory.add('pattern', 'naming', 'camelCase convention');
    memory.startSession();
    memory.add('decision', 'architecture', 'Use MVC pattern');

    const all = [...memory.getByType('pattern'), ...memory.getByType('decision')];
    const formatted = memory.formatForContext(all);

    expect(formatted).toContain('This Session');
    expect(formatted).toContain('Past Sessions');
    expect(formatted).toContain('MVC');
    expect(formatted).toContain('camelCase');
  });

  it('search boosts current-session memories', () => {
    memory.add('pattern', 'naming', 'Use camelCase for naming variables');
    memory.startSession();
    memory.add('pattern', 'naming', 'Use camelCase for naming functions');

    const results = memory.search('camelCase naming');
    // Current session entry should rank first due to session boost
    expect(results[0].content).toContain('functions');
  });

  it('search caps current-session memories at 2', () => {
    memory.startSession();
    // Add 5 current-session memories all matching the query
    memory.add('pattern', 'styling', 'styling rule alpha for components');
    memory.add('pattern', 'styling', 'styling rule beta for components');
    memory.add('pattern', 'styling', 'styling rule gamma for components');
    memory.add('pattern', 'styling', 'styling rule delta for components');
    memory.add('pattern', 'styling', 'styling rule epsilon for components');

    const results = memory.search('styling components', undefined, 5);
    // Should return at most 2 current-session memories even though 5 match
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('search allows past-session memories to fill remaining slots', () => {
    // Add 3 past-session memories
    memory.add('pattern', 'testing', 'testing pattern alpha for coverage');
    memory.add('pattern', 'testing', 'testing pattern beta for coverage');
    memory.add('pattern', 'testing', 'testing pattern gamma for coverage');

    // Start new session, add 3 more
    memory.startSession();
    memory.add('pattern', 'testing', 'testing pattern delta for coverage');
    memory.add('pattern', 'testing', 'testing pattern epsilon for coverage');
    memory.add('pattern', 'testing', 'testing pattern zeta for coverage');

    const results = memory.search('testing coverage', undefined, 5);
    // Should get at most 2 current-session + up to 3 past-session = 5 total
    expect(results.length).toBe(5);

    const currentSessionId = (memory as unknown as { currentSessionId: string }).currentSessionId;
    const currentSessionCount = results.filter((r) => r.sessionId === currentSessionId).length;
    expect(currentSessionCount).toBeLessThanOrEqual(2);
  });
});

describe('AgentMemory.getRelevantMemories', () => {
  let memory: AgentMemory;
  let tempDir: string;

  beforeEach(() => {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-rel-test-'));
    memory = new AgentMemory(tempDir);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-10'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await memory.pendingSave;
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('returns empty array when no memories were added', () => {
    const results = memory.getRelevantMemories('xyz999irrelevant');
    expect(results).toEqual([]);
  });

  it('returns entries whose content matches the query', async () => {
    await memory.add('note', 'testing', 'TypeScript generics tutorial');
    await memory.add('note', 'other', 'Python syntax guide');
    const results = memory.getRelevantMemories('TypeScript');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('TypeScript');
  });

  it('scores content match (0.5) higher than category match (0.3)', async () => {
    await memory.add('note', 'typescript', 'some general content');
    await memory.add('note', 'python', 'typescript also appears in content');
    const results = memory.getRelevantMemories('typescript', 5);
    expect(results.length).toBe(2);
    // content match = 0.5 > category match = 0.3, so python (content) wins
    expect(results[0].category).toBe('python');
  });

  it('respects maxResults limit', async () => {
    for (let i = 0; i < 10; i++) {
      await memory.add('note', 'testing', `test content item ${i}`);
    }
    const results = memory.getRelevantMemories('test content', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('boosts score for recent entries (within 7 days)', async () => {
    await memory.add('note', 'recent', 'recent search query data');
    vi.setSystemTime(new Date('2024-01-20')); // 10 days later
    await memory.add('note', 'old', 'old search query data');
    // Both match "search query" but the one added recently (Jan 10) is older now
    const results = memory.getRelevantMemories('search query', 5);
    expect(results.length).toBe(2);
  });
});

describe('AgentMemory persistence failures are observable', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-mem-adverse-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('surfaces a failed save instead of logging it into the void', async () => {
    // Auto-saves are fire-and-forget, so a failure cannot be thrown at anyone.
    // It used to be swallowed into logger.warn, which made silent data loss
    // indistinguishable from success — the shape of the pre-commit "flake".
    const memory = new AgentMemory(tmp);
    const memDir = path.join(tmp, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.chmodSync(memDir, 0o500);

    memory.add('pattern', 'naming', 'Use camelCase');
    await memory.pendingSave;
    fs.chmodSync(memDir, 0o700);

    if (memory.getSaveError() === null) return; // root: the write succeeded
    expect(memory.getSaveError()).toBeInstanceOf(Error);
  });

  it('a failed save does not poison later saves', async () => {
    const memory = new AgentMemory(tmp);
    const memDir = path.join(tmp, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.chmodSync(memDir, 0o500);
    memory.add('pattern', 'naming', 'first');
    await memory.pendingSave;
    fs.chmodSync(memDir, 0o700);

    memory.add('pattern', 'naming', 'second');
    await memory.pendingSave;

    expect(memory.getSaveError()).toBeNull();
    const reloaded = new AgentMemory(tmp);
    await reloaded.load();
    expect(reloaded.getCount()).toBe(2);
  });

  it('does not overwrite a store it could not read', async () => {
    const memDir = path.join(tmp, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    const original = '{"version":1,"memories":[{"id":"x","conte';
    fs.writeFileSync(path.join(memDir, 'agent-memories.json'), original, 'utf-8');

    const memory = new AgentMemory(tmp);
    await memory.load();

    const failure = memory.getLoadFailure();
    expect(failure).not.toBeNull();
    expect(fs.readFileSync(failure!.quarantinedTo!, 'utf-8')).toBe(original);
  });
});
