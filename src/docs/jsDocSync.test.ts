import { describe, it, expect } from 'vitest';
import {
  splitTopLevel,
  parseParamList,
  extractParenContent,
  matchFunctionDeclaration,
  extractJsDocParams,
  findDocumentedFunctions,
  analyzeSource,
} from './jsDocSync.js';

describe('splitTopLevel', () => {
  it('splits on top-level separators', () => {
    expect(splitTopLevel('a, b, c', ',')).toEqual(['a', ' b', ' c']);
  });

  it('ignores separators inside parens', () => {
    expect(splitTopLevel('a, foo(b, c), d', ',')).toEqual(['a', ' foo(b, c)', ' d']);
  });

  it('ignores separators inside generics', () => {
    expect(splitTopLevel('a: Map<string, number>, b: string', ',')).toEqual(['a: Map<string, number>', ' b: string']);
  });

  it('ignores separators inside object type literals', () => {
    expect(splitTopLevel('a: { x: string, y: number }, b: string', ',')).toEqual([
      'a: { x: string, y: number }',
      ' b: string',
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(splitTopLevel('', ',')).toEqual([]);
  });
});

describe('parseParamList', () => {
  it('parses simple named params', () => {
    expect(parseParamList('a, b, c')).toEqual({ names: ['a', 'b', 'c'], hasDestructuredOrRest: false });
  });

  it('strips type annotations', () => {
    expect(parseParamList('a: string, b: number')).toEqual({
      names: ['a', 'b'],
      hasDestructuredOrRest: false,
    });
  });

  it('strips default values', () => {
    expect(parseParamList('a = 1, b: number = 2')).toEqual({
      names: ['a', 'b'],
      hasDestructuredOrRest: false,
    });
  });

  it('handles optional params', () => {
    expect(parseParamList('a?: string, b?: number')).toEqual({
      names: ['a', 'b'],
      hasDestructuredOrRest: false,
    });
  });

  it('flags rest params and skips them from names', () => {
    const r = parseParamList('a: string, ...rest: string[]');
    expect(r.names).toEqual(['a']);
    expect(r.hasDestructuredOrRest).toBe(true);
  });

  it('flags destructured object params', () => {
    const r = parseParamList('{ a, b }: Opts');
    expect(r.names).toEqual([]);
    expect(r.hasDestructuredOrRest).toBe(true);
  });

  it('flags destructured array params', () => {
    const r = parseParamList('[x, y]: [string, number]');
    expect(r.hasDestructuredOrRest).toBe(true);
  });

  it('skips TypeScript `this:` self-typing', () => {
    expect(parseParamList('this: Foo, a: string, b: number')).toEqual({
      names: ['a', 'b'],
      hasDestructuredOrRest: false,
    });
  });

  it('handles generic-heavy types without splitting on commas', () => {
    const r = parseParamList('a: Map<string, number>, b: Array<T>');
    expect(r.names).toEqual(['a', 'b']);
  });

  it('returns empty for empty list', () => {
    expect(parseParamList('')).toEqual({ names: [], hasDestructuredOrRest: false });
  });
});

describe('extractParenContent', () => {
  it('extracts single-line content', () => {
    const lines = ['function foo(a, b, c) {', '}'];
    const r = extractParenContent(lines, 0, 12);
    expect(r).toEqual({ content: 'a, b, c', endLine: 0 });
  });

  it('extracts multi-line content', () => {
    const lines = ['function foo(', '  a: string,', '  b: number,', ') {', '}'];
    const r = extractParenContent(lines, 0, 12);
    expect(r?.content).toContain('a: string');
    expect(r?.content).toContain('b: number');
    expect(r?.endLine).toBe(3);
  });

  it('handles nested parens', () => {
    const lines = ['function foo(a: (x: string) => number, b: number) {'];
    const r = extractParenContent(lines, 0, 12);
    expect(r?.content).toBe('a: (x: string) => number, b: number');
  });

  it('returns null for unbalanced input', () => {
    const lines = ['function foo(a, b'];
    expect(extractParenContent(lines, 0, 12)).toBeNull();
  });
});

describe('matchFunctionDeclaration', () => {
  it('matches a plain function declaration', () => {
    const lines = ['function foo(a: string) {}'];
    const r = matchFunctionDeclaration(lines, 0);
    expect(r?.name).toBe('foo');
    expect(r?.parenCol).toBe(12);
  });

  it('matches async function', () => {
    const lines = ['async function bar(x: number) {}'];
    const r = matchFunctionDeclaration(lines, 0);
    expect(r?.name).toBe('bar');
  });

  it('matches export function', () => {
    const lines = ['export function baz(q: string) {}'];
    const r = matchFunctionDeclaration(lines, 0);
    expect(r?.name).toBe('baz');
  });

  it('matches const arrow function', () => {
    const lines = ['const doStuff = (x: number) => x * 2;'];
    const r = matchFunctionDeclaration(lines, 0);
    expect(r?.name).toBe('doStuff');
  });

  it('matches export const async arrow', () => {
    const lines = ['export const fetchData = async (url: string) => { return url; };'];
    const r = matchFunctionDeclaration(lines, 0);
    expect(r?.name).toBe('fetchData');
  });

  it('matches generic function', () => {
    const lines = ['function identity<T>(value: T): T { return value; }'];
    const r = matchFunctionDeclaration(lines, 0);
    expect(r?.name).toBe('identity');
  });

  it('returns null for non-function lines', () => {
    expect(matchFunctionDeclaration(['const x = 5;'], 0)).toBeNull();
    expect(matchFunctionDeclaration(['if (foo(bar)) {}'], 0)).toBeNull();
  });
});

describe('extractJsDocParams', () => {
  it('extracts simple @param tags', () => {
    const src = ['/**', ' * @param a first', ' * @param b second', ' */'];
    const r = extractJsDocParams(src, 0, 3);
    expect(r.names).toEqual(['a', 'b']);
    expect(r.lineByName).toEqual([1, 2]);
  });

  it('extracts typed @param tags', () => {
    const src = ['/**', ' * @param {string} name The thing', ' * @param {number} count Count', ' */'];
    const r = extractJsDocParams(src, 0, 3);
    expect(r.names).toEqual(['name', 'count']);
  });

  it('returns empty arrays when no @param present', () => {
    const src = ['/**', ' * Just a description.', ' */'];
    const r = extractJsDocParams(src, 0, 2);
    expect(r.names).toEqual([]);
  });

  it('ignores @param mentions that appear mid-sentence in prose', () => {
    // A docstring describing the @param tag format should not be parsed as
    // if it declared real @param tags. Only start-of-line tags count.
    const src = [
      '/**',
      ' * Insert a new @param NAME line into the JSDoc block.',
      ' * The format follows @param {type} name convention.',
      ' */',
    ];
    const r = extractJsDocParams(src, 0, 3);
    expect(r.names).toEqual([]);
    expect(r.lineByName).toEqual([]);
  });

  it('still extracts tags that follow indentation + leading asterisk', () => {
    const src = ['/**', '   *   @param foo bar', ' */'];
    const r = extractJsDocParams(src, 0, 2);
    expect(r.names).toEqual(['foo']);
  });
});

describe('findDocumentedFunctions', () => {
  it('finds a simple documented function', () => {
    const src = `/**
 * Adds two numbers.
 * @param a first
 * @param b second
 */
function add(a: number, b: number): number {
  return a + b;
}`;
    const fns = findDocumentedFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('add');
    expect(fns[0].paramNames).toEqual(['a', 'b']);
    expect(fns[0].jsDocParamNames).toEqual(['a', 'b']);
  });

  it('finds documented arrow function', () => {
    const src = `/**
 * @param x value
 */
const double = (x: number) => x * 2;`;
    const fns = findDocumentedFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe('double');
    expect(fns[0].paramNames).toEqual(['x']);
  });

  it('skips functions with no leading JSDoc', () => {
    const src = `function undocumented(a: string) { return a; }`;
    expect(findDocumentedFunctions(src)).toHaveLength(0);
  });

  it('handles multiple documented functions in one file', () => {
    const src = `/**
 * @param a first
 */
function one(a: number) {}

/**
 * @param b second
 */
function two(b: string) {}`;
    const fns = findDocumentedFunctions(src);
    expect(fns).toHaveLength(2);
    expect(fns.map((f) => f.name)).toEqual(['one', 'two']);
  });

  it('handles multi-line parameter lists', () => {
    const src = `/**
 * @param a first
 * @param b second
 */
function wide(
  a: string,
  b: number,
): void {}`;
    const fns = findDocumentedFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].paramNames).toEqual(['a', 'b']);
  });

  it('flags destructured params', () => {
    const src = `/**
 * @param opts options
 */
function configure({ host, port }: { host: string; port: number }): void {}`;
    const fns = findDocumentedFunctions(src);
    expect(fns).toHaveLength(1);
    expect(fns[0].hasDestructuredOrRest).toBe(true);
  });

  it('does not match function calls that look like declarations', () => {
    const src = `/**
 * Top-level side effect.
 */
doSomething(a, b, c);`;
    const fns = findDocumentedFunctions(src);
    expect(fns).toHaveLength(0);
  });
});

