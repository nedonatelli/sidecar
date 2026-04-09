import { describe, it, expect } from 'vitest';
import { SymbolGraph, type SymbolEntry, type ImportEdge } from './symbolGraph.js';

function sym(name: string, file: string, opts?: Partial<SymbolEntry>): SymbolEntry {
  return {
    name,
    qualifiedName: name,
    type: 'function',
    filePath: file,
    startLine: 0,
    endLine: 5,
    exported: true,
    ...opts,
  };
}

function imp(from: string, to: string, names: string[] = []): ImportEdge {
  return { fromFile: from, toFile: to, importedNames: names };
}

describe('SymbolGraph', () => {
  it('addFile and lookupSymbol round-trip', () => {
    const graph = new SymbolGraph();
    graph.addFile('src/a.ts', [sym('foo', 'src/a.ts'), sym('bar', 'src/a.ts')], [], 'h1');

    expect(graph.lookupSymbol('foo')).toHaveLength(1);
    expect(graph.lookupSymbol('foo')[0].filePath).toBe('src/a.ts');
    expect(graph.lookupSymbol('bar')).toHaveLength(1);
    expect(graph.lookupSymbol('baz')).toHaveLength(0);
  });

  it('handles same symbol name in multiple files', () => {
    const graph = new SymbolGraph();
    graph.addFile('src/a.ts', [sym('init', 'src/a.ts')], [], 'h1');
    graph.addFile('src/b.ts', [sym('init', 'src/b.ts')], [], 'h2');

    const results = graph.lookupSymbol('init');
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.filePath).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('getDependencies and getDependents', () => {
    const graph = new SymbolGraph();
    graph.addFile('src/a.ts', [sym('foo', 'src/a.ts')], [], 'h1');
    graph.addFile('src/b.ts', [], [imp('src/b.ts', 'src/a', ['foo'])], 'h2');
    graph.addFile('src/c.ts', [], [imp('src/c.ts', 'src/a', ['foo']), imp('src/c.ts', 'src/b', ['*'])], 'h3');

    expect(graph.getDependencies('src/b.ts')).toEqual(['src/a']);
    expect(graph.getDependencies('src/c.ts').sort()).toEqual(['src/a', 'src/b']);
    expect(graph.getDependencies('src/a.ts')).toEqual([]);

    expect(graph.getDependents('src/a').sort()).toEqual(['src/b.ts', 'src/c.ts']);
    expect(graph.getDependents('src/b')).toEqual(['src/c.ts']);
  });

  it('removeFile cleans up all indexes', () => {
    const graph = new SymbolGraph();
    graph.addFile('src/a.ts', [sym('foo', 'src/a.ts')], [], 'h1');
    graph.addFile('src/b.ts', [], [imp('src/b.ts', 'src/a', ['foo'])], 'h2');

    expect(graph.lookupSymbol('foo')).toHaveLength(1);
    expect(graph.getDependents('src/a')).toHaveLength(1);

    graph.removeFile('src/a.ts');

    expect(graph.lookupSymbol('foo')).toHaveLength(0);
    expect(graph.getSymbolsInFile('src/a.ts')).toHaveLength(0);
    expect(graph.getFileHash('src/a.ts')).toBeUndefined();
  });

  it('removeFile cleans up reverse import index', () => {
    const graph = new SymbolGraph();
    graph.addFile('src/a.ts', [], [], 'h1');
    graph.addFile('src/b.ts', [], [imp('src/b.ts', 'src/a', ['foo'])], 'h2');

    expect(graph.getDependents('src/a')).toEqual(['src/b.ts']);

    graph.removeFile('src/b.ts');

    expect(graph.getDependents('src/a')).toEqual([]);
  });

  it('addFile replaces previous data for same file', () => {
    const graph = new SymbolGraph();
    graph.addFile('src/a.ts', [sym('old', 'src/a.ts')], [], 'h1');
    graph.addFile('src/a.ts', [sym('new', 'src/a.ts')], [], 'h2');

    expect(graph.lookupSymbol('old')).toHaveLength(0);
    expect(graph.lookupSymbol('new')).toHaveLength(1);
    expect(graph.getFileHash('src/a.ts')).toBe('h2');
  });

  it('getExportsOf returns only exported symbols', () => {
    const graph = new SymbolGraph();
    graph.addFile(
      'src/a.ts',
      [sym('pub', 'src/a.ts', { exported: true }), sym('priv', 'src/a.ts', { exported: false })],
      [],
      'h1',
    );

    const exports = graph.getExportsOf('src/a.ts');
    expect(exports).toHaveLength(1);
    expect(exports[0].name).toBe('pub');
  });

  it('findReferences finds usages in importing files', () => {
    const graph = new SymbolGraph();
    // Use the same key for import toFile and the defining file
    graph.addFile('src/utils.ts', [sym('helper', 'src/utils.ts')], [], 'h1');
    graph.addFile('src/app.ts', [], [imp('src/app.ts', 'src/utils.ts', ['helper'])], 'h2');

    // Provide file contents for searching
    graph.setFileContent('src/utils.ts', 'export function helper() { return 1; }');
    graph.setFileContent(
      'src/app.ts',
      "import { helper } from './utils';\nconst result = helper();\nconsole.log(result);",
    );

    const refs = graph.findReferences('helper');
    // Should find usage in app.ts (the call site), not the import line
    const appRefs = refs.filter((r) => r.file === 'src/app.ts');
    expect(appRefs.length).toBeGreaterThan(0);
    expect(appRefs.some((r) => r.context.includes('helper()'))).toBe(true);
  });

  it('findReferences returns empty for unknown symbols', () => {
    const graph = new SymbolGraph();
    expect(graph.findReferences('nonexistent')).toEqual([]);
  });

  it('toJSON and fromJSON round-trip', () => {
    const graph = new SymbolGraph();
    graph.addFile('src/a.ts', [sym('foo', 'src/a.ts', { type: 'class', exported: true })], [], 'h1');
    graph.addFile('src/b.ts', [sym('bar', 'src/b.ts')], [imp('src/b.ts', 'src/a', ['foo'])], 'h2');

    const json = graph.toJSON();
    expect(json.version).toBe(1);
    expect(json.symbols).toHaveLength(2);
    expect(json.imports).toHaveLength(1);

    const restored = SymbolGraph.fromJSON(json);
    expect(restored).not.toBeNull();
    expect(restored!.lookupSymbol('foo')).toHaveLength(1);
    expect(restored!.lookupSymbol('foo')[0].type).toBe('class');
    expect(restored!.getDependencies('src/b.ts')).toEqual(['src/a']);
    expect(restored!.getDependents('src/a')).toEqual(['src/b.ts']);
    expect(restored!.getFileHash('src/a.ts')).toBe('h1');
  });

  it('fromJSON returns null for wrong version', () => {
    const data = { version: 999, buildTime: '', symbols: [], imports: [], fileHashes: {} };
    expect(SymbolGraph.fromJSON(data)).toBeNull();
  });

  it('symbolCount and fileCount', () => {
    const graph = new SymbolGraph();
    graph.addFile('a.ts', [sym('x', 'a.ts'), sym('y', 'a.ts')], [], 'h1');
    graph.addFile('b.ts', [sym('z', 'b.ts')], [], 'h2');

    expect(graph.symbolCount()).toBe(3);
    expect(graph.fileCount()).toBe(2);
  });

  it('getSymbolContext formats symbol info', () => {
    const graph = new SymbolGraph();
    graph.addFile('src/a.ts', [sym('myFunc', 'src/a.ts', { exported: true })], [], 'h1');
    graph.addFile('src/b.ts', [], [imp('src/b.ts', 'src/a.ts', ['myFunc'])], 'h2');

    const ctx = graph.getSymbolContext('myFunc', 500);
    expect(ctx).toContain('myFunc');
    expect(ctx).toContain('src/a.ts');
    expect(ctx).toContain('src/b.ts');
  });

  it('getFileGraphContext shows dependencies', () => {
    const graph = new SymbolGraph();
    graph.addFile('src/a.ts', [], [], 'h1');
    graph.addFile('src/b.ts', [], [imp('src/b.ts', 'src/a.ts', ['foo'])], 'h2');
    graph.addFile('src/c.ts', [], [imp('src/c.ts', 'src/b.ts', ['bar'])], 'h3');

    const ctx = graph.getFileGraphContext(['src/b.ts'], 1000);
    expect(ctx).toContain('src/b.ts');
    expect(ctx).toContain('Imports:');
    expect(ctx).toContain('Used by:');
  });
});
