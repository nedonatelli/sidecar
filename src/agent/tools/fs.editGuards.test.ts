import { describe, it, expect, vi, afterEach } from 'vitest';
import { workspace } from 'vscode';
import { editFile } from './fs.js';

// #162: edit_file's definition guards -- the dropped-definition guard (ML-42,
// ML-43) and the shadow-definition guard (ML-44, ML-70) -- refused edits that
// were fine. Each case here was refused before the fix.

function mount(text: string) {
  vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(text) as never);
  return vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
}
const written = (write: ReturnType<typeof mount>): string =>
  Buffer.from(write.mock.calls[0][1] as Uint8Array).toString();

const ctx = (file: string) => ({ config: { agentMode: 'agent' }, filesReadThisTurn: new Set([file]) }) as never;

async function edit(file: string, text: string, search: string, replace: string) {
  const write = mount(text);
  const result = await editFile({ path: file, search, replace }, ctx(file)).then(
    (r) => ({ ok: true as const, message: r }),
    (e: Error) => ({ ok: false as const, message: e.message }),
  );
  return { ...result, write };
}

// Shows the refusal text when an edit that should apply did not.
const expectApplied = (r: { ok: boolean; message: string }) => expect(r.ok, r.message).toBe(true);

afterEach(() => vi.restoreAllMocks());

describe('the dropped-definition guard reads a modified definition as still there (#162 ML-42)', () => {
  it('an arrow function gaining a return type', async () => {
    const r = await edit(
      'src/sum.ts',
      'export const sum = (xs: number[]) => {\n  return xs.reduce((a, b) => a + b, 0);\n};\n',
      'export const sum = (xs: number[]) => {',
      'export const sum = (xs: number[]): number => {',
    );
    expect(r.message).not.toContain('drops the line');
    expect(written(r.write)).toContain('export const sum = (xs: number[]): number => {\n');
  });

  it('a decorator gaining a nested call', async () => {
    const r = await edit(
      'app.py',
      '@app.route("/items")\ndef items():\n    return []\n',
      '@app.route("/items")',
      '@app.route(prefix("/items"))',
    );
    expect(r.message).not.toContain('drops the line');
    expect(written(r.write)).toBe('@app.route(prefix("/items"))\ndef items():\n    return []\n');
  });

  it('prose that starts with a keyword', async () => {
    const r = await edit(
      'store.py',
      'def save(obj):\n    """Persist obj.\n\n    class attributes are copied on write.\n    """\n    return obj\n',
      '    class attributes are copied on write.',
      '    Attributes set on the class are copied on write.',
    );
    expect(r.message).not.toContain('drops the line');
    expect(written(r.write)).toContain('    Attributes set on the class are copied on write.\n');
  });

  it('still refuses a replace that loses the definition line', async () => {
    const r = await edit(
      'm.py',
      'def total(items):\n    return sum(items)\n',
      'def total(items):\n    return sum(items)',
      '    return round(sum(items), 2)',
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('drops the line `def total(items):`');
    expect(r.write).not.toHaveBeenCalled();
  });
});

describe('edit_file can delete a whole definition or a decorator (#162 ML-43)', () => {
  const FILE = 'def a():\n    return 1\n\n\n@functools.cache\ndef b():\n    return 2\n';

  it('deletes a definition when search is its whole block and replace is empty', async () => {
    const r = await edit('dup.py', FILE, '@functools.cache\ndef b():\n    return 2\n', '');
    expectApplied(r);
    expect(written(r.write)).toBe('def a():\n    return 1\n\n\n');
  });

  it('deletes a lone decorator line', async () => {
    const r = await edit('dup.py', FILE, '@functools.cache\n', '');
    expectApplied(r);
    expect(written(r.write)).toBe('def a():\n    return 1\n\n\ndef b():\n    return 2\n');
  });

  it('refuses an empty replace that would orphan the body, and says how to delete', async () => {
    const r = await edit('dup.py', FILE, 'def b():\n', '');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('drops the line `def b():`');
    expect(r.message).toMatch(/whole block/);
    expect(r.write).not.toHaveBeenCalled();
  });

  it('refuses an empty replace that leaves a closing brace behind', async () => {
    const r = await edit(
      'f.ts',
      'function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n',
      'function b() {\n  return 2;\n',
      '',
    );
    expect(r.ok).toBe(false);
    // This guard, not the syntax guard, which a language without a grammar lacks.
    expect(r.message).toContain('drops the line `function b() {`');
    expect(r.write).not.toHaveBeenCalled();
  });
});

describe('the shadow-definition guard sees only code definitions (#162 ML-44)', () => {
  it('a TOML key repeated under another table', async () => {
    const r = await edit(
      'pyproject.toml',
      '[tool.a]\nname = "x"\n\n[tool.b]\n',
      '[tool.b]\n',
      '[tool.b]\nname = "y"\n',
    );
    expectApplied(r);
  });

  it('a Markdown line with a colon and an equals sign', async () => {
    const r = await edit(
      'README.md',
      'Note: the default = 3\n\nMore text.\n',
      'More text.\n',
      'More text.\n\nNote: the limit = 5\n',
    );
    expectApplied(r);
  });

  it('a shell variable reassigned later in the script', async () => {
    const r = await edit('run.sh', 'MODE=dev\necho "$MODE"\n', 'echo "$MODE"\n', 'echo "$MODE"\nMODE=prod\n');
    expectApplied(r);
  });

  it('a column-0 line inside a Python triple-quoted string', async () => {
    const r = await edit(
      'cli.py',
      'usage = 1\nHELP = """\nOptions:\n"""\n',
      'Options:\n',
      'Options:\nusage = see --help\n',
    );
    expectApplied(r);
  });

  it('still refuses a second top-level Python definition', async () => {
    const r = await edit(
      'settings.py',
      '# Upload settings\nFILE_UPLOAD_PERMISSIONS = None\n',
      '# Upload settings\n',
      '# Upload settings\nFILE_UPLOAD_PERMISSIONS = 0o644\n',
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('`FILE_UPLOAD_PERMISSIONS`');
    expect(r.write).not.toHaveBeenCalled();
  });
});

describe('the shadow-definition guard allows a reassignment built on the prior value (#162 ML-70)', () => {
  it('x = f(x)', async () => {
    const r = await edit(
      'backend.py',
      '__all__ = ["a"]\n\ndef extra():\n    pass\n',
      'def extra():\n    pass\n',
      'def extra():\n    pass\n\n__all__ = __all__ + ["extra"]\n',
    );
    expectApplied(r);
  });

  it("still refuses one that reads another object's attribute of the same name", async () => {
    const r = await edit('limits.py', 'TIMEOUT = 10\n', 'TIMEOUT = 10\n', 'TIMEOUT = cfg.TIMEOUT\nTIMEOUT = 10\n');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('`TIMEOUT`');
  });

  it('names the earlier line as the dead one when the added line comes last', async () => {
    const r = await edit(
      'limits.py',
      'TIMEOUT = 10\n\ndef run():\n    pass\n',
      'def run():\n    pass\n',
      'def run():\n    pass\n\nTIMEOUT = 30\n',
    );
    expect(r.ok).toBe(false);
    expect(r.message).not.toMatch(/overrides the one you added/);
    expect(r.message).toMatch(/line 1\).*dead code/);
  });

  it('keeps the old wording when the added line comes first', async () => {
    const r = await edit('limits.py', 'TIMEOUT = 10\n', 'TIMEOUT = 10\n', 'TIMEOUT = 30\nTIMEOUT = 10\n');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/overrides the one you added/);
  });
});
