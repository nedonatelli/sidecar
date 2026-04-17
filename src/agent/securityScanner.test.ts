import { describe, it, expect } from 'vitest';
import { scanContent, formatIssues, redactSecrets } from './securityScanner.js';

describe('scanContent', () => {
  describe('secret detection', () => {
    it('detects AWS access keys', () => {
      const content = 'const key = "AKIAIOSFODNN7EXAMPLE";';
      const issues = scanContent(content, 'config.ts');
      expect(issues.some((i) => i.message.includes('AWS Access Key'))).toBe(true);
    });

    it('detects GitHub tokens', () => {
      const content = 'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm";';
      const issues = scanContent(content, 'auth.ts');
      expect(issues.some((i) => i.message.includes('GitHub Token'))).toBe(true);
    });

    it('detects generic API keys', () => {
      const content = 'api_key = "test_fake_key_abcdefghijklmnop"';
      const issues = scanContent(content, 'config.py');
      expect(issues.some((i) => i.message.includes('API Key') || i.message.includes('Secret'))).toBe(true);
    });

    it('detects private keys', () => {
      const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...';
      const issues = scanContent(content, 'key.pem');
      expect(issues.some((i) => i.message.includes('Private Key'))).toBe(true);
    });

    it('detects Anthropic API keys', () => {
      const content = 'const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";';
      const issues = scanContent(content, 'config.ts');
      expect(issues.some((i) => i.message.includes('Anthropic'))).toBe(true);
    });

    it('detects connection strings', () => {
      const content = 'const db = "mongodb://admin:password@db.example.com/mydb";';
      const issues = scanContent(content, 'db.ts');
      expect(issues.some((i) => i.message.includes('Connection String'))).toBe(true);
    });

    it('detects JWT tokens', () => {
      const content = 'const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw";';
      const issues = scanContent(content, 'auth.ts');
      expect(issues.some((i) => i.message.includes('JWT'))).toBe(true);
    });

    it('does not flag safe content', () => {
      const content = 'const greeting = "Hello, world!";\nconst count = 42;';
      const issues = scanContent(content, 'app.ts');
      expect(issues).toHaveLength(0);
    });

    it('skips comment lines', () => {
      const content = '// api_key = "test_fake_key_abcdefghijklmnop"';
      const issues = scanContent(content, 'config.ts');
      expect(issues).toHaveLength(0);
    });
  });

  describe('vulnerability detection', () => {
    it('detects innerHTML assignment', () => {
      const content = 'element.innerHTML = userInput;';
      const issues = scanContent(content, 'app.ts');
      expect(issues.some((i) => i.message.includes('XSS'))).toBe(true);
    });

    it('detects eval usage', () => {
      const content = 'const result = eval(userCode);';
      const issues = scanContent(content, 'app.js');
      expect(issues.some((i) => i.message.includes('Eval') || i.message.includes('injection'))).toBe(true);
    });

    it('detects insecure HTTP URLs', () => {
      const content = 'fetch("http://api.example.com/data")';
      const issues = scanContent(content, 'client.ts');
      expect(issues.some((i) => i.message.includes('Insecure HTTP'))).toBe(true);
    });

    it('allows localhost HTTP URLs', () => {
      const content = 'fetch("http://localhost:3000/api")';
      const issues = scanContent(content, 'client.ts');
      expect(issues.filter((i) => i.message.includes('Insecure HTTP'))).toHaveLength(0);
    });

    it('does not flag vulnerabilities in non-matching file types', () => {
      const content = 'element.innerHTML = data;';
      const issues = scanContent(content, 'styles.css');
      expect(issues.filter((i) => i.category === 'vulnerability')).toHaveLength(0);
    });
  });

  describe('file skipping', () => {
    it('skips node_modules files', () => {
      const content = 'const key = "AKIAIOSFODNN7EXAMPLE";';
      const issues = scanContent(content, 'node_modules/pkg/index.js');
      expect(issues).toHaveLength(0);
    });

    it('skips .min files', () => {
      const content = 'eval(code)';
      const issues = scanContent(content, 'bundle.min.js');
      expect(issues).toHaveLength(0);
    });

    it('skips lock files', () => {
      const content = '"secret": "something"';
      const issues = scanContent(content, 'package-lock.json');
      expect(issues).toHaveLength(0);
    });
  });

  describe('issue properties', () => {
    it('reports correct line numbers', () => {
      const content = 'line 1\nline 2\nconst key = "AKIAIOSFODNN7EXAMPLE";\nline 4';
      const issues = scanContent(content, 'config.ts');
      expect(issues[0].line).toBe(3);
    });

    it('marks secrets as error severity', () => {
      const content = 'const key = "AKIAIOSFODNN7EXAMPLE";';
      const issues = scanContent(content, 'config.ts');
      expect(issues[0].severity).toBe('error');
      expect(issues[0].category).toBe('secret');
    });

    it('marks vulnerabilities as warning severity', () => {
      const content = 'element.innerHTML = data;';
      const issues = scanContent(content, 'app.ts');
      expect(issues[0].severity).toBe('warning');
      expect(issues[0].category).toBe('vulnerability');
    });
  });
});

