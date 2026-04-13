import { describe, it, expect } from 'vitest';
import {
  extractCodeBlocks,
  extractCalls,
  countTopLevelArgs,
  findExportedFunctions,
  detectStaleReferences,
  analyzeReadme,
  type ExportedFunction,
} from './readmeSync.js';

// ---------------------------------------------------------------------------
// extractCodeBlocks
// ---------------------------------------------------------------------------

describe('extractCodeBlocks', () => {
  it('extracts a single ts code block', () => {
    const md = '# Title\n\n```ts\nfoo(1, 2);\n```\n';
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe('ts');
    expect(blocks[0].startLine).toBe(3);
    expect(blocks[0].endLine).toBe(3);
    expect(blocks[0].codeLines).toEqual(['foo(1, 2);']);
  });

  it('extracts multiple blocks in one file', () => {
    const md = ['# Doc', '', '```ts', 'a();', '```', '', '```js', 'b(1);', '```'].join('\n');
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].lang).toBe('ts');
    expect(blocks[1].lang).toBe('js');
  });

  it('ignores fences tagged with unsupported languages', () => {
    const md = '```python\nprint("hi")\n```\n';
    expect(extractCodeBlocks(md)).toHaveLength(0);
  });

  it('normalizes language tags to lowercase', () => {
    const md = '```TS\nfoo();\n```\n';
    const blocks = extractCodeBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe('ts');
  });

  it('silently skips unterminated blocks', () => {
    const md = '# A\n\n```ts\nfoo();\nbar();';
    expect(extractCodeBlocks(md)).toHaveLength(0);
  });

  it('tracks absolute line numbers across blank lines', () => {
    const md = ['', '', '```ts', 'a();', 'b();', '```'].join('\n');
    const blocks = extractCodeBlocks(md);
    expect(blocks[0].startLine).toBe(3);
    expect(blocks[0].endLine).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// extractCalls
// ---------------------------------------------------------------------------

describe('extractCalls', () => {
  function block(lines: string[], startLine = 0) {
    return { lang: 'ts', startLine, endLine: startLine + lines.length - 1, codeLines: lines };
  }

  it('finds a simple call with positional args', () => {
    const calls = extractCalls(block(['foo(1, 2, 3);']));
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('foo');
    expect(calls[0].argCount).toBe(3);
  });

  it('reports a zero-arg call', () => {
    const calls = extractCalls(block(['go();']));
    expect(calls[0].argCount).toBe(0);
  });

  it('skips method calls like obj.foo()', () => {
    const calls = extractCalls(block(['obj.foo(1, 2);']));
    expect(calls).toHaveLength(0);
  });

  it('skips namespace access like Math.max()', () => {
    const calls = extractCalls(block(['Math.max(1, 2);']));
    expect(calls).toHaveLength(0);
  });

  it('skips constructor calls like new Foo()', () => {
    const calls = extractCalls(block(['new Foo(1, 2);']));
    expect(calls).toHaveLength(0);
  });

  it('skips control-flow keywords that resemble calls', () => {
    const calls = extractCalls(block(['if (x)', 'while (y)', 'for (let i = 0; i < n; i++)']));
    expect(calls).toHaveLength(0);
  });

  it('tracks absolute line numbers from the code block startLine', () => {
    const calls = extractCalls(block(['foo();'], 7));
    expect(calls[0].line).toBe(7);
  });

  it('tracks start / end column on a single line', () => {
    const calls = extractCalls(block(['  foo(1);']));
    expect(calls[0].startCol).toBe(2);
    // `foo(1)` is 6 characters, starting at column 2 → endCol is one past the `)`
    expect(calls[0].endCol).toBe(8);
    expect(calls[0].raw).toBe('foo(1)');
  });

  it('finds multiple calls on one line', () => {
    const calls = extractCalls(block(['a(); b(1);']));
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe('a');
    expect(calls[1].name).toBe('b');
  });

  it('counts commas inside generics as part of one argument', () => {
    const calls = extractCalls(block([`foo('Map<string, number>');`]));
    expect(calls[0].argCount).toBe(1);
  });

  it('skips multi-line calls rather than misparsing them', () => {
    // The MVP only understands single-line calls — multi-line should
    // silently produce no results, not a bad result.
    const calls = extractCalls(block(['foo(', '  1,', '  2,', ');']));
    // The line `foo(` has no matching `)` on the same line, so the simple
    // regex won't match it — no call extracted. This is the intended safe
    // failure mode.
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// countTopLevelArgs
// ---------------------------------------------------------------------------

describe('countTopLevelArgs', () => {
  it('returns 0 for empty string', () => {
    expect(countTopLevelArgs('')).toBe(0);
  });

  it('returns 0 for whitespace', () => {
    expect(countTopLevelArgs('   ')).toBe(0);
  });

  it('counts simple positional args', () => {
    expect(countTopLevelArgs('1, 2, 3')).toBe(3);
  });

  it('does not split on commas inside object literals', () => {
    expect(countTopLevelArgs('{ a: 1, b: 2 }, 3')).toBe(2);
  });

  it('does not split on commas inside arrays', () => {
    expect(countTopLevelArgs('[1, 2, 3], 4')).toBe(2);
  });

  it('does not split on commas inside generics', () => {
    expect(countTopLevelArgs('Map<string, number>, 42')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// findExportedFunctions
// ---------------------------------------------------------------------------

describe('findExportedFunctions', () => {
  it('finds an exported function declaration', () => {
    const src = `export function add(a: number, b: number): number { return a + b; }`;
    const fns = findExportedFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('add');
    expect(fns[0].paramNames).toEqual(['a', 'b']);
  });

  it('finds an exported const arrow', () => {
    const src = `export const double = (x: number) => x * 2;`;
    const fns = findExportedFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('double');
    expect(fns[0].paramNames).toEqual(['x']);
  });

  it('finds an exported async function', () => {
    const src = `export async function fetchData(url: string): Promise<unknown> { return fetch(url); }`;
    const fns = findExportedFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('fetchData');
  });

  it('skips non-exported functions', () => {
    const src = `function internal(a: number) {}`;
    expect(findExportedFunctions(src)).toHaveLength(0);
  });

  it('flags functions with destructured params', () => {
    const src = `export function configure({ host, port }: Opts) {}`;
    const fns = findExportedFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].hasDestructuredOrRest).toBe(true);
  });

  it('flags functions with rest params', () => {
    const src = `export function spread(a: string, ...rest: string[]) {}`;
    const fns = findExportedFunctions(src);
    expect(fns[0].hasDestructuredOrRest).toBe(true);
    expect(fns[0].paramNames).toEqual(['a']);
  });

  it('handles multiple exports in one file', () => {
    const src = `export function one(a: number) {}
export function two(a: string, b: string) {}
function hidden() {}
export const three = (x: number, y: number, z: number) => x + y + z;`;
    const fns = findExportedFunctions(src);
    expect(fns.map((f) => f.name)).toEqual(['one', 'two', 'three']);
    expect(fns.map((f) => f.paramNames.length)).toEqual([1, 2, 3]);
  });

  it('tracks the declaration line', () => {
    const src = `// header\n\nexport function foo(a: number) {}`;
    const fns = findExportedFunctions(src);
    expect(fns[0].declLine).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// detectStaleReferences
// ---------------------------------------------------------------------------

function makeExports(fns: ExportedFunction[]): Map<string, ExportedFunction> {
  return new Map(fns.map((f) => [f.name, f]));
}

function exp(name: string, paramNames: string[], extras: Partial<ExportedFunction> = {}): ExportedFunction {
  return {
    name,
    paramNames,
    hasDestructuredOrRest: false,
    declLine: 0,
    ...extras,
  };
}

describe('detectStaleReferences', () => {
  it('returns empty when a call matches its signature', () => {
    const md = '```ts\nfoo(1, 2);\n```';
    const exports = makeExports([exp('foo', ['a', 'b'])]);
    expect(detectStaleReferences(md, exports)).toEqual([]);
  });

  it('flags a call with too many args', () => {
    const md = '```ts\nfoo(1, 2, 3);\n```';
    const exports = makeExports([exp('foo', ['a', 'b'])]);
    const stale = detectStaleReferences(md, exports);
    expect(stale).toHaveLength(1);
    expect(stale[0].expected).toBe(2);
    expect(stale[0].actual).toBe(3);
    expect(stale[0].fn.name).toBe('foo');
  });

  it('flags a call with too few args', () => {
    const md = '```ts\nfoo(1);\n```';
    const exports = makeExports([exp('foo', ['a', 'b'])]);
    const stale = detectStaleReferences(md, exports);
    expect(stale).toHaveLength(1);
    expect(stale[0].expected).toBe(2);
    expect(stale[0].actual).toBe(1);
  });

  it('ignores calls to unknown (non-workspace) functions', () => {
    const md = '```ts\nunknown(1, 2, 3);\n```';
    const exports = makeExports([exp('foo', ['a', 'b'])]);
    expect(detectStaleReferences(md, exports)).toEqual([]);
  });

  it('never flags functions with destructured or rest params', () => {
    const md = '```ts\nconfigure(1, 2, 3);\n```';
    const exports = makeExports([exp('configure', [], { hasDestructuredOrRest: true })]);
    expect(detectStaleReferences(md, exports)).toEqual([]);
  });

  it('ignores calls in prose (non-fenced text)', () => {
    const md = 'Call foo(1, 2, 3) in your code.';
    const exports = makeExports([exp('foo', ['a', 'b'])]);
    expect(detectStaleReferences(md, exports)).toEqual([]);
  });

  it('ignores inline-backtick code spans', () => {
    const md = 'Use `foo(1, 2, 3)` as shown.';
    const exports = makeExports([exp('foo', ['a', 'b'])]);
    // Inline-backtick isn't a fenced block, so the extractor ignores it.
    // Documented limitation of the MVP.
    expect(detectStaleReferences(md, exports)).toEqual([]);
  });

  it('tracks the absolute line inside the markdown file', () => {
    const md = ['# Title', '', 'Some prose.', '', '```ts', 'foo(1);', '```'].join('\n');
    const exports = makeExports([exp('foo', ['a', 'b'])]);
    const stale = detectStaleReferences(md, exports);
    expect(stale).toHaveLength(1);
    expect(stale[0].call.line).toBe(5); // 0-based: the `foo(1);` line
  });

  it('reports multiple stale calls in one block', () => {
    const md = '```ts\nfoo(1);\nbar(1, 2, 3);\n```';
    const exports = makeExports([exp('foo', ['a', 'b']), exp('bar', ['a'])]);
    const stale = detectStaleReferences(md, exports);
    expect(stale).toHaveLength(2);
    expect(stale.map((s) => s.fn.name).sort()).toEqual(['bar', 'foo']);
  });
});

// ---------------------------------------------------------------------------
// analyzeReadme — end-to-end
// ---------------------------------------------------------------------------

describe('analyzeReadme', () => {
  it('parses markdown and returns stale references in one call', () => {
    const md = '# Usage\n\n```ts\nadd(1);\n```\n';
    const exports = makeExports([exp('add', ['a', 'b'])]);
    const stale = analyzeReadme(md, exports);
    expect(stale).toHaveLength(1);
    expect(stale[0].fn.name).toBe('add');
  });
});
