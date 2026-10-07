import { describe, it, expect } from 'vitest';
import { matchGlob } from './glob.js';

// #119: `**/` required at least one directory, so `src/**/*.ts` missed `src/x.ts`.
describe('matchGlob', () => {
  it('lets **/ match zero or more directories', () => {
    for (const f of ['src/x.ts', 'src/a/x.ts', 'src/a/b/x.ts']) expect(matchGlob('src/**/*.ts', f)).toBe(true);
    expect(matchGlob('**/*.ts', 'x.ts')).toBe(true);
    expect(matchGlob('**/*.ts', 'a/b/x.ts')).toBe(true);
  });

  it('keeps * and ? within one segment', () => {
    expect(matchGlob('src/*.ts', 'src/a/x.ts')).toBe(false);
    expect(matchGlob('src/?.ts', 'src/x.ts')).toBe(true);
    expect(matchGlob('src/?.ts', 'src/xy.ts')).toBe(false);
  });

  it('treats a trailing or mid-segment ** as any characters', () => {
    expect(matchGlob('src/**', 'src/a/b')).toBe(true);
    expect(matchGlob('src/a**z', 'src/a/b/z')).toBe(true);
  });

  it('escapes regex characters and accepts Windows paths', () => {
    expect(matchGlob('a+b/(x).ts', 'a+b/(x).ts')).toBe(true);
    expect(matchGlob('src/**/*.ts', String.raw`src\a\x.ts`)).toBe(true);
  });
});
