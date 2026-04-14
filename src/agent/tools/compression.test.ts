import { describe, it, expect } from 'vitest';
import {
  compressGrepOutput,
  compressGitDiff,
  compactSourceFile,
  outlineSourceFile,
  truncateMiddle,
} from './compression.js';

describe('compressGrepOutput', () => {
  it('returns empty input unchanged', () => {
    expect(compressGrepOutput('')).toBe('');
  });

  it('groups matches by file so the path is written once per file', () => {
    const raw = ['src/a.ts:12:const x = 1;', 'src/a.ts:34:const y = 2;', 'src/b.ts:5:const z = 3;'].join('\n');
    const result = compressGrepOutput(raw);
    expect(result).toBe(
      ['src/a.ts', '  12: const x = 1;', '  34: const y = 2;', 'src/b.ts', '  5: const z = 3;'].join('\n'),
    );
  });

  it('collapses runs of identical match bodies with a (×N) marker', () => {
    const raw = [
      'src/a.ts:10:import foo from "bar";',
      'src/a.ts:11:import foo from "bar";',
      'src/a.ts:12:import foo from "bar";',
      'src/a.ts:13:something else;',
    ].join('\n');
    const result = compressGrepOutput(raw);
    expect(result).toContain('(×3)');
    expect(result).toContain('something else');
  });

  it('truncates long match bodies in the middle', () => {
    const body = 'A'.repeat(200) + 'KEYWORD' + 'B'.repeat(200);
    const raw = `src/huge.ts:1:${body}`;
    const result = compressGrepOutput(raw, 80);
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(raw.length);
  });

  it('preserves lines that do not match the path:line:content shape', () => {
    const raw = ['Binary file src/bin matches', 'src/a.ts:1:text'].join('\n');
    const result = compressGrepOutput(raw);
    expect(result).toContain('Binary file src/bin matches');
    expect(result).toContain('src/a.ts');
  });

  it('returns raw input when nothing matches the grep pattern', () => {
    expect(compressGrepOutput('No matches found.')).toBe('No matches found.');
  });
});

describe('truncateMiddle', () => {
  it('leaves short strings unchanged', () => {
    expect(truncateMiddle('hello', 20)).toBe('hello');
  });

  it('ellipsizes the middle when over max', () => {
    const s = 'a'.repeat(50) + 'b'.repeat(50);
    const result = truncateMiddle(s, 20);
    expect(result).toContain('...');
    expect(result.length).toBeLessThanOrEqual(20);
  });
});

