import { describe, it, expect } from 'vitest';
import { buildCodeActionPrompt, buildTerminalErrorPrompt, fileDisplayName } from './codeActions.js';

describe('buildCodeActionPrompt', () => {
  it('builds a prompt without diagnostic', () => {
    const result = buildCodeActionPrompt('Fix', 'const x = 1;', 'foo.ts');
    expect(result).toBe('Fix this code from foo.ts:\n```\nconst x = 1;\n```');
  });

  it('appends diagnostic block when provided', () => {
    const result = buildCodeActionPrompt('Explain', 'let x;', 'bar.ts', "Cannot find name 'x'");
    expect(result).toContain('Diagnostic reported by the editor:');
    expect(result).toContain("Cannot find name 'x'");
  });

  it('does not include diagnostic block when undefined', () => {
    const result = buildCodeActionPrompt('Refactor', 'fn();', 'a.ts', undefined);
    expect(result).not.toContain('Diagnostic');
  });
});

describe('buildTerminalErrorPrompt', () => {
  it('includes command, exit code, cwd and wrapped output', () => {
    const result = buildTerminalErrorPrompt({
      commandLine: 'npm test',
      exitCode: 1,
      cwd: '/home/user/project',
      output: 'Error: test failed',
    });
    expect(result).toContain('Command: `npm test`');
    expect(result).toContain('Exit code: 1');
    expect(result).toContain('Working directory: /home/user/project');
    expect(result).toContain('Error: test failed');
  });

  it('omits working-directory line when cwd is undefined', () => {
    const result = buildTerminalErrorPrompt({
      commandLine: 'ls',
      exitCode: 2,
      cwd: undefined,
      output: '',
    });
    expect(result).not.toContain('Working directory');
  });

  it('wraps output in the untrusted terminal envelope', () => {
    const result = buildTerminalErrorPrompt({
      commandLine: 'cat secret.txt',
      exitCode: 0,
      cwd: undefined,
      output: 'hello',
    });
    expect(result).toContain('<terminal_output');
    expect(result).toContain('untrusted');
  });

  it('handles empty output without crashing', () => {
    const result = buildTerminalErrorPrompt({
      commandLine: 'exit 1',
      exitCode: 1,
      cwd: undefined,
      output: '',
    });
    expect(typeof result).toBe('string');
  });
});

describe('fileDisplayName', () => {
  it('returns the basename for an absolute path', () => {
    expect(fileDisplayName('/home/user/project/src/foo.ts')).toBe('foo.ts');
  });

  it('returns the filename for a path with no directory', () => {
    expect(fileDisplayName('index.js')).toBe('index.js');
  });
});
