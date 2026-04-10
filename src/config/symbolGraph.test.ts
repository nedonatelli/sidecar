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
    expect(json.version).toBe(2);
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
    const data = { version: 999, buildTime: '', symbols: [], imports: [], calls: [], typeEdges: [], fileHashes: {} };
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

  it('addFile stores call edges and getCallers retrieves them', () => {
    const graph = new SymbolGraph();
    graph.addFile('src/a.ts', [sym('foo', 'src/a.ts'), sym('bar', 'src/a.ts')], [], 'h1', [
      { callerFile: 'src/a.ts', callerName: 'bar', calleeName: 'foo', line: 10 },
    ]);

    const callers = graph.getCallers('foo');
    expect(callers).toHaveLength(1);
    expect(callers[0].callerName).toBe('bar');
    expect(callers[0].line).toBe(10);
  });

  it('getCallsInFile returns calls from a file', () => {
    const graph = new SymbolGraph();
    graph.addFile('src/a.ts', [sym('foo', 'src/a.ts')], [], 'h1', [
      { callerFile: 'src/a.ts', callerName: 'foo', calleeName: 'console', line: 3 },
      { callerFile: 'src/a.ts', callerName: 'foo', calleeName: 'helper', line: 5 },
    ]);

    expect(graph.getCallsInFile('src/a.ts')).toHaveLength(2);
    expect(graph.getCallsInFile('src/b.ts')).toHaveLength(0);
  });

  it('removeFile cleans up call edge indexes', () => {
    const graph = new SymbolGraph();
    graph.addFile('src/a.ts', [sym('foo', 'src/a.ts')], [], 'h1', [
      { callerFile: 'src/a.ts', callerName: 'foo', calleeName: 'bar', line: 5 },
    ]);

    expect(graph.getCallers('bar')).toHaveLength(1);
    graph.removeFile('src/a.ts');
    expect(graph.getCallers('bar')).toHaveLength(0);
    expect(graph.getCallsInFile('src/a.ts')).toHaveLength(0);
  });

  it('addFile stores type edges and getSubtypes retrieves them', () => {
    const graph = new SymbolGraph();
    graph.addFile(
      'src/a.ts',
      [sym('Child', 'src/a.ts', { type: 'class' })],
      [],
      'h1',
      [],
      [{ childFile: 'src/a.ts', childName: 'Child', parentName: 'Parent', kind: 'extends' }],
    );

    const subtypes = graph.getSubtypes('Parent');
    expect(subtypes).toHaveLength(1);
    expect(subtypes[0].childName).toBe('Child');
    expect(subtypes[0].kind).toBe('extends');
  });

  it('getSupertypes returns parent types for a child', () => {
    const graph = new SymbolGraph();
    graph.addFile(
      'src/a.ts',
      [sym('MyClass', 'src/a.ts', { type: 'class' })],
      [],
      'h1',
      [],
      [
        { childFile: 'src/a.ts', childName: 'MyClass', parentName: 'Base', kind: 'extends' },
        { childFile: 'src/a.ts', childName: 'MyClass', parentName: 'Serializable', kind: 'implements' },
      ],
    );

    const supers = graph.getSupertypes('MyClass');
    expect(supers).toHaveLength(2);
    expect(supers.map((s) => s.parentName).sort()).toEqual(['Base', 'Serializable']);
  });

  it('removeFile cleans up type edge indexes', () => {
    const graph = new SymbolGraph();
    graph.addFile(
      'src/a.ts',
      [sym('Child', 'src/a.ts', { type: 'class' })],
      [],
      'h1',
      [],
      [{ childFile: 'src/a.ts', childName: 'Child', parentName: 'Parent', kind: 'extends' }],
    );

    expect(graph.getSubtypes('Parent')).toHaveLength(1);
    graph.removeFile('src/a.ts');
    expect(graph.getSubtypes('Parent')).toHaveLength(0);
    expect(graph.getTypeEdgesInFile('src/a.ts')).toHaveLength(0);
  });

  it('toJSON and fromJSON round-trip with calls and type edges', () => {
    const graph = new SymbolGraph();
    graph.addFile(
      'src/a.ts',
      [sym('foo', 'src/a.ts'), sym('Child', 'src/a.ts', { type: 'class' })],
      [],
      'h1',
      [{ callerFile: 'src/a.ts', callerName: 'foo', calleeName: 'bar', line: 10 }],
      [{ childFile: 'src/a.ts', childName: 'Child', parentName: 'Base', kind: 'extends' }],
    );

    const json = graph.toJSON();
    expect(json.calls).toHaveLength(1);
    expect(json.typeEdges).toHaveLength(1);

    const restored = SymbolGraph.fromJSON(json);
    expect(restored).not.toBeNull();
    expect(restored!.getCallers('bar')).toHaveLength(1);
    expect(restored!.getSubtypes('Base')).toHaveLength(1);
  });

  it('getSymbolContext includes callers and type hierarchy', () => {
    const graph = new SymbolGraph();
    graph.addFile(
      'src/a.ts',
      [sym('MyClass', 'src/a.ts', { type: 'class', exported: true })],
      [],
      'h1',
      [{ callerFile: 'src/b.ts', callerName: 'init', calleeName: 'MyClass', line: 5 }],
      [{ childFile: 'src/a.ts', childName: 'MyClass', parentName: 'BaseClass', kind: 'extends' }],
    );
    graph.addFile(
      'src/c.ts',
      [sym('SubClass', 'src/c.ts', { type: 'class' })],
      [],
      'h2',
      [],
      [{ childFile: 'src/c.ts', childName: 'SubClass', parentName: 'MyClass', kind: 'extends' }],
    );

    const ctx = graph.getSymbolContext('MyClass', 1000);
    expect(ctx).toContain('Called by:');
    expect(ctx).toContain('init');
    expect(ctx).toContain('Extends/implements:');
    expect(ctx).toContain('BaseClass');
    expect(ctx).toContain('Subtypes:');
    expect(ctx).toContain('SubClass');
  });
});
