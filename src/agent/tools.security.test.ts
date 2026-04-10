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
