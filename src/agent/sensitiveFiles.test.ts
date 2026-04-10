import { describe, it, expect } from 'vitest';

// Test the sensitive file detection patterns directly
// These patterns are defined in tools.ts but we test the logic here
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

describe('sensitive file detection', () => {
  it('blocks .env files', () => {
    expect(isSensitiveFile('.env')).toBe(true);
    expect(isSensitiveFile('.env.local')).toBe(true);
    expect(isSensitiveFile('.env.production')).toBe(true);
    expect(isSensitiveFile('config/.env')).toBe(true);
  });

  it('blocks key and certificate files', () => {
    expect(isSensitiveFile('server.pem')).toBe(true);
    expect(isSensitiveFile('private.key')).toBe(true);
    expect(isSensitiveFile('cert.p12')).toBe(true);
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
    expect(isSensitiveFile('secrets.yml')).toBe(true);
    expect(isSensitiveFile('secret.toml')).toBe(true);
    expect(isSensitiveFile('token.json')).toBe(true);
    expect(isSensitiveFile('service.account.json')).toBe(true);
  });

  it('allows normal code files', () => {
    expect(isSensitiveFile('index.ts')).toBe(false);
    expect(isSensitiveFile('package.json')).toBe(false);
    expect(isSensitiveFile('README.md')).toBe(false);
    expect(isSensitiveFile('src/auth/login.ts')).toBe(false);
    expect(isSensitiveFile('environment.ts')).toBe(false);
  });

  it('allows files with similar but non-matching names', () => {
    expect(isSensitiveFile('env.ts')).toBe(false);
    expect(isSensitiveFile('.envrc')).toBe(false); // not .env or .env.*
    expect(isSensitiveFile('monkey.key.ts')).toBe(false); // .key.ts not .key
  });
});
