import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workspace } from 'vscode';
import type { LoopState } from './state.js';
import type { AgentCallbacks } from '../loop.js';
import {
  isScratchCandidate,
  selectScratchFiles,
  scratchDestination,
  initScratchRunState,
  captureScratchBaseline,
  cleanupScratchAtTermination,
} from './scratchCleanup.js';

describe('isScratchCandidate (#387)', () => {
  it.each([
    'reproduce_issue.py',
    'repro.py',
    'verify_fix.py',
    'debug_output.js',
    'scratch.ts',
    'check_roots.py',
    'test_repro_null_byte.py',
    'tests/roots/test-ext-autodoc/target/repro_issue.py',
    'example.py',
    'run.sh',
  ])('marks %s', (rel) => {
    expect(isScratchCandidate(rel)).toBe(true);
  });

  it.each([
    'sympy/core/tests/test_mod_fix.py',
    'tests/utils_tests/test_autoreload_null_byte.py',
    'src/newModule.ts',
    'README.md',
    'conftest_notes.txt',
    '.sidecar/scratchpad/run-1/reproduce_issue.py',
  ])('leaves %s alone', (rel) => {
    expect(isScratchCandidate(rel)).toBe(false);
  });
});

describe('selectScratchFiles (#387)', () => {
  it('selects scratch files nothing else in the change refers to', () => {
    const created = ['reproduce_issue.py', 'tests/test_regression.py'];
    const contents = new Map([
      ['reproduce_issue.py', 'from pkg import f\nprint(f())\n'],
      ['tests/test_regression.py', 'def test_f(): ...\n'],
      ['pkg/mod.py', 'def f(): return 1\n'],
    ]);
    expect(selectScratchFiles(created, contents, 'fix f')).toEqual(['reproduce_issue.py']);
  });

  it('keeps a scratch-named file another file in the change imports', () => {
    const created = ['tests/roots/target/repro_issue.py', 'tests/test_repro_autodoc.py'];
    const contents = new Map([
      ['tests/roots/target/repro_issue.py', 'class A: ...\n'],
      ['tests/test_repro_autodoc.py', "actual = do_autodoc(app, 'class', 'target.repro_issue.A')\n"],
    ]);
    // The fixture is referenced, so it stays; the test that refers to it is scratch-named and unreferenced.
    expect(selectScratchFiles(created, contents, '')).toEqual(['tests/test_repro_autodoc.py']);
  });

  it('does not count a longer name containing the stem as a reference', () => {
    const contents = new Map([['pkg/mod.py', 'reproduce_issue_count = 0\n']]);
    expect(selectScratchFiles(['reproduce_issue.py'], contents, '')).toEqual(['reproduce_issue.py']);
  });

  it('keeps a file the user asked for by name', () => {
    expect(selectScratchFiles(['repro.py'], new Map(), 'Write repro.py that shows the crash')).toEqual([]);
  });
});

describe('cleanupScratchAtTermination (#387)', () => {
  let root: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf-8' });
  const spies: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch387-'));
    // Real git and real files: the mock's workspace.fs is a stub, so route it to node's fs.
    spies.push(
      vi.spyOn(workspace.fs, 'stat').mockImplementation(async (u) => {
        const st = await fs.promises.stat((u as { fsPath: string }).fsPath);
        return { type: st.isDirectory() ? 2 : 1, size: st.size, ctime: st.ctimeMs, mtime: st.mtimeMs };
      }),
      vi
        .spyOn(workspace.fs, 'readFile')
        .mockImplementation(async (u) => fs.promises.readFile((u as { fsPath: string }).fsPath)),
      vi
        .spyOn(workspace.fs, 'writeFile')
        .mockImplementation(async (u, c) => fs.promises.writeFile((u as { fsPath: string }).fsPath, c)),
      vi.spyOn(workspace.fs, 'createDirectory').mockImplementation(async (u) => {
        await fs.promises.mkdir((u as { fsPath: string }).fsPath, { recursive: true });
      }),
      vi
        .spyOn(workspace.fs, 'rename')
        .mockImplementation(async (a, b) =>
          fs.promises.rename((a as { fsPath: string }).fsPath, (b as { fsPath: string }).fsPath),
        ),
    );
    for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) delete process.env[k];
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    fs.mkdirSync(path.join(root, 'pkg'));
    fs.writeFileSync(path.join(root, 'pkg/mod.py'), 'def f(): return 0\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
  });

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeState(userText = 'fix f', editedFiles: string[] = []): LoopState {
    return {
      runId: 'run-1',
      scratch: initScratchRunState(true, userText),
      gateState: { editedFiles: new Set(editedFiles) },
      logger: undefined,
    } as unknown as LoopState;
  }
  const callbacks = () => ({ onText: vi.fn() }) as unknown as AgentCallbacks & { onText: ReturnType<typeof vi.fn> };

  it('moves a scratch file the run created, shell-written or not, and leaves git status clean of it', async () => {
    fs.writeFileSync(path.join(root, 'notes_before.py'), 'x = 1\n'); // untracked before the run: not ours
    const state = makeState('fix f', ['pkg/mod.py']);
    await captureScratchBaseline(state, root);

    fs.writeFileSync(path.join(root, 'pkg/mod.py'), 'def f(): return 1\n');
    fs.writeFileSync(path.join(root, 'reproduce_issue.py'), 'from pkg.mod import f\nprint(f())\n');
    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'tests/test_mod_fix.py'), 'def test_f(): ...\n');
    const cb = callbacks();
    await cleanupScratchAtTermination(state, root, cb);

    expect(fs.existsSync(path.join(root, 'reproduce_issue.py'))).toBe(false);
    expect(fs.readFileSync(path.join(root, scratchDestination('run-1', 'reproduce_issue.py')), 'utf-8')).toContain(
      'print(f())',
    );
    expect(fs.existsSync(path.join(root, 'notes_before.py'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'tests/test_mod_fix.py'))).toBe(true);
    // No .sidecar/.gitignore exists here: the run folder ignores itself.
    expect(git('status', '--porcelain', '--untracked-files=all')).not.toContain('.sidecar');
    expect(cb.onText).toHaveBeenCalledWith(expect.stringContaining('reproduce_issue.py'));
  });

  it('does nothing when it is off', async () => {
    const state = makeState();
    state.scratch!.enabled = false;
    await captureScratchBaseline(state, root);
    fs.writeFileSync(path.join(root, 'reproduce_issue.py'), 'print(1)\n');
    const cb = callbacks();
    await cleanupScratchAtTermination(state, root, cb);
    expect(fs.existsSync(path.join(root, 'reproduce_issue.py'))).toBe(true);
    expect(cb.onText).not.toHaveBeenCalled();
  });

  it('without git, moves only files write_file created', async () => {
    fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
    const state = makeState();
    state.ratchet = { originals: new Map([['verify_fix.py', null]]) } as LoopState['ratchet'];
    await captureScratchBaseline(state, root);
    fs.writeFileSync(path.join(root, 'verify_fix.py'), 'print(1)\n');
    fs.writeFileSync(path.join(root, 'reproduce_issue.py'), 'print(2)\n'); // shell-made: unknown without git
    await cleanupScratchAtTermination(state, root, callbacks());
    expect(fs.existsSync(path.join(root, 'verify_fix.py'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'reproduce_issue.py'))).toBe(true);
  });
});
