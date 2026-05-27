import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('setGrammarsPath + getAnalyzer (lazy tree-sitter load)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns regexAnalyzer immediately when no grammarsPath has been set', async () => {
    const { getAnalyzer, getRegexAnalyzer: getRegex } = await import('./registry.js');
    const analyzer = await getAnalyzer('ts');
    expect(analyzer).toBe(getRegex());
  });

  it('uses tree-sitter analyzer for supported extension after successful load', async () => {
    const mockTreeSitterAnalyzer = {
      supportedExtensions: new Set(['ts', 'js']),
      parseFileContent: vi.fn(),
      findRelevantElements: vi.fn(),
      extractRelevantContent: vi.fn(),
    };
    vi.doMock('./treeSitterAnalyzer.js', () => ({
      createTreeSitterAnalyzer: vi.fn().mockResolvedValue(mockTreeSitterAnalyzer),
    }));

    const { setGrammarsPath, getAnalyzer } = await import('./registry.js');
    setGrammarsPath('/grammars');
    const analyzer = await getAnalyzer('ts');
    expect(analyzer).toBe(mockTreeSitterAnalyzer);
  });

  it('returns regexAnalyzer for an extension not in the tree-sitter set', async () => {
    vi.doMock('./treeSitterAnalyzer.js', () => ({
      createTreeSitterAnalyzer: vi.fn().mockResolvedValue({
        supportedExtensions: new Set(['ts']),
        parseFileContent: vi.fn(),
        findRelevantElements: vi.fn(),
        extractRelevantContent: vi.fn(),
      }),
    }));

    const { setGrammarsPath, getAnalyzer, getRegexAnalyzer: getRegex } = await import('./registry.js');
    setGrammarsPath('/grammars');
    const analyzer = await getAnalyzer('txt');
    expect(analyzer).toBe(getRegex());
  });

  it('falls back to regexAnalyzer when module has no createTreeSitterAnalyzer export', async () => {
    vi.doMock('./treeSitterAnalyzer.js', () => ({}));

    const { setGrammarsPath, getAnalyzer, getRegexAnalyzer: getRegex } = await import('./registry.js');
    setGrammarsPath('/grammars');
    const analyzer = await getAnalyzer('ts');
    expect(analyzer).toBe(getRegex());
  });

  it('falls back to regexAnalyzer when createTreeSitterAnalyzer rejects', async () => {
    vi.doMock('./treeSitterAnalyzer.js', () => ({
      createTreeSitterAnalyzer: vi.fn().mockRejectedValue(new Error('WASM unavailable')),
    }));

    const { setGrammarsPath, getAnalyzer, getRegexAnalyzer: getRegex } = await import('./registry.js');
    setGrammarsPath('/grammars');
    const analyzer = await getAnalyzer('ts');
    expect(analyzer).toBe(getRegex());
  });

  it('does not retry tree-sitter loading on subsequent getAnalyzer calls', async () => {
    const createTreeSitterAnalyzer = vi.fn().mockResolvedValue({
      supportedExtensions: new Set(['ts']),
      parseFileContent: vi.fn(),
      findRelevantElements: vi.fn(),
      extractRelevantContent: vi.fn(),
    });
    vi.doMock('./treeSitterAnalyzer.js', () => ({ createTreeSitterAnalyzer }));

    const { setGrammarsPath, getAnalyzer } = await import('./registry.js');
    setGrammarsPath('/grammars');

    await getAnalyzer('ts');
    await getAnalyzer('ts');
    await getAnalyzer('js');

    expect(createTreeSitterAnalyzer).toHaveBeenCalledTimes(1);
  });

  it('setGrammarsPath stores the path used for createTreeSitterAnalyzer', async () => {
    const createTreeSitterAnalyzer = vi.fn().mockResolvedValue({
      supportedExtensions: new Set(['ts']),
      parseFileContent: vi.fn(),
      findRelevantElements: vi.fn(),
      extractRelevantContent: vi.fn(),
    });
    vi.doMock('./treeSitterAnalyzer.js', () => ({ createTreeSitterAnalyzer }));

    const { setGrammarsPath, getAnalyzer } = await import('./registry.js');
    setGrammarsPath('/custom/grammars/path');
    await getAnalyzer('ts');

    expect(createTreeSitterAnalyzer).toHaveBeenCalledWith('/custom/grammars/path');
  });
});
