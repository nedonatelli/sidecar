import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workspace } from 'vscode';
import type { LoopState } from './state.js';
import type { AgentCallbacks } from '../loop.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';
import { failed, mutated, type ToolOutcome } from '../tools/toolOutcome.js';
import {
  isScratchCandidate,
  madeByRun,
  noteScratchToolCalls,
  selectScratchFiles,
  scratchDestination,
  initScratchRunState,
  captureScratchBaseline,
  cleanupScratchAtTermination,
} from './scratchCleanup.js';

describe('isScratchCandidate (#387, #418)', () => {
  it.each([
    'reproduce_issue.py',
    'reproduce.py',
    'repro.py',
    'repro_issue.py',
    'verify_fix.py',
    'debug_output.js',
    'debug_x.py',
    'scratch.ts',
    'scratch.py',
    'check_roots.py',
    'check_fix.py',
    'compare_simps.py',
    'test_repro.py',
    'test_repro_null_byte.py',
    'test_kronecker.py',
    'test_version.ts',
    'pkg/repro_issue.py',
    'sympy/core/scratch.py',
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
    // #418: config and entry files, and deliverables, at the root.
    'jest.config.js',
    'conftest.py',
    'setup.py',
    'vite.config.ts',
    'eslint.config.mjs',
    'noxfile.py',
    'manage.py',
    'convert.py',
    'example.py',
    'run.sh',
    // #418: prefixes need a boundary and a script extension.
    'pkg/test_fixtures.py',
    'src/verify-email.tsx',
    'src/VerifyEmail.tsx',
    'verifier.py',
    'reproducible.md',
    '.github/workflows/check_links.yml',
    // #418: the generic verbs are modules away from the root.
    'myapp/debug_toolbar.py',
    'auth/verify_token.py',
    'src/verify-email.ts',
    // #418: never under a test directory.
    'tests/test_issue_1234.py',
    'tests/test_repro_issue.py',
    'tests/ordering/test_issue.py',
    'tests/roots/test-ext-autodoc/target/repro_issue.py',
    'src/__tests__/repro.test.ts',
    'pkg/testing/scratch.py',
    'spec/repro_spec.ts',
  ])('leaves %s alone', (rel) => {
    expect(isScratchCandidate(rel)).toBe(false);
  });
});

