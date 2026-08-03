import { describe, it, expect, afterEach } from 'vitest';
import * as vscode from 'vscode';
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

const names = (found: readonly { fsPath: string }[]): string[] => found.map((f) => f.fsPath.split('/').pop()!).sort();

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
