import { describe, it, expect, beforeEach } from 'vitest';
import { detectTransforms, BUILTIN_TRANSFORMS } from './pasteTransforms.js';
import { AdaptivePasteTracker, AdaptivePasteCodeActionProvider } from './adaptivePaste.js';

// ---------------------------------------------------------------------------
// pasteTransforms.ts — detection logic (pure, no VS Code dependency)
// ---------------------------------------------------------------------------

describe('detectTransforms — JSON', () => {
  it('detects a JSON object', () => {
    const text = '{"name": "Alice", "age": 30}';
    const ts = detectTransforms(text, 'typescript');
    expect(ts.map((t) => t.id)).toContain('json-to-ts-type');
  });

  it('detects a JSON array', () => {
    const text = '[{"id": 1, "label": "a"}, {"id": 2, "label": "b"}]';
    expect(detectTransforms(text, 'typescript').map((t) => t.id)).toContain('json-to-ts-type');
  });

  it('does NOT detect malformed JSON', () => {
    const text = '{"name": "Alice", age: 30}'; // unquoted key
    expect(detectTransforms(text, 'typescript').map((t) => t.id)).not.toContain('json-to-ts-type');
  });

  it('does NOT offer json-to-ts-type in non-JS/TS languages', () => {
    const text = '{"key": "value"}';
    expect(detectTransforms(text, 'python').map((t) => t.id)).not.toContain('json-to-ts-type');
  });
});

describe('detectTransforms — SQL', () => {
  it('detects a SELECT query', () => {
    const text = 'SELECT id, name FROM users WHERE active = true ORDER BY name';
    expect(detectTransforms(text, 'typescript').map((t) => t.id)).toContain('sql-to-orm');
  });

  it('detects an INSERT query', () => {
    const text = 'INSERT INTO orders (user_id, total) VALUES (1, 99.99)';
    expect(detectTransforms(text, 'typescript').map((t) => t.id)).toContain('sql-to-orm');
  });

  it('does NOT detect plain prose as SQL', () => {
    const text = 'This is a regular comment about the database structure.';
    expect(detectTransforms(text, 'typescript').map((t) => t.id)).not.toContain('sql-to-orm');
  });
});

describe('detectTransforms — curl', () => {
  it('detects a curl command', () => {
    const text = 'curl -X POST https://api.example.com/data -H "Content-Type: application/json" -d \'{"foo": 1}\'';
    expect(detectTransforms(text, 'typescript').map((t) => t.id)).toContain('curl-to-fetch');
  });

  it('detects curl with leading whitespace', () => {
    const text = '  curl https://example.com';
    expect(detectTransforms(text, 'javascript').map((t) => t.id)).toContain('curl-to-fetch');
  });

  it('does NOT match non-curl text', () => {
    const text = 'const url = "https://example.com"';
    expect(detectTransforms(text, 'typescript').map((t) => t.id)).not.toContain('curl-to-fetch');
  });
});

describe('detectTransforms — CSS', () => {
  it('detects a CSS rule block', () => {
    const text = '.container { display: flex; gap: 16px; align-items: center; }';
    expect(detectTransforms(text, 'typescriptreact').map((t) => t.id)).toContain('css-to-tailwind');
  });

  it('does NOT offer CSS transform in typescript (non-JSX)', () => {
    const text = '.btn { color: red; font-weight: bold; }';
    expect(detectTransforms(text, 'typescript').map((t) => t.id)).not.toContain('css-to-tailwind');
  });
});

describe('detectTransforms — Python', () => {
  it('detects a Python function', () => {
    const text = 'def greet(name):\n    print(f"Hello, {name}")\n\ngreet("World")';
    expect(detectTransforms(text, 'typescript').map((t) => t.id)).toContain('python-to-ts');
  });

  it('does NOT misidentify TypeScript as Python', () => {
    const text = 'const fn = () => { return 42; }';
    expect(detectTransforms(text, 'typescript').map((t) => t.id)).not.toContain('python-to-ts');
  });
});

describe('detectTransforms — shell', () => {
  it('detects a shebang script', () => {
    const text = '#!/bin/bash\necho "hello"\nnpm install';
    expect(detectTransforms(text, 'typescript').map((t) => t.id)).toContain('shell-to-execa');
  });

  it('detects brew/npm invocations', () => {
    const text = 'brew install node\nnpm install --save-dev typescript';
    expect(detectTransforms(text, 'typescript').map((t) => t.id)).toContain('shell-to-execa');
  });
});

describe('detectTransforms — .env', () => {
  it('detects an env block', () => {
    const text = 'DATABASE_URL=postgresql://localhost/mydb\nSECRET_KEY=abc123\nPORT=3000';
    expect(detectTransforms(text, 'typescript').map((t) => t.id)).toContain('env-to-zod');
  });

  it('does NOT detect a single env line as an env block', () => {
    const text = 'PORT=3000';
    expect(detectTransforms(text, 'typescript').map((t) => t.id)).not.toContain('env-to-zod');
  });
});

describe('BUILTIN_TRANSFORMS catalog', () => {
  it('has no duplicate ids', () => {
    const ids = BUILTIN_TRANSFORMS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry has id, name, description, detect, transformInstruction', () => {
    for (const t of BUILTIN_TRANSFORMS) {
      expect(t.id, `${t.id} missing id`).toBeTruthy();
      expect(t.name, `${t.id} missing name`).toBeTruthy();
      expect(t.description, `${t.id} missing description`).toBeTruthy();
      expect(typeof t.detect, `${t.id} detect must be function`).toBe('function');
      expect(t.transformInstruction, `${t.id} missing transformInstruction`).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// AdaptivePasteTracker — VS Code document change handling
// ---------------------------------------------------------------------------

describe('AdaptivePasteTracker', () => {
  let tracker: AdaptivePasteTracker;

  beforeEach(() => {
    tracker = new AdaptivePasteTracker();
  });

  it('starts with no last paste', () => {
    expect(tracker.getLastPaste()).toBeNull();
  });

  it('clearLastPaste resets to null', () => {
    tracker.clearLastPaste();
    expect(tracker.getLastPaste()).toBeNull();
  });

  it('dispose does not throw', () => {
    expect(() => tracker.dispose()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AdaptivePasteCodeActionProvider
// ---------------------------------------------------------------------------

describe('AdaptivePasteCodeActionProvider', () => {
  it('returns empty actions when no paste recorded', () => {
    const tracker = new AdaptivePasteTracker();
    const provider = new AdaptivePasteCodeActionProvider(tracker);
    const doc = { uri: { toString: () => 'file:///a.ts' }, languageId: 'typescript' } as never;
    const range = { intersection: () => null, isEmpty: false } as never;
    expect(provider.provideCodeActions(doc, range)).toHaveLength(0);
  });
});
