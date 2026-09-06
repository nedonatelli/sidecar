import { describe, it, expect, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import * as path from 'path';
import { installSandbox, type Sandbox } from './workspaceSandbox.js';

// The sandbox's `findFiles` is what `search_files` and `run_tests` see during
// an eval. Its glob support is a hand-rolled subset, and a gap in that subset
// is indistinguishable from a model behaving badly — the failure lands in the
// eval result, not in a stack trace anyone reads.
//
// That is exactly what happened: alternation branches were spliced into the
// regex without being converted, so `{test_*,*_test}.py` — the pattern
// `run_tests` uses to find pytest files — built an invalid regex and threw.
// 67 of 394 recorded runs took the throw instead of a test result, and all
// four failures of the best local model were among them.

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.teardown();
  sandbox = undefined;
});

const find = (include: string, exclude = ''): Promise<readonly { fsPath: string }[]> =>
  vscode.workspace.findFiles(include, exclude) as unknown as Promise<readonly { fsPath: string }[]>;

// path.basename, not split('/') — fsPath is backslash-separated on Windows,
// so splitting on '/' returned the whole absolute path as the "name".
const names = (found: readonly { fsPath: string }[]): string[] => found.map((f) => path.basename(f.fsPath)).sort();

describe('sandbox findFiles glob support', () => {
  it('matches pytest files through the alternation run_tests actually uses', async () => {
    // The regression. `**/{test_*,*_test}.py` is the literal pattern in
    // src/agent/tools/shell.ts — any workspace without a JS test suite
    // reaches it, which is most fixtures in the suite.
    sandbox = await installSandbox(
      {
        'test_calc.py': 'def test_add(): pass\n',
        'calc_test.py': 'def test_sub(): pass\n',
        'calc.py': 'def add(a, b): return a + b\n',
        'notes.md': '# notes\n',
      },
      'glob-alternation',
    );
    expect(names(await find('**/{test_*,*_test}.py'))).toEqual(['calc_test.py', 'test_calc.py']);
  });

  it('does not throw on an alternation branch starting with a wildcard', async () => {
    // The precise defect: a leading `*` spliced in raw is "nothing to repeat".
    sandbox = await installSandbox({ 'a_test.py': '' }, 'glob-leading-star');
    await expect(find('**/{*_test}.py')).resolves.toHaveLength(1);
  });

  it('expands a wildcard inside a branch instead of matching it literally', async () => {
    // The quiet half of the same defect, and the more dangerous half. A raw
    // `test_*` is valid regex — `test` then zero-or-more `_` — so it throws
    // nothing and simply fails to match `test_calc.py`. An eval case would
    // read that as "the agent wrote no tests".
    sandbox = await installSandbox({ 'test_calc.py': '', 'test.py': '', 'calc.py': '' }, 'glob-branch-wildcard');
    expect(names(await find('**/{test_*}.py'))).toEqual(['test_calc.py']);
  });

  it('still honours the exclude pattern', async () => {
    sandbox = await installSandbox({ 'src/a.ts': '', 'node_modules/pkg/b.ts': '' }, 'glob-exclude');
    expect(names(await find('**/*.ts', '**/node_modules/**'))).toEqual(['a.ts']);
  });

  it('matches nested paths through **/', async () => {
    sandbox = await installSandbox({ 'a.py': '', 'src/deep/b.py': '' }, 'glob-nested');
    expect(names(await find('**/*.py'))).toEqual(['a.py', 'b.py']);
  });
});

// A fixture is a bare temp dir, so `npx tsc --noEmit` found no project and
// printed 5,301 characters of help instead of diagnostics — 121 times across
// 394 recorded runs, concentrated in the models that verify their own work.
//
// The end-to-end tests below invoke the real compiler. Asserting that the
// config file exists, or that its JSON has the right keys, would repeat the
// exact mistake this fixes: checking the shape of a thing rather than whether
// it does anything. A tsconfig that parses but resolves nothing looks identical
// from the outside.