describe('compressGitDiff', () => {
  it('drops index blob hashes', () => {
    const raw = [
      'diff --git a/x b/x',
      'index abc1234..def5678 100644',
      '--- a/x',
      '+++ b/x',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    const result = compressGitDiff(raw);
    expect(result).not.toContain('index abc1234..def5678');
  });

  it('drops the diff --git preamble', () => {
    const raw = ['diff --git a/foo b/foo', '--- a/foo', '+++ b/foo'].join('\n');
    const result = compressGitDiff(raw);
    expect(result).not.toContain('diff --git');
    expect(result).toContain('--- a/foo');
    expect(result).toContain('+++ b/foo');
  });

  it('drops file-mode, rename, and similarity headers', () => {
    const raw = [
      'diff --git a/a b/b',
      'similarity index 95%',
      'rename from a',
      'rename to b',
      'new file mode 100644',
      'deleted file mode 100644',
      'old mode 100644',
      'new mode 100755',
      '--- a/a',
      '+++ b/b',
    ].join('\n');
    const result = compressGitDiff(raw);
    expect(result).not.toContain('similarity index');
    expect(result).not.toContain('rename from');
    expect(result).not.toContain('rename to');
    expect(result).not.toContain('new file mode');
    expect(result).not.toContain('deleted file mode');
    expect(result).not.toContain('old mode');
    expect(result).not.toContain('new mode');
  });

  it('preserves actual change lines verbatim', () => {
    const raw = ['--- a/x', '+++ b/x', '@@ -1,3 +1,3 @@', ' unchanged', '-removed line', '+added line'].join('\n');
    const result = compressGitDiff(raw);
    expect(result).toContain('-removed line');
    expect(result).toContain('+added line');
    expect(result).toContain(' unchanged');
    expect(result).toContain('@@ -1,3 +1,3 @@');
  });

  it('is a no-op on empty input', () => {
    expect(compressGitDiff('')).toBe('');
  });
});

describe('compactSourceFile', () => {
  it('strips block comments', () => {
    const src = '/* this is a block comment */\nexport const x = 1;';
    expect(compactSourceFile(src)).not.toContain('block comment');
    expect(compactSourceFile(src)).toContain('export const x = 1;');
  });

  it('strips JSDoc blocks', () => {
    const src = [
      '/**',
      ' * @param name a name',
      ' * @returns greeting',
      ' */',
      'export function greet(name: string) { return "hi " + name; }',
    ].join('\n');
    const result = compactSourceFile(src);
    expect(result).not.toContain('@param');
    expect(result).not.toContain('@returns');
    expect(result).toContain('export function greet');
  });

  it('strips full-line // comments but preserves trailing inline comments', () => {
    const src = ['// top-level note', 'const x = 1; // inline note', '// another'].join('\n');
    const result = compactSourceFile(src);
    expect(result).not.toContain('top-level note');
    expect(result).not.toContain('another');
    expect(result).toContain('inline note');
  });

  it('strips full-line # comments but preserves shebangs', () => {
    const src = ['#!/usr/bin/env python', '# a comment', 'print("hi")'].join('\n');
    const result = compactSourceFile(src);
    expect(result).toContain('#!/usr/bin/env python');
    expect(result).not.toContain('# a comment');
    expect(result).toContain('print("hi")');
  });

  it('collapses runs of more than one blank line to a single blank line', () => {
    const src = ['a', '', '', '', 'b'].join('\n');
    expect(compactSourceFile(src)).toBe(['a', '', 'b'].join('\n'));
  });

  it('trims trailing whitespace', () => {
    const src = 'const x = 1;   \nconst y = 2;\t\t\n';
    const result = compactSourceFile(src);
    expect(result.split('\n')[0]).toBe('const x = 1;');
    expect(result.split('\n')[1]).toBe('const y = 2;');
  });

  it('is a no-op on empty input', () => {
    expect(compactSourceFile('')).toBe('');
  });
});

describe('outlineSourceFile', () => {
  it('extracts function and class declarations', () => {
    const src = [
      'import { foo } from "bar";',
      '',
      'export function handleRequest(req: Request) {',
      '  const body = req.body;',
      '  return body;',
      '}',
      '',
      'export class Server {',
      '  listen(port: number) {',
      '    // impl',
      '  }',
      '}',
    ].join('\n');
    const result = outlineSourceFile(src);
    expect(result).toContain('import { foo } from "bar";');
    expect(result).toContain('export function handleRequest(req: Request)');
    expect(result).toContain('export class Server');
    expect(result).not.toContain('const body = req.body');
  });

  it('strips trailing { on signature lines', () => {
    const src = 'function handleRequest(req: Request) {\n  return req;\n}';
    const result = outlineSourceFile(src);
    expect(result).toBe('function handleRequest(req: Request)');
  });

  it('recognizes Python def declarations', () => {
    const src = ['import os', 'def handler(event):', '    return event'].join('\n');
    const result = outlineSourceFile(src);
    expect(result).toContain('def handler(event):');
    expect(result).toContain('import os');
  });

  it('recognizes Go and Rust declarations', () => {
    const src = ['package main', 'func Handler(w ResponseWriter)', 'fn process() -> i32'].join('\n');
    const result = outlineSourceFile(src);
    expect(result).toContain('package main');
    expect(result).toContain('func Handler');
    expect(result).toContain('fn process');
  });

  it('falls back to first 40 lines when no declarations match', () => {
    const src = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const result = outlineSourceFile(src);
    expect(result).toContain('line 0');
    expect(result).toContain('line 39');
    expect(result).not.toContain('line 40');
    expect(result).toContain('outline heuristic matched nothing');
  });

  it('is a no-op on empty input', () => {
    expect(outlineSourceFile('')).toBe('');
  });
});