describe('madeByRun (#418)', () => {
  it('counts a path a file tool wrote', () => {
    expect(madeByRun('reproduce_issue.py', new Set(['reproduce_issue.py']), [])).toBe(true);
    expect(madeByRun('pkg/repro.py', new Set(['pkg/repro.py']), [])).toBe(true);
  });

  it.each([
    "cat <<'EOF' > reproduce_issue.py\nprint(1)\nEOF",
    'python reproduce_issue.py',
    'python ./reproduce_issue.py && echo ok',
    `python -c "open('reproduce_issue.py','w').write('x')"`,
  ])('counts a file a command names: %s', (cmd) => {
    expect(madeByRun('reproduce_issue.py', new Set(), [cmd])).toBe(true);
  });

  it('does not count a file no call of this run named', () => {
    expect(madeByRun('reproduce_issue.py', new Set(['pkg/mod.py']), ['python -m pytest tests'])).toBe(false);
    // A longer name is not the file.
    expect(madeByRun('repro.py', new Set(), ['python repro.py.bak', 'cat old_repro.py'])).toBe(false);
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
    const created = ['pkg/fixtures/repro_issue.py', 'test_repro_autodoc.py'];
    const contents = new Map([
      ['pkg/fixtures/repro_issue.py', 'class A: ...\n'],
      ['test_repro_autodoc.py', "actual = do_autodoc(app, 'class', 'fixtures.repro_issue.A')\n"],
    ]);
    // The fixture is referenced, so it stays; the test that refers to it is scratch-named and unreferenced.
    expect(selectScratchFiles(created, contents, '')).toEqual(['test_repro_autodoc.py']);
  });

  it('does not count a longer name containing the stem as a reference', () => {
    const contents = new Map([['pkg/mod.py', 'reproduce_issue_count = 0\n']]);
    expect(selectScratchFiles(['reproduce_issue.py'], contents, '')).toEqual(['reproduce_issue.py']);
  });

  it('keeps a file the user asked for by name', () => {
    expect(selectScratchFiles(['repro.py'], new Map(), 'Write repro.py that shows the crash')).toEqual([]);
  });

  it('keeps a root test_ file when the project already keeps test_ files at its root (#418)', () => {
    expect(selectScratchFiles(['test_parser.py'], new Map(), 'add tests', ['app.py', 'test_app.py'])).toEqual([]);
    expect(selectScratchFiles(['test_parser.py'], new Map(), 'add tests', ['app.py', 'README.md'])).toEqual([
      'test_parser.py',
    ]);
    // The strong prefixes don't depend on the convention.
    expect(selectScratchFiles(['test_repro.py'], new Map(), '', ['test_app.py'])).toEqual(['test_repro.py']);
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
      vi
        .spyOn(workspace.fs, 'readDirectory')
        .mockImplementation(async (u) =>
          (await fs.promises.readdir((u as { fsPath: string }).fsPath, { withFileTypes: true })).map(
            (d) => [d.name, d.isDirectory() ? 2 : 1] as [string, number],
          ),
        ),
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
      toolOutcomes: new Map(),
      logger: undefined,
    } as unknown as LoopState;
  }
  /** What noteScratchToolCalls records after a batch: a file tool's write, or a shell command. */
  const wrote = (state: LoopState, rel: string) => state.scratch!.written.add(rel);
  const ran = (state: LoopState, command: string) => state.scratch!.commands.push(command);
  const callbacks = () => ({ onText: vi.fn() }) as unknown as AgentCallbacks & { onText: ReturnType<typeof vi.fn> };

  it('moves a scratch file the run created, shell-written or not, and leaves git status clean of it', async () => {
    fs.writeFileSync(path.join(root, 'notes_before.py'), 'x = 1\n'); // untracked before the run: not ours
    const state = makeState('fix f', ['pkg/mod.py']);
    await captureScratchBaseline(state, root);

    fs.writeFileSync(path.join(root, 'pkg/mod.py'), 'def f(): return 1\n');
    fs.writeFileSync(path.join(root, 'reproduce_issue.py'), 'from pkg.mod import f\nprint(f())\n');
    ran(state, "cat <<'EOF' > reproduce_issue.py\nfrom pkg.mod import f\nprint(f())\nEOF");
    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'tests/test_mod_fix.py'), 'def test_f(): ...\n');
    wrote(state, 'tests/test_mod_fix.py');
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
    ran(state, 'python reproduce_issue.py');
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
    wrote(state, 'verify_fix.py');
    fs.writeFileSync(path.join(root, 'reproduce_issue.py'), 'print(2)\n'); // shell-made: unknown without git
    ran(state, 'cat > reproduce_issue.py');
    await cleanupScratchAtTermination(state, root, callbacks());
    expect(fs.existsSync(path.join(root, 'verify_fix.py'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'reproduce_issue.py'))).toBe(true);
  });

  it('keeps the files #418 lists, and still moves the scratch next to them', async () => {
    const state = makeState('Set up jest and write a script that converts CSV to JSON');
    await captureScratchBaseline(state, root);
    const kept = [
      'jest.config.js',
      'conftest.py',
      'setup.py',
      'vite.config.ts',
      'eslint.config.mjs',
      'noxfile.py',
      'manage.py',
      'convert.py',
      'pkg/test_fixtures.py',
      'verifier.py',
      'reproducible.md',
      'src/verify-email.tsx',
      'src/VerifyEmail.tsx',
      'myapp/debug_toolbar.py',
      '.github/workflows/check_links.yml',
      'tests/test_issue_1234.py',
    ];
    for (const rel of kept) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), 'x = 1\n');
      wrote(state, rel);
    }
    fs.writeFileSync(path.join(root, 'reproduce_issue.py'), 'print(1)\n');
    ran(state, "cat <<'EOF' > reproduce_issue.py\nprint(1)\nEOF\npython reproduce_issue.py");
    fs.writeFileSync(path.join(root, 'check_fix.py'), 'print(2)\n');
    wrote(state, 'check_fix.py');
    await cleanupScratchAtTermination(state, root, callbacks());

    for (const rel of kept) expect(fs.existsSync(path.join(root, rel)), rel).toBe(true);
    expect(fs.existsSync(path.join(root, 'reproduce_issue.py'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'check_fix.py'))).toBe(false);
  });

  it('keeps a scratch-named file no call of this run wrote or named (a background agent, the user)', async () => {
    const state = makeState();
    await captureScratchBaseline(state, root);
    fs.writeFileSync(path.join(root, 'reproduce_other.py'), 'print(1)\n'); // someone else's, mid-run
    fs.writeFileSync(path.join(root, 'repro.py'), 'print(2)\n');
    ran(state, 'python repro.py');
    await cleanupScratchAtTermination(state, root, callbacks());
    expect(fs.existsSync(path.join(root, 'reproduce_other.py'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'repro.py'))).toBe(false);
  });

  it('keeps a new root test_ file when the project keeps its tests at the root', async () => {
    fs.writeFileSync(path.join(root, 'test_mod.py'), 'def test_f(): ...\n');
    git('add', '-A');
    git('commit', '-qm', 'root tests');
    const state = makeState('add a test for g');
    await captureScratchBaseline(state, root);
    fs.writeFileSync(path.join(root, 'test_g.py'), 'def test_g(): ...\n');
    wrote(state, 'test_g.py');
    await cleanupScratchAtTermination(state, root, callbacks());
    expect(fs.existsSync(path.join(root, 'test_g.py'))).toBe(true);
  });
});

describe('noteScratchToolCalls (#418)', () => {
  const tu = (id: string, name: string, input: Record<string, unknown>): ToolUseContentBlock => ({
    type: 'tool_use',
    id,
    name,
    input,
  });

  it('records what file tools changed and what commands ran, through aliases, and nothing else', () => {
    const state = {
      scratch: initScratchRunState(true, ''),
      toolOutcomes: new Map<string, ToolOutcome>([
        ['a', mutated('repro.py')],
        ['b', mutated('pkg/mod.py')],
        ['c', failed('verify_fix.py')],
        ['d', mutated('gone.py')],
      ]),
    } as unknown as LoopState;
    noteScratchToolCalls(state, [
      tu('a', 'write_file', { path: 'repro.py' }),
      tu('b', 'str_replace', { path: 'pkg/mod.py' }),
      tu('c', 'write_file', { path: 'verify_fix.py' }),
      tu('d', 'delete_file', { path: 'gone.py' }),
      tu('e', 'bash', { command: 'python repro.py' }),
      tu('f', 'run_command', { command_id: 'cmd-1' }),
      tu('g', 'grep', { pattern: 'scratch.py' }),
    ]);
    expect([...state.scratch!.written].sort()).toEqual(['pkg/mod.py', 'repro.py']);
    expect(state.scratch!.commands).toEqual(['python repro.py']);
  });

  it('records nothing when cleanup is off', () => {
    const state = {
      scratch: initScratchRunState(false, ''),
      toolOutcomes: new Map([['a', mutated('repro.py')]]),
    } as unknown as LoopState;
    noteScratchToolCalls(state, [tu('a', 'write_file', { path: 'repro.py' })]);
    expect(state.scratch!.written.size).toBe(0);
  });
});
