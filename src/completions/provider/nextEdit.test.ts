import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextEditEngine } from './nextEdit.js';
import type { SymbolGraph, SymbolEntry, CallEdge } from '../../config/symbolGraph.js';

// Minimal SymbolGraph mock — only the methods NextEditEngine calls
function makeGraph(overrides: Partial<SymbolGraph> = {}): SymbolGraph {
  return {
    getSymbolsInFile: vi.fn().mockReturnValue([]),
    getCallers: vi.fn().mockReturnValue([]),
    getDependents: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as SymbolGraph;
}

// VS Code window / workspace / commands are mocked globally via src/__mocks__/vscode.ts

describe('NextEditEngine — computeSuggestions (via private access)', () => {
  let engine: NextEditEngine;

  afterEach(() => {
    engine?.dispose();
  });

  it('returns empty when no symbols span the edited line', () => {
    const graph = makeGraph({
      getSymbolsInFile: vi
        .fn()
        .mockReturnValue([
          {
            name: 'foo',
            startLine: 10,
            endLine: 20,
            filePath: 'src/a.ts',
            exported: true,
            type: 'function',
          } as SymbolEntry,
        ]),
    });
    engine = new NextEditEngine(graph);
    // @ts-expect-error — accessing private method for testing
    const results = engine.computeSuggestions('/workspace/src/b.ts', 5, {
      maxHops: 2,
      topK: 3,
      crossFileEnabled: true,
    });
    expect(results).toHaveLength(0);
  });

  it('returns caller suggestions for a symbol at the edited line', () => {
    const callers: CallEdge[] = [{ callerFile: 'src/b.ts', callerName: 'bar', calleeName: 'foo', line: 42 }];
    const graph = makeGraph({
      getSymbolsInFile: vi
        .fn()
        .mockReturnValue([
          {
            name: 'foo',
            startLine: 0,
            endLine: 5,
            filePath: 'src/a.ts',
            exported: true,
            type: 'function',
          } as SymbolEntry,
        ]),
      getCallers: vi.fn().mockReturnValue(callers),
      getDependents: vi.fn().mockReturnValue([]),
    });
    engine = new NextEditEngine(graph);
    // @ts-expect-error
    const results = engine.computeSuggestions('/mock-workspace/src/a.ts', 3, {
      maxHops: 2,
      topK: 3,
      crossFileEnabled: true,
    });
    expect(results).toHaveLength(1);
    expect(results[0].symbolName).toBe('bar');
    expect(results[0].reasoning).toContain('calls foo');
    expect(results[0].line).toBe(41); // 1-based → 0-based
  });

  it('respects topK limit', () => {
    const callers: CallEdge[] = Array.from({ length: 5 }, (_, i) => ({
      callerFile: `src/file${i}.ts`,
      callerName: `caller${i}`,
      calleeName: 'foo',
      line: i + 1,
    }));
    const graph = makeGraph({
      getSymbolsInFile: vi
        .fn()
        .mockReturnValue([
          {
            name: 'foo',
            startLine: 0,
            endLine: 10,
            filePath: 'src/a.ts',
            exported: true,
            type: 'function',
          } as SymbolEntry,
        ]),
      getCallers: vi.fn().mockReturnValue(callers),
      getDependents: vi.fn().mockReturnValue([]),
    });
    engine = new NextEditEngine(graph);
    // @ts-expect-error
    const results = engine.computeSuggestions('/mock-workspace/src/a.ts', 5, {
      maxHops: 2,
      topK: 2,
      crossFileEnabled: true,
    });
    expect(results).toHaveLength(2);
  });

  it('filters cross-file callers when crossFileEnabled is false', () => {
    const callers: CallEdge[] = [
      { callerFile: 'src/other.ts', callerName: 'bar', calleeName: 'foo', line: 7 }, // cross-file
      { callerFile: 'src/a.ts', callerName: 'baz', calleeName: 'foo', line: 15 }, // same file
    ];
    const graph = makeGraph({
      getSymbolsInFile: vi
        .fn()
        .mockReturnValue([
          {
            name: 'foo',
            startLine: 0,
            endLine: 5,
            filePath: 'src/a.ts',
            exported: true,
            type: 'function',
          } as SymbolEntry,
        ]),
      getCallers: vi.fn().mockReturnValue(callers),
      getDependents: vi.fn().mockReturnValue([]),
    });
    engine = new NextEditEngine(graph);
    // @ts-expect-error
    const results = engine.computeSuggestions('/mock-workspace/src/a.ts', 2, {
      maxHops: 2,
      topK: 5,
      crossFileEnabled: false,
    });
    expect(results).toHaveLength(1);
    expect(results[0].symbolName).toBe('baz');
  });

  it('includes dependent files at hop-2 when maxHops >= 2 and crossFileEnabled', () => {
    const depSymbols: SymbolEntry[] = [
      {
        name: 'Consumer',
        startLine: 5,
        endLine: 20,
        filePath: 'src/consumer.ts',
        exported: true,
        type: 'class',
      } as SymbolEntry,
    ];
    const graph = makeGraph({
      getSymbolsInFile: vi
        .fn()
        .mockImplementation((f: string) =>
          f === 'src/a.ts'
            ? [{ name: 'foo', startLine: 0, endLine: 5, filePath: 'src/a.ts', exported: true, type: 'function' }]
            : depSymbols,
        ),
      getCallers: vi.fn().mockReturnValue([]), // no direct callers
      getDependents: vi.fn().mockReturnValue(['src/consumer.ts']),
    });
    engine = new NextEditEngine(graph);
    // @ts-expect-error
    const results = engine.computeSuggestions('/mock-workspace/src/a.ts', 3, {
      maxHops: 2,
      topK: 3,
      crossFileEnabled: true,
    });
    expect(results).toHaveLength(1);
    expect(results[0].reasoning).toContain('imports changed file');
  });

  it('deduplicates identical file:line pairs', () => {
    const callers: CallEdge[] = [
      { callerFile: 'src/b.ts', callerName: 'bar', calleeName: 'foo', line: 10 },
      { callerFile: 'src/b.ts', callerName: 'bar', calleeName: 'foo', line: 10 }, // duplicate
    ];
    const graph = makeGraph({
      getSymbolsInFile: vi
        .fn()
        .mockReturnValue([
          {
            name: 'foo',
            startLine: 0,
            endLine: 5,
            filePath: 'src/a.ts',
            exported: true,
            type: 'function',
          } as SymbolEntry,
        ]),
      getCallers: vi.fn().mockReturnValue(callers),
      getDependents: vi.fn().mockReturnValue([]),
    });
    engine = new NextEditEngine(graph);
    // @ts-expect-error
    const results = engine.computeSuggestions('/mock-workspace/src/a.ts', 2, {
      maxHops: 2,
      topK: 5,
      crossFileEnabled: true,
    });
    expect(results).toHaveLength(1);
  });

  it('assigns sequential badgeIndex values', () => {
    const callers: CallEdge[] = [
      { callerFile: 'src/b.ts', callerName: 'b1', calleeName: 'foo', line: 1 },
      { callerFile: 'src/c.ts', callerName: 'c1', calleeName: 'foo', line: 2 },
      { callerFile: 'src/d.ts', callerName: 'd1', calleeName: 'foo', line: 3 },
    ];
    const graph = makeGraph({
      getSymbolsInFile: vi
        .fn()
        .mockReturnValue([
          {
            name: 'foo',
            startLine: 0,
            endLine: 5,
            filePath: 'src/a.ts',
            exported: true,
            type: 'function',
          } as SymbolEntry,
        ]),
      getCallers: vi.fn().mockReturnValue(callers),
      getDependents: vi.fn().mockReturnValue([]),
    });
    engine = new NextEditEngine(graph);
    // @ts-expect-error
    const results = engine.computeSuggestions('/mock-workspace/src/a.ts', 2, {
      maxHops: 2,
      topK: 5,
      crossFileEnabled: true,
    });
    expect(results.map((r) => r.badgeIndex)).toEqual([0, 1, 2]);
  });
});

describe('NextEditEngine — navigate', () => {
  it('cycles forward through suggestions without out-of-bounds', () => {
    const graph = makeGraph();
    const eng = new NextEditEngine(graph);
    // @ts-expect-error
    eng.suggestions = [{ filePath: '/a.ts', line: 0, symbolName: 'a', reasoning: '', badgeIndex: 0 }];
    // @ts-expect-error
    eng.navigate(1);
    // @ts-expect-error
    expect(eng.currentIndex).toBe(0); // wraps back to 0 with length 1
    eng.dispose();
  });

  it('navigate wraps backwards', () => {
    const graph = makeGraph();
    const eng = new NextEditEngine(graph);
    // @ts-expect-error
    eng.suggestions = [
      { filePath: '/a.ts', line: 0, symbolName: 'a', reasoning: '', badgeIndex: 0 },
      { filePath: '/b.ts', line: 5, symbolName: 'b', reasoning: '', badgeIndex: 1 },
    ];
    // @ts-expect-error
    eng.navigate(-1); // 0 → 1 (wrap to last)
    // @ts-expect-error
    expect(eng.currentIndex).toBe(1);
    eng.dispose();
  });
});

describe('NextEditEngine — dismiss', () => {
  it('clears suggestions and cancels debounce timer', () => {
    const graph = makeGraph();
    const eng = new NextEditEngine(graph);
    // Inject a fake timer to verify it gets cleared
    // @ts-expect-error
    eng.debounceTimer = setTimeout(() => {}, 60_000);
    // @ts-expect-error
    eng.suggestions = [{ filePath: '/a.ts', line: 0, symbolName: 'x', reasoning: '', badgeIndex: 0 }];
    eng.dismiss();
    // @ts-expect-error
    expect(eng.suggestions).toHaveLength(0);
    // @ts-expect-error
    expect(eng.debounceTimer).toBeNull();
    eng.dispose();
  });
});
