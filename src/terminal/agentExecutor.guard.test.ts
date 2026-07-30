import { describe, it, expect } from 'vitest';
import { guardStdin } from './agentExecutor.js';

// The terminal path runs in the USER'S shell (window.createTerminal takes their
// default profile), so the wrapper must be dialect-aware. Applying POSIX syntax
// to fish or PowerShell would turn a 120s hang into a broken command on every
// call — strictly worse than the bug.

describe('guardStdin', () => {
  it('wraps for POSIX shells so a stdin-reader gets EOF', () => {
    for (const sh of ['/bin/bash', '/bin/zsh', '/bin/sh', '/usr/bin/dash', '/bin/ksh']) {
      expect(guardStdin('cat', sh), sh).toBe('{ cat\n} < /dev/null');
    }
  });

  it('groups rather than appends, so pipelines survive', () => {
    // `echo x | cat < /dev/null` binds the redirect to cat and prints nothing.
    const out = guardStdin('echo x | cat', '/bin/zsh');
    expect(out).toBe('{ echo x | cat\n} < /dev/null');
    expect(out).not.toMatch(/\|\s*cat\s*<\s*\/dev\/null/);
  });

  it('uses a newline before the closing brace', () => {
    // `{ sleep 1 & ; }` is a syntax error, and a trailing `#` comment would
    // swallow a semicolon.
    expect(guardStdin('sleep 1 &', '/bin/bash')).toBe('{ sleep 1 &\n} < /dev/null');
    expect(guardStdin('echo hi # note', '/bin/bash')).toBe('{ echo hi # note\n} < /dev/null');
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
