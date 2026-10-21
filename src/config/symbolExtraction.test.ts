import { describe, it, expect } from 'vitest';
import { extractSymbolInputs, symbolInputsFrom } from './symbolExtraction.js';

// #113: the analyzers report 0-based inclusive line ranges; SymbolEmbedInput's
// are 1-based. symbolInputsFrom read them as 1-based, so every embedded body
// began one line above the symbol, lost its last line, and
// project_knowledge_search reported each symbol one line too high.

const SOURCE = [
  '// header comment', //            line 1
  'import { x } from "./x.js";', //   line 2
  '', //                              line 3
  'export function first(a: number): number {', // line 4
  '  return a + x;', //               line 5
  '}', //                             line 6
  '', //                              line 7
  'export function second(): void {', // line 8
  '  first(1);', //                   line 9
  '}', //                             line 10
  '',
].join('\n');

describe('symbol line ranges and bodies (#113)', () => {
  it('a real parse gives 1-based ranges and bodies from the declaration to the closing brace', async () => {
    const inputs = await extractSymbolInputs('src/m.ts', SOURCE);
    const first = inputs.find((s) => s.name === 'first');
    const second = inputs.find((s) => s.name === 'second');
    expect(first).toMatchObject({ startLine: 4, endLine: 6 });
    expect(first!.body).toBe('export function first(a: number): number {\n  return a + x;\n}');
    expect(second).toMatchObject({ startLine: 8, endLine: 10 });
    expect(second!.body.split('\n')[0]).toBe('export function second(): void {');
    expect(second!.body.endsWith('}')).toBe(true);
  });

  it('symbolInputsFrom maps a 0-based inclusive range to the same lines, reported 1-based', () => {
    const [s] = symbolInputsFrom('src/m.ts', SOURCE, [
      { name: 'first', qualifiedName: 'first', kind: 'function', startLine: 3, endLine: 5 },
    ]);
    expect(s).toMatchObject({ startLine: 4, endLine: 6 });
    expect(s.body.split('\n')).toHaveLength(3);
  });

  it('a one-line symbol on the first line keeps its line', () => {
    const [s] = symbolInputsFrom('a.ts', 'export const A = 1;\n', [
      { name: 'A', qualifiedName: 'A', kind: 'variable', startLine: 0, endLine: 0 },
    ]);
    expect(s).toMatchObject({ startLine: 1, endLine: 1, body: 'export const A = 1;' });
  });
});
