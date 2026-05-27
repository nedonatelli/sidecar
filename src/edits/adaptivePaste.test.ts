import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { detectTransforms, BUILTIN_TRANSFORMS } from './pasteTransforms.js';
import {
  AdaptivePasteTracker,
  AdaptivePasteCodeActionProvider,
  registerAdaptivePasteCommand,
} from './adaptivePaste.js';
import { workspace, window, commands } from 'vscode';
import { getConfig } from '../config/settings.js';

vi.mock('../config/settings.js', () => ({
  getConfig: vi.fn(() => ({
    adaptivePasteEnabled: true,
    adaptivePasteAutoDetect: true,
    adaptivePasteMinPasteLength: 20,
    adaptivePasteModel: null,
  })),
}));

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
// AdaptivePasteTracker — onDidChangeTextDocument listener
// ---------------------------------------------------------------------------

describe('AdaptivePasteTracker — listener', () => {
  function makeDoc(uri = 'file:///a.ts', languageId = 'typescript') {
    return {
      uri: { toString: () => uri },
      languageId,
      offsetAt: (pos: { line: number; character: number }) => pos.character,
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    };
  }

  function makeEvent(
    doc: ReturnType<typeof makeDoc>,
    changes: {
      text: string;
      range: { start: { line: number; character: number }; end: { line: number; character: number }; isEmpty: boolean };
    }[],
  ) {
    return { document: doc, contentChanges: changes };
  }

  function makeChange(text: string, empty = true) {
    return {
      text,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: empty ? 0 : 5 },
        isEmpty: empty,
      },
    };
  }

  function captureListener(): { captured: ((e: unknown) => void) | null } {
    const ref: { captured: ((e: unknown) => void) | null } = { captured: null };
    vi.spyOn(workspace, 'onDidChangeTextDocument').mockImplementation((cb) => {
      ref.captured = cb as (e: unknown) => void;
      return { dispose: vi.fn() };
    });
    return ref;
  }

  beforeEach(() => {
    vi.mocked(getConfig).mockReturnValue({
      adaptivePasteEnabled: true,
      adaptivePasteAutoDetect: true,
      adaptivePasteMinPasteLength: 20,
      adaptivePasteModel: null,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a paste on a single-chunk insertion above minPasteLength', () => {
    const ref = captureListener();
    const tracker = new AdaptivePasteTracker();
    const longText = 'x'.repeat(25);
    ref.captured!(makeEvent(makeDoc(), [makeChange(longText)]));

    const paste = tracker.getLastPaste();
    expect(paste).not.toBeNull();
    expect(paste!.text).toBe(longText);
    expect(paste!.documentUri).toBe('file:///a.ts');
    expect(paste!.languageId).toBe('typescript');
  });

  it('ignores change when adaptivePasteEnabled is false', () => {
    vi.mocked(getConfig).mockReturnValue({
      adaptivePasteEnabled: false,
      adaptivePasteAutoDetect: true,
      adaptivePasteMinPasteLength: 20,
      adaptivePasteModel: null,
    } as never);

    const ref = captureListener();
    const tracker = new AdaptivePasteTracker();
    ref.captured!(makeEvent(makeDoc(), [makeChange('x'.repeat(25))]));
    expect(tracker.getLastPaste()).toBeNull();
  });

  it('ignores change when adaptivePasteAutoDetect is false', () => {
    vi.mocked(getConfig).mockReturnValue({
      adaptivePasteEnabled: true,
      adaptivePasteAutoDetect: false,
      adaptivePasteMinPasteLength: 20,
      adaptivePasteModel: null,
    } as never);

    const ref = captureListener();
    const tracker = new AdaptivePasteTracker();
    ref.captured!(makeEvent(makeDoc(), [makeChange('x'.repeat(25))]));
    expect(tracker.getLastPaste()).toBeNull();
  });

  it('ignores multi-chunk changes (contentChanges.length !== 1)', () => {
    const ref = captureListener();
    const tracker = new AdaptivePasteTracker();
    ref.captured!(makeEvent(makeDoc(), [makeChange('x'.repeat(25)), makeChange('y'.repeat(25))]));
    expect(tracker.getLastPaste()).toBeNull();
  });

  it('ignores insertion below minPasteLength', () => {
    const ref = captureListener();
    const tracker = new AdaptivePasteTracker();
    ref.captured!(makeEvent(makeDoc(), [makeChange('short')]));
    expect(tracker.getLastPaste()).toBeNull();
  });

  it('ignores non-empty range (replacement, not insertion)', () => {
    const ref = captureListener();
    const tracker = new AdaptivePasteTracker();
    ref.captured!(makeEvent(makeDoc(), [makeChange('x'.repeat(25), false)]));
    expect(tracker.getLastPaste()).toBeNull();
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

// ---------------------------------------------------------------------------
// registerAdaptivePasteCommand
// ---------------------------------------------------------------------------

describe('registerAdaptivePasteCommand', () => {
  const PASTE_URI = 'file:///b.ts';

  const fakePaste = {
    text: 'x'.repeat(30),
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 30 } },
    documentUri: PASTE_URI,
    languageId: 'typescript',
  } as never;

  const singleTransform = [
    {
      id: 'json-to-ts-type',
      name: 'JSON → TS type',
      description: 'desc',
      transformInstruction: 'convert',
      detect: () => true,
    },
  ] as never;

  const twoTransforms = [
    {
      id: 'json-to-ts-type',
      name: 'JSON → TS type',
      description: 'desc',
      transformInstruction: 'convert',
      detect: () => true,
    },
    { id: 'sql-to-orm', name: 'SQL → ORM', description: 'desc2', transformInstruction: 'orm', detect: () => true },
  ] as never;

  function makeTracker(): AdaptivePasteTracker {
    return new AdaptivePasteTracker();
  }

  function makeClient(result: string | null = 'transformed code') {
    return {
      completeWithOverrides:
        result === null ? vi.fn().mockRejectedValue(new Error('LLM failed')) : vi.fn().mockResolvedValue(result),
    } as never;
  }

  function fakeEditor(uri = PASTE_URI, languageId = 'typescript') {
    return {
      document: {
        uri: { toString: () => uri },
        languageId,
      },
    };
  }

  async function captureAndInvoke(client: ReturnType<typeof makeClient>, tracker: AdaptivePasteTracker, args: unknown) {
    let captured: ((...a: unknown[]) => Promise<unknown>) | null = null;
    vi.spyOn(commands, 'registerCommand').mockImplementation((_cmd, cb) => {
      captured = cb as typeof captured;
      return { dispose: vi.fn() };
    });
    registerAdaptivePasteCommand(client, tracker);
    await captured!(args);
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    (window as { activeTextEditor: unknown }).activeTextEditor = undefined;
    // applyEdit does not exist in the base mock — add it so vi.spyOn can wrap it.
    if (!('applyEdit' in workspace)) {
      Object.assign(workspace, { applyEdit: async () => true });
    }
  });

  it('returns early when called with no args', async () => {
    const client = makeClient();
    const tracker = makeTracker();
    await captureAndInvoke(client, tracker, undefined);
    expect(
      (client as { completeWithOverrides: ReturnType<typeof vi.fn> }).completeWithOverrides,
    ).not.toHaveBeenCalled();
  });

  it('calls completeWithOverrides and applies WorkspaceEdit on happy path (single transform)', async () => {
    (window as { activeTextEditor: unknown }).activeTextEditor = fakeEditor();
    const applyEdit = vi
      .spyOn(workspace as typeof workspace & { applyEdit: () => Promise<boolean> }, 'applyEdit')
      .mockResolvedValue(true);
    const client = makeClient('const result = {};');
    const tracker = makeTracker();

    await captureAndInvoke(client, tracker, { paste: fakePaste, transforms: singleTransform });

    expect(
      (client as { completeWithOverrides: ReturnType<typeof vi.fn> }).completeWithOverrides,
    ).toHaveBeenCalledOnce();
    expect(applyEdit).toHaveBeenCalledOnce();
    expect(tracker.getLastPaste()).toBeNull();
  });

  it('shows QuickPick and uses selected transform when multiple transforms available', async () => {
    (window as { activeTextEditor: unknown }).activeTextEditor = fakeEditor();
    vi.spyOn(workspace as typeof workspace & { applyEdit: () => Promise<boolean> }, 'applyEdit').mockResolvedValue(
      true,
    );
    const client = makeClient('result');
    const tracker = makeTracker();

    vi.spyOn(window, 'showQuickPick').mockResolvedValue({
      label: 'SQL → ORM',
      description: 'desc2',
      transform: (twoTransforms as unknown as (typeof twoTransforms)[])[1],
    } as never);

    await captureAndInvoke(client, tracker, { paste: fakePaste, transforms: twoTransforms });

    expect(window.showQuickPick).toHaveBeenCalledOnce();
    expect(
      (client as { completeWithOverrides: ReturnType<typeof vi.fn> }).completeWithOverrides,
    ).toHaveBeenCalledOnce();
  });

  it('returns early when QuickPick is cancelled', async () => {
    (window as { activeTextEditor: unknown }).activeTextEditor = fakeEditor();
    const client = makeClient();
    const tracker = makeTracker();
    vi.spyOn(window, 'showQuickPick').mockResolvedValue(undefined);

    await captureAndInvoke(client, tracker, { paste: fakePaste, transforms: twoTransforms });

    expect(
      (client as { completeWithOverrides: ReturnType<typeof vi.fn> }).completeWithOverrides,
    ).not.toHaveBeenCalled();
  });

  it('returns early when activeTextEditor is null', async () => {
    (window as { activeTextEditor: unknown }).activeTextEditor = null;
    const client = makeClient();
    const tracker = makeTracker();

    await captureAndInvoke(client, tracker, { paste: fakePaste, transforms: singleTransform });

    expect(
      (client as { completeWithOverrides: ReturnType<typeof vi.fn> }).completeWithOverrides,
    ).not.toHaveBeenCalled();
  });

  it('returns early when editor document URI does not match paste document', async () => {
    (window as { activeTextEditor: unknown }).activeTextEditor = fakeEditor('file:///other.ts');
    const client = makeClient();
    const tracker = makeTracker();

    await captureAndInvoke(client, tracker, { paste: fakePaste, transforms: singleTransform });

    expect(
      (client as { completeWithOverrides: ReturnType<typeof vi.fn> }).completeWithOverrides,
    ).not.toHaveBeenCalled();
  });

  it('shows error message when completeWithOverrides returns empty string', async () => {
    (window as { activeTextEditor: unknown }).activeTextEditor = fakeEditor();
    vi.spyOn(workspace as typeof workspace & { applyEdit: () => Promise<boolean> }, 'applyEdit').mockResolvedValue(
      true,
    );
    const showError = vi.spyOn(window, 'showErrorMessage').mockResolvedValue(undefined as never);
    const client = makeClient('   ');
    const tracker = makeTracker();

    await captureAndInvoke(client, tracker, { paste: fakePaste, transforms: singleTransform });

    expect(showError).toHaveBeenCalledWith(expect.stringContaining('empty result'));
  });

  it('shows error message when completeWithOverrides throws', async () => {
    (window as { activeTextEditor: unknown }).activeTextEditor = fakeEditor();
    const showError = vi.spyOn(window, 'showErrorMessage').mockResolvedValue(undefined as never);
    const client = makeClient(null);
    const tracker = makeTracker();

    await captureAndInvoke(client, tracker, { paste: fakePaste, transforms: singleTransform });

    expect(showError).toHaveBeenCalledWith(expect.stringContaining('LLM failed'));
  });
});
