import { describe, it, expect } from 'vitest';
import { guardStdin } from './agentExecutor.js';

// The terminal path runs in the USER'S shell (window.createTerminal takes their
// default profile), so the wrapper must be dialect-aware. Applying POSIX syntax
// to fish or PowerShell would turn a 120s hang into a broken command on every
// call — strictly worse than the bug.

describe('guardStdin', () => {
  it('wraps for POSIX shells so a stdin-reader gets EOF', () => {
    for (const sh of ['/bin/bash', '/bin/zsh', '/bin/sh', '/usr/bin/dash', '/bin/ksh']) {
      expect(guardStdin('cat', sh, 'linux'), sh).toBe('{ cat\n} < /dev/null');
    }
  });

  it('groups rather than appends, so pipelines survive', () => {
    // `echo x | cat < /dev/null` binds the redirect to cat and prints nothing.
    const out = guardStdin('echo x | cat', '/bin/zsh', 'darwin');
    expect(out).toBe('{ echo x | cat\n} < /dev/null');
    expect(out).not.toMatch(/\|\s*cat\s*<\s*\/dev\/null/);
  });

  it('uses a newline before the closing brace', () => {
    // `{ sleep 1 & ; }` is a syntax error, and a trailing `#` comment would
    // swallow a semicolon.
    expect(guardStdin('sleep 1 &', '/bin/bash', 'linux')).toBe('{ sleep 1 &\n} < /dev/null');
    expect(guardStdin('echo hi # note', '/bin/bash', 'linux')).toBe('{ echo hi # note\n} < /dev/null');
  });

  it('rewrites a cmd-style nul redirect for a POSIX shell on Windows only (#395)', () => {
    const bash = 'C:/Program Files/Git/bin/bash.exe';
    expect(guardStdin('ls x 2>nul', bash, 'win32')).toBe('{ ls x 2>/dev/null; } < /dev/null');
    expect(guardStdin('ls x 2>nul', '/bin/bash', 'linux')).toBe('{ ls x 2>nul\n} < /dev/null');
    expect(guardStdin('dir 2>nul', 'C:\\Windows\\System32\\cmd.exe', 'win32')).toBe('(dir 2>nul) < NUL');
  });

  it('recognizes Git Bash from the backslash path vscode.env.shell reports on Windows (#422)', () => {
    for (const bash of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']) {
      expect(guardStdin('cat', bash, 'win32')).toBe('{ cat; } < /dev/null');
      expect(guardStdin('ls x 2>nul', bash, 'win32')).toBe('{ ls x 2>/dev/null; } < /dev/null');
    }
  });

  // Git Bash's shell integration never ends a command sent across two lines
  // (live check in VS Code 1.142.0: every guarded command timed out).
  it('keeps Git Bash on Windows to one line, unwrapped where one line cannot hold it', () => {
    const bash = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
    expect(guardStdin('echo x | cat', bash, 'win32')).toBe('{ echo x | cat; } < /dev/null');
    for (const cmd of [
      'sleep 1 &',
      'echo hi # note',
      'cat <<EOF\nx\nEOF',
      'echo a\necho b',
      'echo a;',
      'npm test &&',
    ]) {
      expect(guardStdin(cmd, bash, 'win32'), cmd).toBe(cmd);
    }
    expect(guardStdin('cat <<EOF\ndel x 2>nul\nEOF', bash, 'win32')).toBe('cat <<EOF\ndel x 2>nul\nEOF');
  });

  it('uses cmd.exe syntax on cmd.exe', () => {
    expect(guardStdin('dir', 'C:\\Windows\\System32\\cmd.exe')).toBe('(dir) < NUL');
  });

  it('leaves unknown dialects untouched rather than corrupting them', () => {
    for (const sh of ['/usr/bin/fish', '/usr/local/bin/nu', 'powershell.exe', 'pwsh', '']) {
      expect(guardStdin('cat', sh), sh).toBe('cat');
    }
  });
});
