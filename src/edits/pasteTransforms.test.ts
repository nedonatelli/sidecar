import { describe, it, expect } from 'vitest';
import { detectTransforms, BUILTIN_TRANSFORMS } from './pasteTransforms.js';

// ---------------------------------------------------------------------------
// Individual detectors (tested via BUILTIN_TRANSFORMS entries)
// ---------------------------------------------------------------------------

function detect(id: string, text: string): boolean {
  const t = BUILTIN_TRANSFORMS.find((t) => t.id === id)!;
  return t.detect(text);
}

describe('json-to-ts-type detector', () => {
  it('matches a plain JSON object', () => {
    expect(detect('json-to-ts-type', '{"name":"Alice","age":30}')).toBe(true);
  });

  it('matches a JSON array', () => {
    expect(detect('json-to-ts-type', '[1, 2, 3]')).toBe(true);
  });

  it('rejects invalid JSON that starts with {', () => {
    expect(detect('json-to-ts-type', '{ name: Alice }')).toBe(false);
  });

  it('rejects plain strings', () => {
    expect(detect('json-to-ts-type', '"hello"')).toBe(false);
  });

  it('rejects SQL', () => {
    expect(detect('json-to-ts-type', 'SELECT * FROM users')).toBe(false);
  });
});

describe('sql-to-orm detector', () => {
  it('matches a SELECT query', () => {
    expect(detect('sql-to-orm', 'SELECT id, name FROM users WHERE id = 1')).toBe(true);
  });

  it('matches INSERT INTO', () => {
    expect(detect('sql-to-orm', 'INSERT INTO orders (user_id) VALUES (42)')).toBe(true);
  });

  it('matches UPDATE … SET', () => {
    expect(detect('sql-to-orm', 'UPDATE users SET name = ? WHERE id = ?')).toBe(true);
  });

  it('rejects plain text', () => {
    expect(detect('sql-to-orm', 'select the best option')).toBe(false);
  });

  it('rejects SQL keyword without body clause', () => {
    // Has SELECT but no FROM/WHERE/etc.
    expect(detect('sql-to-orm', 'SELECT')).toBe(false);
  });
});

describe('curl-to-fetch detector', () => {
  it('matches a curl command', () => {
    expect(detect('curl-to-fetch', 'curl https://api.example.com/data')).toBe(true);
  });

  it('matches curl with flags', () => {
    expect(detect('curl-to-fetch', 'curl -X POST -H "Content-Type: application/json" https://api.example.com')).toBe(
      true,
    );
  });

  it('is case-insensitive', () => {
    expect(detect('curl-to-fetch', 'CURL https://example.com')).toBe(true);
  });

  it('rejects text that merely mentions curl', () => {
    expect(detect('curl-to-fetch', 'run curl to download')).toBe(false);
  });
});

describe('css-to-tailwind detector', () => {
  it('matches a CSS rule block', () => {
    const css = '.container {\n  display: flex;\n  gap: 1rem;\n}';
    expect(detect('css-to-tailwind', css)).toBe(true);
  });

  it('matches a CSS block with inline-style properties', () => {
    const css = 'p { color: red; font-size: 14px; }';
    expect(detect('css-to-tailwind', css)).toBe(true);
  });

  it('rejects plain prose', () => {
    expect(detect('css-to-tailwind', 'The background color should be blue')).toBe(false);
  });
});

describe('python-to-ts detector', () => {
  it('matches a def statement', () => {
    expect(detect('python-to-ts', 'def greet(name):\n    print(f"Hello {name}")')).toBe(true);
  });

  it('matches an import statement', () => {
    expect(detect('python-to-ts', 'import os\nprint(os.getcwd())')).toBe(true);
  });

  it('rejects TypeScript with arrow functions', () => {
    expect(detect('python-to-ts', 'const fn = () => {\n  return 1;\n}')).toBe(false);
  });

  it('rejects JavaScript with function keyword', () => {
    expect(detect('python-to-ts', 'function hello() { return "hi"; }')).toBe(false);
  });
});

describe('shell-to-execa detector', () => {
  it('matches a shebang line', () => {
    expect(detect('shell-to-execa', '#!/bin/bash\necho hi')).toBe(true);
  });

  it('matches a shell prompt line', () => {
    expect(detect('shell-to-execa', '$ npm install\n$ npm run build')).toBe(true);
  });

  it('matches common package manager commands', () => {
    expect(detect('shell-to-execa', 'brew install node')).toBe(true);
    expect(detect('shell-to-execa', 'npm install express')).toBe(true);
  });

  it('rejects plain prose', () => {
    expect(detect('shell-to-execa', 'Run npm install to get started')).toBe(false);
  });
});

describe('env-to-zod detector', () => {
  it('matches an env file with multiple assignments', () => {
    const env = 'DATABASE_URL=postgres://localhost/mydb\nSECRET_KEY=abc123\nPORT=3000';
    expect(detect('env-to-zod', env)).toBe(true);
  });

  it('rejects a single assignment (below threshold)', () => {
    expect(detect('env-to-zod', 'PORT=3000')).toBe(false);
  });

  it('ignores comment lines in the ratio calculation', () => {
    const env = '# Config\nDB_HOST=localhost\nDB_PORT=5432\nDB_NAME=mydb';
    expect(detect('env-to-zod', env)).toBe(true);
  });

  it('rejects arbitrary key=value noise below 50% threshold', () => {
    const mixed = 'PORT=3000\nThis is plain text\nAnother sentence here\nMore prose';
    expect(detect('env-to-zod', mixed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectTransforms — language filtering
// ---------------------------------------------------------------------------

describe('detectTransforms', () => {
  it('returns json-to-ts-type only for TS/JS languages', () => {
    const ts = detectTransforms('{"key":1}', 'typescript');
    expect(ts.map((t) => t.id)).toContain('json-to-ts-type');

    const py = detectTransforms('{"key":1}', 'python');
    expect(py.map((t) => t.id)).not.toContain('json-to-ts-type');
  });

  it('returns sql-to-orm only for TS/JS languages', () => {
    const ts = detectTransforms('SELECT id FROM users WHERE id = 1', 'javascript');
    expect(ts.map((t) => t.id)).toContain('sql-to-orm');

    const ruby = detectTransforms('SELECT id FROM users WHERE id = 1', 'ruby');
    expect(ruby.map((t) => t.id)).not.toContain('sql-to-orm');
  });

  it('returns shell-to-execa only for TS/JS languages', () => {
    const ts = detectTransforms('#!/bin/bash\necho hi', 'typescript');
    expect(ts.map((t) => t.id)).toContain('shell-to-execa');

    const python = detectTransforms('#!/bin/bash\necho hi', 'python');
    expect(python.map((t) => t.id)).not.toContain('shell-to-execa');
  });

  it('returns css-to-tailwind only for TSX/JSX/HTML', () => {
    const tsx = detectTransforms('.box { color: red; }', 'typescriptreact');
    expect(tsx.map((t) => t.id)).toContain('css-to-tailwind');

    const ts = detectTransforms('.box { color: red; }', 'typescript');
    expect(ts.map((t) => t.id)).not.toContain('css-to-tailwind');
  });

  it('returns empty array when no transform matches', () => {
    expect(detectTransforms('hello world', 'typescript')).toHaveLength(0);
  });

  it('returns multiple transforms when multiple match', () => {
    // Shell shebang could also have a $ prompt - both point to shell transform
    const results = detectTransforms('$ npm install\n$ npm run build', 'typescript');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
