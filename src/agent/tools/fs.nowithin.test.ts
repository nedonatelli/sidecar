import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// The experiment arm (exp/edit-no-within): with SIDECAR_EDIT_WITHIN=off,
// edit_file is a plain search/replace. The flag is read at module load, so the
// module is imported fresh under the stubbed env -- and `vscode` with it, so the
// spies below land on the same mock instance fs.ts sees.

let fs: typeof import('./fs.js');
let workspace: typeof import('vscode').workspace;

const file = 'class A:\n    def run(self):\n        return 1\n\nclass B:\n    def run(self):\n        return 1\n';
let written = '';

beforeAll(async () => {
  vi.stubEnv('SIDECAR_EDIT_WITHIN', 'off');
  vi.resetModules();
  fs = await import('./fs.js');
  workspace = (await import('vscode')).workspace;
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

beforeEach(() => {
  written = '';
  vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(file) as never);
  vi.spyOn(workspace.fs, 'writeFile').mockImplementation((async (_u: unknown, b: Uint8Array) => {
    written = Buffer.from(b).toString('utf-8');
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

const editMsg = (input: Record<string, unknown>) => fs.editFile(input).catch((e: Error) => e.message);

describe('edit_file with SIDECAR_EDIT_WITHIN=off', () => {
  it('the schema and description offer no `within`', () => {
    const def = fs.editFileDef;
    expect(Object.keys(def.input_schema.properties as object)).toEqual(['path', 'search', 'replace', 'replace_all']);
    expect(JSON.stringify(def)).not.toMatch(/within/);
  });

  it('a multi-match error tells the model to grow `search`, never to add `within`', async () => {
    const msg = await editMsg({ path: 'm.py', search: '        return 1', replace: '        return 2' });
    expect(msg).toContain('appears 2 times');
    expect(msg).toContain('add a neighbouring line to `search`');
    expect(msg).not.toMatch(/within/);
    expect(written).toBe('');
  });

  it('a `within` the model sends anyway is ignored: an ambiguous search still fails', async () => {
    const msg = await editMsg({
      path: 'm.py',
      within: 'class B:',
      search: '        return 1',
      replace: '        return 2',
    });
    expect(msg).toContain('appears 2 times');
    expect(msg).not.toMatch(/within/);
  });

  it('a `within` the model sends anyway does not block a unique search', async () => {
    const msg = await editMsg({
      path: 'm.py',
      within: 'not in the file at all',
      search: 'class B:\n    def run(self):\n        return 1',
      replace: 'class B:\n    def run(self):\n        return 2',
    });
    expect(msg).toContain('File edited');
    expect(msg).not.toMatch(/within/);
    expect(written).toBe(file.replace(/(class B:[\s\S]*return )1/, '$12'));
  });

  it('the dropped-definition refusal no longer suggests `within`', async () => {
    const msg = await editMsg({
      path: 'm.py',
      search: 'class B:\n    def run(self):\n        return 1',
      replace: 'class B:\n        return 2',
    });
    expect(msg).toContain('drops the line');
    expect(msg).not.toMatch(/within/);
  });
});
