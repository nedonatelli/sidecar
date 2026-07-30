import { describe, it, expect, vi, beforeAll } from 'vitest';
import { SymbolIndexer } from './symbolIndexer.js';
import { workspace } from 'vscode';
import { getAnalyzer, setGrammarsPath } from '../parsing/registry.js';
import { grammarsDir, hasGrammars } from '../parsing/grammarsTestSupport.js';

describe('SymbolIndexer', () => {
  it('creates instance with null sidecarDir', () => {
    const indexer = new SymbolIndexer(null);
    expect(indexer).toBeDefined();
    expect(indexer.getGraph()).toBeDefined();
  });

  it('getGraph returns a SymbolGraph instance', () => {
    const indexer = new SymbolIndexer(null);
    const graph = indexer.getGraph();
    expect(graph.symbolCount()).toBe(0);
  });

  it('initialize returns early when no workspace folders', async () => {
    const origFolders = workspace.workspaceFolders;
    (workspace as Record<string, unknown>).workspaceFolders = undefined;

    const indexer = new SymbolIndexer(null);
    await indexer.initialize(['**/*.ts']);
    expect(indexer.getGraph().symbolCount()).toBe(0);

    (workspace as Record<string, unknown>).workspaceFolders = origFolders;
  });

  it('initialize processes workspace files', async () => {
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([{ fsPath: '/mock-workspace/src/app.ts' }] as never);
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100, mtime: Date.now() } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(
      Buffer.from('export function hello() { return "world"; }') as never,
    );

    const indexer = new SymbolIndexer(null);
    await indexer.initialize(['**/*.ts']);

    // Should have parsed the file (may or may not find symbols depending on analyzer)
    expect(indexer.getGraph()).toBeDefined();

    vi.restoreAllMocks();
  });

  it('queueUpdate adds path to pending updates', () => {
    const indexer = new SymbolIndexer(null);
    // Should not throw
    indexer.queueUpdate('src/app.ts');
    indexer.dispose();
  });

  it('queueDelete adds path to pending deletes', () => {
    const indexer = new SymbolIndexer(null);
    indexer.queueDelete('src/old.ts');
    indexer.dispose();
  });

  it('queueUpdate cancels pending delete for same path', () => {
    const indexer = new SymbolIndexer(null);
    indexer.queueDelete('src/app.ts');
    indexer.queueUpdate('src/app.ts');
    // Should not throw, internal state is managed
    indexer.dispose();
  });

  it('queueDelete cancels pending update for same path', () => {
    const indexer = new SymbolIndexer(null);
    indexer.queueUpdate('src/app.ts');
    indexer.queueDelete('src/app.ts');
    indexer.dispose();
  });

  it('dispose cleans up timers without error', () => {
    const indexer = new SymbolIndexer(null);
    indexer.queueUpdate('src/a.ts');
    expect(() => indexer.dispose()).not.toThrow();
  });

  describe('liveSymbolIds', () => {
    const sym = (qualifiedName: string, startLine: number) => ({
      name: qualifiedName,
      qualifiedName,
      type: 'function' as const,
      filePath: 'src/t.ts',
      startLine,
      endLine: startLine + 1,
      exported: false,
    });

    it('numbers same-named siblings so they stop overwriting each other', () => {
      const indexer = new SymbolIndexer(null);
      indexer.getGraph().addFile('src/t.ts', [sym('tool', 1), sym('tool', 3), sym('other', 5)], [], 'h');

      expect([...indexer.liveSymbolIds()].sort()).toEqual(['src/t.ts::other', 'src/t.ts::tool', 'src/t.ts::tool#1']);
    });

    it('agrees exactly with the IDs the replay queues', async () => {
      // The load-bearing invariant. `reconcile` deletes anything in the index
      // and not in this set, so if the two sides ever assigned ordinals
      // differently, every start would delete live rows that the following
      // replay re-embeds — forever.
      const indexer = new SymbolIndexer(null);
      const graph = indexer.getGraph();
      graph.addFile('src/t.ts', [sym('tool', 1), sym('tool', 3), sym('tool', 5), sym('other', 7)], [], 'h');
      graph.setFileContent('src/t.ts', Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));

      const queued: Array<{ filePath: string; qualifiedName: string; ordinal?: number }> = [];
      indexer.setSymbolEmbeddings({ queueSymbol: (i: never) => queued.push(i) } as never);
      await indexer.replaySymbolsToEmbeddingIndex();

      const { makeSymbolId } = await import('./symbolEmbeddingIndex.js');
      const replayIds = queued.map((q) => makeSymbolId(q.filePath, q.qualifiedName, q.ordinal));
      expect(replayIds).toHaveLength(4);
      expect(new Set(replayIds).size).toBe(4); // no collisions
      for (const id of replayIds) expect(indexer.liveSymbolIds().has(id)).toBe(true);
    });
  });

  describe('PKI symbol-embedding wiring', () => {
    it('setSymbolEmbeddings with null leaves embedder-related state unchanged', () => {
      const indexer = new SymbolIndexer(null);
      // Should not throw; defaults are preserved so the pre-PKI
      // behavior path stays identical.
      indexer.setSymbolEmbeddings(null);
      expect(indexer.getGraph().symbolCount()).toBe(0);
    });

    it('feeds parsed symbols into the embedding queue when one is attached', async () => {
      vi.spyOn(workspace, 'findFiles').mockResolvedValue([{ fsPath: '/mock-workspace/src/auth.ts' }] as never);
      vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 500, mtime: Date.now() } as never);
      vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(
        Buffer.from(
          // Two exported functions so the regex analyzer definitely picks up
          // ≥ 1 symbol (the exact shape varies by language heuristic, but
          // these should all trip the TS function path).
          [
            'export function requireAuth(req, res, next) {',
            '  verifyToken(req);',
            '}',
            '',
            'export function verifyToken(req) {',
            '  return req.headers.authorization;',
            '}',
            '',
          ].join('\n'),
        ) as never,
      );

      const queueSymbolSpy = vi.fn();
      const removeFileSpy = vi.fn();
      const fakeEmbed = {
        queueSymbol: queueSymbolSpy,
        removeFile: removeFileSpy,
      } as never;

      const indexer = new SymbolIndexer(null);
      indexer.setSymbolEmbeddings(fakeEmbed);
      await indexer.initialize(['**/*.ts']);

      // At least one symbol queued — exact count depends on the analyzer.
      expect(queueSymbolSpy).toHaveBeenCalled();
      const queued = queueSymbolSpy.mock.calls[0][0] as { filePath: string; body: string };
      expect(queued.filePath).toContain('auth.ts');
      expect(queued.body.length).toBeGreaterThan(0);
      // Nothing deleted during a fresh init.
      expect(removeFileSpy).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('replaySymbolsToEmbeddingIndex reads file content from disk when the restored graph has none', async () => {
      // Simulates a warm reload: the graph is restored from symbol-graph.json,
      // which persists symbols + hashes but NOT file contents. addFile() sets
      // both without content, so getFileContent() is empty — the replay must
      // fall back to reading the file from disk or it queues nothing.
      const body = ['export function requireAuth(req) {', '  return verifyToken(req);', '}', ''].join('\n');
      vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(body) as never);

      const indexer = new SymbolIndexer(null);
      const graph = indexer.getGraph();
      graph.addFile(
        'src/auth.ts',
        [
          {
            name: 'requireAuth',
            qualifiedName: 'requireAuth',
            type: 'function',
            filePath: 'src/auth.ts',
            startLine: 1,
            endLine: 3,
            exported: true,
          },
        ],
        [],
        'size:mtime',
      );
      expect(graph.getFileContent('src/auth.ts')).toBeUndefined();

      const queueSymbolSpy = vi.fn();
      indexer.setSymbolEmbeddings({ queueSymbol: queueSymbolSpy, removeFile: vi.fn() } as never);

      const result = await indexer.replaySymbolsToEmbeddingIndex();

      expect(result.queued).toBe(1);
      expect(result.filesRead).toBe(1);
      expect(result.filesSkipped).toBe(0);
      expect(workspace.fs.readFile).toHaveBeenCalled();
      expect(queueSymbolSpy).toHaveBeenCalledTimes(1);
      const queuedSymbol = queueSymbolSpy.mock.calls[0][0] as { filePath: string; body: string };
      expect(queuedSymbol.filePath).toBe('src/auth.ts');
      expect(queuedSymbol.body).toContain('requireAuth');

      vi.restoreAllMocks();
    });

    it('replaySymbolsToEmbeddingIndex counts files skipped when content is absent and unreadable', async () => {
      // Restored-graph file with no cached content AND a failing disk read —
      // the case that produces the warn-on-surprising-zero in workspaceIndexer.
      vi.spyOn(workspace.fs, 'readFile').mockRejectedValue(new Error('ENOENT') as never);

      const indexer = new SymbolIndexer(null);
      indexer.getGraph().addFile(
        'src/gone.ts',
        [
          {
            name: 'orphan',
            qualifiedName: 'orphan',
            type: 'function',
            filePath: 'src/gone.ts',
            startLine: 1,
            endLine: 3,
            exported: true,
          },
        ],
        [],
        'size:mtime',
      );

      const queueSymbolSpy = vi.fn();
      indexer.setSymbolEmbeddings({ queueSymbol: queueSymbolSpy, removeFile: vi.fn() } as never);

      const result = await indexer.replaySymbolsToEmbeddingIndex();

      expect(result.queued).toBe(0);
      expect(result.filesRead).toBe(0);
      expect(result.filesSkipped).toBe(1);
      expect(queueSymbolSpy).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('removeFileFromGraph drops the file from both graph and embedder', () => {
      const removeFileSpy = vi.fn();
      const indexer = new SymbolIndexer(null);
      indexer.setSymbolEmbeddings({ queueSymbol: vi.fn(), removeFile: removeFileSpy } as never);

      indexer.removeFileFromGraph('src/gone.ts');

      expect(removeFileSpy).toHaveBeenCalledWith('src/gone.ts');
    });

    it('respects maxSymbolsPerFile when capping large files', async () => {
      // Generate a file with 10 exported functions and cap to 3.
      const body = Array.from({ length: 10 }, (_, i) => `export function fn${i}() { return ${i}; }\n`).join('\n');
      vi.spyOn(workspace, 'findFiles').mockResolvedValue([{ fsPath: '/mock-workspace/src/big.ts' }] as never);
      vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: body.length, mtime: Date.now() } as never);
      vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(body) as never);

      const queueSymbolSpy = vi.fn();
      const indexer = new SymbolIndexer(null);
      indexer.setSymbolEmbeddings(
        { queueSymbol: queueSymbolSpy, removeFile: vi.fn() } as never,
        3, // maxSymbolsPerFile
      );

      await indexer.initialize(['**/*.ts']);

      // At most 3 symbols queued — cap honored even if the analyzer
      // found more in the file. `toBeLessThanOrEqual` because on some
      // hosts the regex analyzer may find fewer than 10.
      expect(queueSymbolSpy.mock.calls.length).toBeLessThanOrEqual(3);

      vi.restoreAllMocks();
    });
  });

  // -------------------------------------------------------------------------
  // dispose() lifecycle: must call persist() to flush in-memory state to disk
  // before the extension host shuts down. Without this, symbol index work
  // done during a session is silently lost.
  // -------------------------------------------------------------------------
  describe('dispose() flushes state via persist()', () => {
    it('calls persist() when no timers are pending', () => {
      const indexer = new SymbolIndexer(null);
      const persistSpy = vi.spyOn(indexer, 'persist').mockResolvedValue(undefined);
      indexer.dispose();
      expect(persistSpy).toHaveBeenCalledOnce();
    });

    it('cancels pendingUpdate timer and still calls persist()', () => {
      const indexer = new SymbolIndexer(null);
      // Queue an update — this arms the updateTimer debounce
      indexer.queueUpdate('src/app.ts');
      const persistSpy = vi.spyOn(indexer, 'persist').mockResolvedValue(undefined);
      indexer.dispose();
      // persist must be called even though updateTimer was cancelled mid-flight
      expect(persistSpy).toHaveBeenCalledOnce();
    });

    it('cancels schedulePersist timer and still calls persist()', () => {
      vi.useFakeTimers();
      const indexer = new SymbolIndexer(null);
      // Trigger a schedulePersist via queueUpdate path (update → parse → schedulePersist)
      // We just directly verify dispose() always calls persist regardless of timer state.
      const persistSpy = vi.spyOn(indexer, 'persist').mockResolvedValue(undefined);
      indexer.dispose();
      expect(persistSpy).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });
  });

  // Variable symbols (#9). These assertions name the symbol they expect and
  // must never be weakened to "some symbols were found" — an earlier test here
  // asserted only that parsing happened, which is why 218 missing `export
  // const` symbols went unnoticed for the life of the feature.
  describe('indexes top-level variable declarations', () => {
    async function indexed(source: string, file = 'src/app.ts') {
      vi.spyOn(workspace, 'findFiles').mockResolvedValue([{ fsPath: `/mock-workspace/${file}` }] as never);
      vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: source.length, mtime: 1 } as never);
      vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(source) as never);
      const indexer = new SymbolIndexer(null);
      await indexer.initialize(['**/*.ts']);
      vi.restoreAllMocks();
      return indexer.getGraph();
    }

    it('indexes an exported const with a multi-line initializer', async () => {
      // The shape this exists for: a configuration table. The line range must
      // span the whole initializer, because content extraction slices on it and
      // a declarator-only range would truncate exactly these objects.
      const graph = await indexed(
        ['export const BACKENDS = {', '  ollama: 11434,', '  kickstand: 11435,', '};', ''].join('\n'),
      );
      const sym = graph.getSymbolsInFile('src/app.ts').find((s) => s.name === 'BACKENDS');
      expect(sym, 'BACKENDS was not indexed').toBeDefined();
      expect(sym!.type).toBe('variable');
      expect(sym!.exported).toBe(true);
      expect(sym!.endLine - sym!.startLine).toBeGreaterThanOrEqual(3);
    });

    it('indexes single-line consts, whatever the initializer looks like', async () => {
      // A const initialized from an identifier or call reads like the start of
      // an arrow function to a line-based matcher. It is not one, and it must
      // still be indexed.
      const graph = await indexed(
        [
          'export const MODEL = "claude-opus-5";',
          'export const CLIENT = makeClient(MODEL);',
          'export const ALIAS = MODEL;',
          '',
        ].join('\n'),
      );
      const names = graph.getSymbolsInFile('src/app.ts').map((s) => s.name);
      for (const n of ['MODEL', 'CLIENT', 'ALIAS']) expect(names, `${n} missing`).toContain(n);
    });

    it('records unexported top-level declarations with exported: false', async () => {
      const graph = await indexed(['const INTERNAL_LIMIT = 40;', ''].join('\n'));
      const sym = graph.getSymbolsInFile('src/app.ts').find((s) => s.name === 'INTERNAL_LIMIT');
      expect(sym, 'unexported const was not indexed').toBeDefined();
      expect(sym!.exported).toBe(false);
    });

    it('emits one symbol per name when a declaration binds several', async () => {
      const graph = await indexed(['export const ALPHA = 1, BETA = 2;', ''].join('\n'));
      const names = graph.getSymbolsInFile('src/app.ts').map((s) => s.name);
      expect(names).toContain('ALPHA');
      expect(names).toContain('BETA');
    });

    it('does not invent symbols from commas inside a type annotation', async () => {
      // `Record<string, unknown>` is one declarator, not three. Splitting on
      // every comma produced real symbols named `string` and `unknown` in the
      // graph — worse than the missing symbols this change exists to add,
      // because a wrong symbol answers reference queries with nonsense.
      const graph = await indexed(
        [
          'export const REGISTRY: Record<string, unknown> = {};',
          'export const COUNTS: Map<string, number> = new Map();',
          '',
        ].join('\n'),
      );
      const names = graph.getSymbolsInFile('src/app.ts').map((s) => s.name);
      expect(names).toContain('REGISTRY');
      expect(names).toContain('COUNTS');
      for (const bogus of ['string', 'unknown', 'number']) expect(names).not.toContain(bogus);
    });

    it('does not index declarations nested inside a function body', async () => {
      const graph = await indexed(
        ['export function run() {', '  const scratch = compute();', '  return scratch;', '}', ''].join('\n'),
      );
      const names = graph.getSymbolsInFile('src/app.ts').map((s) => s.name);
      expect(names).toContain('run');
      expect(names).not.toContain('scratch');
    });

    it('emits nothing for a destructured declaration', async () => {
      // A deliberate first-cut choice, asserted so it stays visible: a wrong
      // symbol is worse than a missing one, and the bound names here have no
      // single declarator to attribute a range to.
      const graph = await indexed(['export const { host, port } = config;', ''].join('\n'));
      const names = graph.getSymbolsInFile('src/app.ts').map((s) => s.name);
      expect(names).not.toContain('host');
      expect(names).not.toContain('port');
    });

    it('does not mistake a const enum for a variable', async () => {
      const graph = await indexed(['export const enum Mode {', '  Fast,', '  Slow,', '}', ''].join('\n'));
      const sym = graph.getSymbolsInFile('src/app.ts').find((s) => s.name === 'Mode');
      expect(sym).toBeDefined();
      expect(sym!.type).toBe('enum');
    });

    it('does not emit a variable for an arrow-function const', async () => {
      // Those are already indexed as functions; emitting both would double-count
      // every callback-style export in the graph.
      const graph = await indexed(['export const handle = (req) => {', '  return req;', '};', ''].join('\n'));
      const forName = graph.getSymbolsInFile('src/app.ts').filter((s) => s.name === 'handle');
      expect(forName).toHaveLength(1);
      expect(forName[0].type).toBe('function');
    });

    it('still indexes a const that merely sits above an arrow function', async () => {
      // The lookahead for a wrapped arrow parameter list used to fire on any
      // following line containing `=>`, which swallowed the declaration above
      // it entirely — a missing symbol caused by a neighbour.
      const graph = await indexed(['export const ALIAS = MODEL;', 'export const fn = (x) => x;', ''].join('\n'));
      const names = graph.getSymbolsInFile('src/app.ts').map((s) => s.name);
      expect(names).toContain('ALIAS');
      expect(names).toContain('fn');
    });

    it('does not index a declaration written inside a template literal', async () => {
      // Real case: src/voice/hostRecorder.ts holds Swift source in a template
      // literal, and the Swift `let outputPath = …` inside it matched the
      // line-anchored pattern. A top-level declaration cannot contain another,
      // so anything inside one is not a symbol.
      const graph = await indexed(
        [
          'const SWIFT_SOURCE = `',
          'import Foundation',
          'let outputPath = "/tmp/out"',
          '`;',
          'export const REAL = 1;',
          '',
        ].join('\n'),
      );
      const names = graph.getSymbolsInFile('src/app.ts').map((s) => s.name);
      expect(names).toContain('SWIFT_SOURCE');
      expect(names).toContain('REAL');
      expect(names).not.toContain('outputPath');
    });

    it('indexes the first declaration in a file that starts with a BOM', async () => {
      // A byte-order mark sits before the first character, so `^`-anchored
      // patterns miss the declaration on line 1 — the only symbol in the file
      // that a reader would call obviously present. Editors on Windows write
      // these routinely, and it made the two analyzers disagree.
      const graph = await indexed(['﻿export const FIRST = 1;', 'export const SECOND = 2;', ''].join('\n'));
      const names = graph.getSymbolsInFile('src/app.ts').map((s) => s.name);
      expect(names).toContain('FIRST');
      expect(names).toContain('SECOND');
    });

    it('indexes the same declaration in .js and .tsx files', async () => {
      // Kept out of the grammars-gated block below on purpose: those tests
      // vanish on a grammar-less checkout, and the JS/TSX mappings would then
      // have no regression guard at all.
      for (const file of ['src/plain.js', 'src/view.tsx']) {
        const graph = await indexed(['export const THEME = { dark: true };', ''].join('\n'), file);
        const sym = graph.getSymbolsInFile(file).find((s) => s.name === 'THEME');
        expect(sym, `${file}: THEME was not indexed`).toBeDefined();
        expect(sym!.type).toBe('variable');
      }
    });

    // -----------------------------------------------------------------------
    // Same seam, second configuration: tree-sitter.
    //
    // Everything above ran through the regex analyzer, because `getAnalyzer`
    // only reaches for tree-sitter once a grammars path is set and nothing
    // sets one under vitest. Tree-sitter is what actually runs in the
    // extension host, so the seam has to be exercised both ways or the
    // configuration users get is the one left untested.
    //
    // ORDERING IS LOAD-BEARING: setGrammarsPath is module-global and the
    // analyzer is cached after first load, so this block must stay last in the
    // file. Everything before it would otherwise silently switch analyzers.
    // -----------------------------------------------------------------------
    describe.skipIf(!hasGrammars)('via the tree-sitter analyzer', () => {
      beforeAll(async () => {
        setGrammarsPath(grammarsDir);
        await getAnalyzer('ts');
      }, 60000);

      it('uses tree-sitter for this block', async () => {
        // Guards the ordering note above: if the regex analyzer is still in
        // play, the rest of this block proves nothing about tree-sitter.
        const analyzer = await getAnalyzer('ts');
        expect(analyzer.constructor.name).not.toBe('RegexAnalyzer');
      });

      it('indexes an exported const with a multi-line initializer', async () => {
        const graph = await indexed(
          ['export const BACKENDS = {', '  ollama: 11434,', '  kickstand: 11435,', '};', ''].join('\n'),
          'src/ts-app.ts',
        );
        const sym = graph.getSymbolsInFile('src/ts-app.ts').find((s) => s.name === 'BACKENDS');
        expect(sym, 'BACKENDS was not indexed').toBeDefined();
        expect(sym!.type).toBe('variable');
        expect(sym!.exported).toBe(true);
        expect(sym!.endLine - sym!.startLine).toBeGreaterThanOrEqual(3);
      });

      it('emits one symbol per name when a declaration binds several', async () => {
        const graph = await indexed(['export const ALPHA = 1, BETA = 2;', ''].join('\n'), 'src/ts-multi.ts');
        const names = graph.getSymbolsInFile('src/ts-multi.ts').map((s) => s.name);
        expect(names).toContain('ALPHA');
        expect(names).toContain('BETA');
      });

      it('does not index declarations nested inside a function body', async () => {
        const graph = await indexed(
          ['export function run() {', '  const scratch = compute();', '  return scratch;', '}', ''].join('\n'),
          'src/ts-nested.ts',
        );
        const names = graph.getSymbolsInFile('src/ts-nested.ts').map((s) => s.name);
        expect(names).toContain('run');
        expect(names).not.toContain('scratch');
      });

      it('emits nothing for a destructured declaration', async () => {
        const graph = await indexed(['export const { host, port } = config;', ''].join('\n'), 'src/ts-destr.ts');
        const names = graph.getSymbolsInFile('src/ts-destr.ts').map((s) => s.name);
        expect(names).not.toContain('host');
        expect(names).not.toContain('port');
      });

      it('indexes the same declaration in a .tsx file', async () => {
        const graph = await indexed(['export const THEME = { dark: true };', ''].join('\n'), 'src/ts-view.tsx');
        const sym = graph.getSymbolsInFile('src/ts-view.tsx').find((s) => s.name === 'THEME');
        expect(sym, 'tsx variable was not indexed').toBeDefined();
        expect(sym!.type).toBe('variable');
      });

      it('indexes the same declaration in a .js file', async () => {
        const graph = await indexed(['export const LIMITS = { max: 10 };', ''].join('\n'), 'src/ts-plain.js');
        const sym = graph.getSymbolsInFile('src/ts-plain.js').find((s) => s.name === 'LIMITS');
        expect(sym, 'js variable was not indexed').toBeDefined();
        expect(sym!.type).toBe('variable');
      });

      it('agrees with the regex analyzer on arrow-function consts', async () => {
        // The two analyzers must not disagree about a symbol's KIND. Tree-sitter
        // has no arrow mapping, so without this the same declaration is a
        // `function` on one path and a `variable` on the other, and which one a
        // user gets depends on whether grammars loaded.
        const graph = await indexed(['export const handle = (req) => req;', ''].join('\n'), 'src/ts-arrow.ts');
        const forName = graph.getSymbolsInFile('src/ts-arrow.ts').filter((s) => s.name === 'handle');
        expect(forName).toHaveLength(1);
        expect(forName[0].type).toBe('function');
      });
    });
  });
});
