import { describe, it, expect } from 'vitest';
import { getRegexAnalyzer } from './registry.js';

describe('CodeAnalyzer registry', () => {
  const analyzer = getRegexAnalyzer();

  it('returns an analyzer with supportedExtensions', () => {
    expect(analyzer.supportedExtensions).toBeInstanceOf(Set);
    expect(analyzer.supportedExtensions.has('ts')).toBe(true);
    expect(analyzer.supportedExtensions.has('py')).toBe(true);
    expect(analyzer.supportedExtensions.has('rs')).toBe(true);
    expect(analyzer.supportedExtensions.has('go')).toBe(true);
  });

  it('does not support unknown extensions', () => {
    expect(analyzer.supportedExtensions.has('txt')).toBe(false);
    expect(analyzer.supportedExtensions.has('md')).toBe(false);
    expect(analyzer.supportedExtensions.has('json')).toBe(false);
  });

  it('parseFileContent returns a ParsedFile', () => {
    const result = analyzer.parseFileContent('test.ts', 'function hello() { return 1; }');
    expect(result).toHaveProperty('filePath', 'test.ts');
    expect(result).toHaveProperty('elements');
    expect(result).toHaveProperty('content');
    expect(result.elements.length).toBeGreaterThan(0);
  });

  it('parseFileContent extracts TypeScript functions', () => {
    const code = `export function greet(name: string): string {\n  return 'Hello ' + name;\n}`;
    const result = analyzer.parseFileContent('utils.ts', code);
    const funcs = result.elements.filter((e) => e.type === 'function');
    expect(funcs.length).toBeGreaterThanOrEqual(1);
    expect(funcs[0].name).toBe('greet');
  });

  it('parseFileContent extracts Python functions', () => {
    const code = `def calculate(x, y):\n    return x + y\n`;
    const result = analyzer.parseFileContent('math.py', code);
    const funcs = result.elements.filter((e) => e.type === 'function');
    expect(funcs.length).toBeGreaterThanOrEqual(1);
    expect(funcs[0].name).toBe('calculate');
  });

  it('findRelevantElements scores by query match', () => {
    const code = `function fetchUsers() {}\nfunction processData() {}\nfunction renderChart() {}`;
    const parsed = analyzer.parseFileContent('app.ts', code);
    const relevant = analyzer.findRelevantElements(parsed, 'fetch users from API');
    expect(relevant.length).toBeGreaterThan(0);
    expect(relevant[0].name).toBe('fetchUsers');
  });

  it('extractRelevantContent returns content string', () => {
    const code = `function a() {}\nfunction b() {}\nfunction c() {}`;
    const parsed = analyzer.parseFileContent('test.ts', code);
    const relevant = analyzer.findRelevantElements(parsed, 'a');
    const content = analyzer.extractRelevantContent(parsed, relevant);
    expect(typeof content).toBe('string');
    expect(content.length).toBeGreaterThan(0);
  });

  it('getRegexAnalyzer returns the same instance', () => {
    const a = getRegexAnalyzer();
    const b = getRegexAnalyzer();
    expect(a).toBe(b);
  });
});