describe('detectStaleTags', () => {
  it('reports no findings when JSDoc and signature match', () => {
    const src = `/**
 * @param a first
 * @param b second
 */
function ok(a: number, b: number) {}`;
    expect(analyzeSource(src)).toHaveLength(0);
  });

  it('reports orphan @param when signature removes a param', () => {
    const src = `/**
 * @param a first
 * @param b removed
 */
function shrunk(a: number) {}`;
    const findings = analyzeSource(src);
    expect(findings).toHaveLength(1);
    expect(findings[0].orphanTags).toEqual(['b']);
    expect(findings[0].missingTags).toEqual([]);
  });

  it('reports missing @param when signature adds a param', () => {
    const src = `/**
 * @param a first
 */
function grew(a: number, b: number) {}`;
    const findings = analyzeSource(src);
    expect(findings).toHaveLength(1);
    expect(findings[0].orphanTags).toEqual([]);
    expect(findings[0].missingTags).toEqual(['b']);
  });

  it('reports both orphan and missing on rename', () => {
    const src = `/**
 * @param oldName thing
 */
function renamed(newName: string) {}`;
    const findings = analyzeSource(src);
    expect(findings).toHaveLength(1);
    expect(findings[0].orphanTags).toEqual(['oldName']);
    expect(findings[0].missingTags).toEqual(['newName']);
  });

  it('ignores functions that use destructured params even when tags look wrong', () => {
    const src = `/**
 * @param oldThing obsolete
 */
function destr({ newThing }: { newThing: string }) {}`;
    expect(analyzeSource(src)).toHaveLength(0);
  });

  it('does not warn about functions with no @param tags at all', () => {
    const src = `/**
 * Just a description, no param tags.
 */
function silent(a: number, b: number) {}`;
    expect(analyzeSource(src)).toHaveLength(0);
  });

  it('ignores order-only differences', () => {
    const src = `/**
 * @param b second
 * @param a first
 */
function swapped(a: number, b: number) {}`;
    expect(analyzeSource(src)).toHaveLength(0);
  });
});
