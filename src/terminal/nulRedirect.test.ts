import { describe, it, expect } from 'vitest';
import { rewriteNulRedirects } from './nulRedirect.js';

describe('rewriteNulRedirects', () => {
  it.each([
    ['dir /s /b pmxbot 2>nul | head -5', 'dir /s /b pmxbot 2>/dev/null | head -5'],
    ['ls x >nul', 'ls x >/dev/null'],
    ['ls x > NUL', 'ls x > /dev/null'],
    ['ls x >>nul', 'ls x >>/dev/null'],
    ['ls x &>nul', 'ls x &>/dev/null'],
    ['ls x 2>>Nul', 'ls x 2>>/dev/null'],
    ['ls x >nul 2>&1', 'ls x >/dev/null 2>&1'],
    ['ls x 2>&1 >nul', 'ls x 2>&1 >/dev/null'],
    ['cmd <nul', 'cmd </dev/null'],
    ['a 2>nul; b 2>nul', 'a 2>/dev/null; b 2>/dev/null'],
    ['(a >nul)', '(a >/dev/null)'],
  ])('rewrites %s', (input, expected) => {
    expect(rewriteNulRedirects(input)).toBe(expected);
  });

  it.each([
    'echo nul',
    'ls x >null',
    'ls x >nul.txt',
    'ls x >nullable',
    'echo "2>nul"',
    "echo 'a >nul'",
    'ls x >"nul"',
    'ls x >nul"x"',
    'echo a \\>nul',
    'cat <<nul',
    'cat <<<nul',
    'grep -r nullptr src',
  ])('leaves %s alone', (input) => {
    expect(rewriteNulRedirects(input)).toBe(input);
  });

  it('rewrites the unquoted redirect next to a quoted argument', () => {
    expect(rewriteNulRedirects('grep "a >nul" f 2>nul')).toBe('grep "a >nul" f 2>/dev/null');
  });

  it('keeps an unterminated quote verbatim', () => {
    expect(rewriteNulRedirects('echo "x >nul')).toBe('echo "x >nul');
  });
});