// This repo's own compiler, by absolute path. `npx tsc` cannot be used here:
// the cwd is a temp dir outside the repo, so npx does not find node_modules and
// falls through to the registry — where `tsc` is an unrelated abandoned package
// (`tsc@2.0.4`), not the TypeScript compiler. That passes locally on any
// machine with a global tsc and fails on CI, which is how it got here.
const TSC = path.resolve(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');

/** Run tsc in `root`, returning combined output — it exits non-zero on both a
 *  type error and a missing project, so the output is the only real signal. */
const runTsc = (root: string, args: string[] = ['--noEmit']): string => {
  try {
    return execFileSync(process.execPath, [TSC, ...args], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
};

describe('fixture tsconfig', () => {
  it('gives tsc a project, so a type error comes back as a diagnostic', () => {
    // The whole point. Without this the output is tsc's help text and the
    // agent learns nothing about the code it just wrote.
    return installSandbox({ 'src/a.ts': 'export const n: number = "not a number";\n' }, 'tsconf-error').then(
      async (sb) => {
        sandbox = sb;
        const out = runTsc(sb.root);
        expect(out).toContain('TS2322');
        expect(out).toContain('src/a.ts');
        expect(out).not.toContain('COMMON COMMANDS');
      },
    );
  });

  it('reports nothing for a fixture that is actually clean', () => {
    // A checker that always complains is as useless as one that never does.
    return installSandbox({ 'src/a.ts': 'export const n: number = 1;\n' }, 'tsconf-clean').then(async (sb) => {
      sandbox = sb;
      expect(runTsc(sb.root).trim()).toBe('');
    });
  });

  it('resolves the ./x.js specifiers the fixtures are written with', () => {
    // NodeNext, not node10. Under the wrong resolution every multi-file
    // TypeScript fixture reports import errors it does not have, which reads
    // as the agent having broken something.
    return installSandbox(
      {
        'src/dateUtils.ts': 'export function formatDate(d: Date): string {\n  return d.toISOString();\n}\n',
        'src/report.ts':
          "import { formatDate } from './dateUtils.js';\n" +
          'export function build(d: Date): string {\n  return formatDate(d);\n}\n',
      },
      'tsconf-nodenext',
    ).then(async (sb) => {
      sandbox = sb;
      expect(runTsc(sb.root).trim()).toBe('');
    });
  });

  it('does not let a bare tsc emit .js beside the fixture sources', () => {
    // noEmit is load-bearing. Emitted output lands in the snapshot the scorers
    // assert against, so verification would mutate the workspace it verifies.
    return installSandbox({ 'src/a.ts': 'export const n = 1;\n' }, 'tsconf-noemit').then(async (sb) => {
      sandbox = sb;
      runTsc(sb.root, []); // bare tsc — exit code is not the signal here, the file system is
      expect(existsSync(path.join(sb.root, 'src', 'a.js'))).toBe(false);
      expect(Object.keys(await sb.snapshot())).not.toContain('src/a.js');
    });
  });

  it('leaves a fixture that ships its own tsconfig untouched', () => {
    const own = '{ "compilerOptions": { "strict": false } }\n';
    return installSandbox({ 'src/a.ts': 'export const n = 1;\n', 'tsconfig.json': own }, 'tsconf-own').then((sb) => {
      sandbox = sb;
      expect(readFileSync(path.join(sb.root, 'tsconfig.json'), 'utf-8')).toBe(own);
    });
  });

  it('does not add one to a fixture with no TypeScript in it', () => {
    // A Python or plain-JS case has no use for a tsconfig, and an unexplained
    // extra file in the workspace is something the agent has to reason about.
    return installSandbox({ 'calc.py': 'def add(a, b):\n    return a + b\n' }, 'tsconf-python').then((sb) => {
      sandbox = sb;
      expect(existsSync(path.join(sb.root, 'tsconfig.json'))).toBe(false);
    });
  });
});
