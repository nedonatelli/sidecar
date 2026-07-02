import { describe, it, expect } from 'vitest';
import { generateMutants, maskStringsAndComments } from './mutationOperators.js';

describe('maskStringsAndComments', () => {
  it('blanks string content but keeps delimiters and length', () => {
    const src = 'x = "a < b" + 1';
    const masked = maskStringsAndComments(src);
    expect(masked).toHaveLength(src.length);
    expect(masked).toBe('x = "     " + 1'); // the `<` inside the string is gone
  });

  it('blanks line comments (# and //)', () => {
    for (const src of ['a = 1 # x < y', 'a = 1 // x < y']) {
      const masked = maskStringsAndComments(src);
      expect(masked).toHaveLength(src.length);
      expect(masked.includes('<')).toBe(false);
      expect(masked.trimEnd()).toBe('a = 1'); // code kept, comment blanked
    }
  });

  it('blanks python triple-quoted strings', () => {
    const src = 'd = """a and b < c""" + z';
    const masked = maskStringsAndComments(src);
    expect(masked).toHaveLength(src.length);
    expect(masked.includes('and')).toBe(false);
    expect(masked.includes('<')).toBe(false);
    expect(masked.endsWith('+ z')).toBe(true);
  });

  it('preserves newlines inside masked regions', () => {
    const src = '/* line1 < \n line2 > */\na < b';
    const masked = maskStringsAndComments(src);
    expect((masked.match(/\n/g) || []).length).toBe(2);
    expect(masked.trimStart().startsWith('a < b') || masked.endsWith('a < b')).toBe(true);
  });
});

describe('generateMutants — relational', () => {
  it('flips < to >= and > to <=', () => {
    const mutants = generateMutants('if a < b and c > d:', { operators: ['relational'] });
    const swaps = mutants.map((m) => `${m.original}->${m.replacement}`);
    expect(swaps).toContain('<->>=');
    expect(swaps).toContain('>-><=');
  });

  it('handles <= and >= without splitting into < / >', () => {
    const mutants = generateMutants('x <= 3; y >= 4', { operators: ['relational'] });
    const originals = mutants.map((m) => m.original).sort();
    expect(originals).toEqual(['<=', '>=']);
  });

  it('flips equality == to != and != to ==', () => {
    const mutants = generateMutants('a == b or c != d', { operators: ['relational'] });
    const swaps = mutants.map((m) => `${m.original}->${m.replacement}`).sort();
    expect(swaps).toEqual(['!=->==', '==->!=']);
  });

  it('does NOT mutate the arrow => or generics-free comparisons inside strings', () => {
    const mutants = generateMutants('const f = (x) => x < 2; const s = "a<b";', { operators: ['relational'] });
    // only the real `<` (x < 2) mutates; `=>` and the string `<` do not.
    expect(mutants).toHaveLength(1);
    expect(mutants[0].original).toBe('<');
  });

  it('each mutant changes exactly one occurrence', () => {
    const src = 'a < b < c';
    const mutants = generateMutants(src, { operators: ['relational'] });
    expect(mutants).toHaveLength(2);
    // First mutant flips the first `<` only, leaving the second intact.
    expect(mutants[0].mutatedSource).toBe('a >= b < c');
    expect(mutants[1].mutatedSource).toBe('a < b >= c');
  });
});

describe('generateMutants — arithmetic / logical / boolean', () => {
  it('flips spaced binary arithmetic but not ++ / += / *args', () => {
    const mutants = generateMutants('total = a + b; i++; n += 1; f(*args)', { operators: ['arithmetic'] });
    expect(mutants).toHaveLength(1);
    expect(`${mutants[0].original}->${mutants[0].replacement}`).toBe('+->-');
  });

  it('flips && / || and python and / or', () => {
    const js = generateMutants('x && y || z', { operators: ['logical'] }).map((m) => m.original);
    expect(js.sort()).toEqual(['&&', '||']);
    const py = generateMutants('a and b or c', { operators: ['logical'] }).map((m) => m.original);
    expect(py.sort()).toEqual(['and', 'or']);
  });

  it('does not treat "android" as the operator "and"', () => {
    const mutants = generateMutants('phone = "android"; ok = a and b', { operators: ['logical'] });
    expect(mutants).toHaveLength(1); // only the real `and`, not the substring in the string
    expect(mutants[0].original).toBe('and');
  });

  it('flips boolean literals True/False and true/false', () => {
    const mutants = generateMutants('a = True; b = false', { operators: ['boolean-literal'] });
    const swaps = mutants.map((m) => `${m.original}->${m.replacement}`).sort();
    expect(swaps).toEqual(['True->False', 'false->true']);
  });
});

describe('generateMutants — options', () => {
  it('respects maxMutants cap', () => {
    const src = 'a < b < c < d < e';
    expect(generateMutants(src, { operators: ['relational'], maxMutants: 2 })).toHaveLength(2);
  });

  it('records 1-based line numbers', () => {
    const src = 'x = 1\nif a < b:\n    pass';
    const [m] = generateMutants(src, { operators: ['relational'] });
    expect(m.line).toBe(2);
  });

  it('produces deterministic ids ordered by operator then position', () => {
    const ids = generateMutants('a < b + c', {}).map((m) => m.id);
    expect(ids).toEqual(['relational#1', 'arithmetic#1']);
  });
});