describe('formatIssues', () => {
  it('returns empty string for no issues', () => {
    expect(formatIssues([])).toBe('');
  });

  it('formats issues as file:line [SEVERITY] message', () => {
    const issues = [
      {
        file: 'config.ts',
        line: 5,
        severity: 'error' as const,
        category: 'secret' as const,
        message: 'Potential AWS Key',
      },
    ];
    expect(formatIssues(issues)).toBe('config.ts:5 [ERROR] Potential AWS Key');
  });

  it('formats multiple issues on separate lines', () => {
    const issues = [
      { file: 'a.ts', line: 1, severity: 'error' as const, category: 'secret' as const, message: 'Secret A' },
      { file: 'b.ts', line: 2, severity: 'warning' as const, category: 'vulnerability' as const, message: 'Vuln B' },
    ];
    const formatted = formatIssues(issues);
    expect(formatted).toContain('a.ts:1 [ERROR] Secret A');
    expect(formatted).toContain('b.ts:2 [WARNING] Vuln B');
  });
});

describe('redactSecrets (audit cycle-3 MEDIUM #7)', () => {
  // `redactSecrets` is the anti-exfiltration primitive called by
  // executor.ts (hook env vars) and tools.ts (custom-tool env vars)
  // before handing input/output to child processes that could
  // otherwise inherit secrets. Every covered pattern below maps to
  // a real leak scenario worth preventing.

  it('returns empty input unchanged', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('returns secret-free input unchanged', () => {
    const clean = 'Hello world — this string has no credentials.';
    expect(redactSecrets(clean)).toBe(clean);
  });

  it('redacts an AWS access key in-place', () => {
    const input = 'Key is AKIAIOSFODNN7EXAMPLE and the rest is normal text.';
    const out = redactSecrets(input);
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[REDACTED:AWS Access Key]');
  });

  it('redacts a GitHub token', () => {
    const input = 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
    const out = redactSecrets(input);
    expect(out).toContain('[REDACTED:GitHub Token]');
    expect(out).not.toMatch(/ghp_[A-Za-z0-9_]+/);
  });

  it('redacts an Anthropic API key in a JSON-stringified input', () => {
    const input = JSON.stringify({ apiKey: 'sk-ant-abcdefghijklmnopqrstuvwxyz' });
    const out = redactSecrets(input);
    expect(out).toContain('[REDACTED:');
    expect(out).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz');
  });

  it('redacts a database connection string', () => {
    const input = 'DATABASE_URL=postgres://user:pass@host/db connecting now';
    const out = redactSecrets(input);
    expect(out).toContain('[REDACTED:Connection String]');
    expect(out).not.toContain('pass@host');
  });

  it('redacts multiple distinct secrets in one string', () => {
    const input = [
      'aws_access_key: AKIAIOSFODNN7EXAMPLE',
      'gh: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
      'anthropic: sk-ant-abcdefghijklmnopqrstuvwxyz',
    ].join('\n');
    const out = redactSecrets(input);
    // All three should have been replaced
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789AB');
    expect(out).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz');
    expect((out.match(/\[REDACTED:/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('redacts every occurrence when the same secret appears multiple times', () => {
    const input = 'first: AKIAIOSFODNN7EXAMPLE second: AKIAIOSFODNN7EXAMPLE';
    const out = redactSecrets(input);
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect((out.match(/\[REDACTED:AWS Access Key\]/g) || []).length).toBe(2);
  });

  it('redacts a JWT token pattern', () => {
    // Arbitrary eyJ-prefixed base64 blobs — test the pattern not a real signature.
    const input = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signed';
    const out = redactSecrets(input);
    expect(out).toContain('[REDACTED:JWT Token]');
  });

  it('redacts a private-key header', () => {
    const input = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIB...';
    const out = redactSecrets(input);
    expect(out).toContain('[REDACTED:Private Key]');
  });
});
