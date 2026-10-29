import { describe, it, expect } from 'vitest';
import {
  detectConfigEdit,
  requestNamesConfigChange,
  configEditQuestion,
  configEditRefusal,
  type ConfigEdit,
} from './configEditDetector.js';
import { resolveApprovalNeeded } from './permissionsGate.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';

const call = (name: string, input: Record<string, unknown>): ToolUseContentBlock => ({
  type: 'tool_use',
  id: 't',
  name,
  input,
});
const edit = (path: string) => detectConfigEdit(call('edit_file', { path, search: 'a', replace: 'b' }));
const run = (command: string) => detectConfigEdit(call('run_command', { command }));

describe('detectConfigEdit — file tools', () => {
  it.each([
    ['package.json', 'package'],
    ['tsconfig.json', 'typescript'],
    ['tsconfig.build.json', 'typescript'],
    ['packages/core/tsconfig.json', 'typescript'],
    ['jsconfig.json', 'typescript'],
    ['.eslintrc.json', 'lint'],
    ['.eslintrc', 'lint'],
    ['eslint.config.mjs', 'lint'],
    ['.prettierrc', 'lint'],
    ['prettier.config.js', 'lint'],
    ['vitest.config.ts', 'test'],
    ['jest.config.js', 'test'],
    ['pytest.ini', 'test'],
    ['tox.ini', 'test'],
    ['pyproject.toml', 'python'],
    ['setup.cfg', 'python'],
    ['requirements-dev.txt', 'python'],
    ['C:\\proj\\tsconfig.json', 'typescript'],
  ])('%s is %s config', (path, family) => {
    expect(edit(path)).toMatchObject({ family, file: path, via: 'edit_file' });
  });

  it('covers write_file, including creating a config file, and delete_file', () => {
    expect(detectConfigEdit(call('write_file', { path: 'tsconfig.json', content: '{}' }))).toMatchObject({
      via: 'write_file',
    });
    expect(detectConfigEdit(call('delete_file', { path: 'package.json' }))).toMatchObject({ via: 'delete_file' });
  });

  it.each(['src/config.ts', 'src/package.ts', 'package-lock.json', 'README.md', 'tests/tsconfig.test.ts', 'setup.py'])(
    'leaves %s alone',
    (path) => {
      expect(edit(path)).toBeNull();
    },
  );

  it('ignores reads and other tools', () => {
    expect(detectConfigEdit(call('read_file', { path: 'package.json' }))).toBeNull();
    expect(detectConfigEdit(call('grep', { pattern: 'x', path: 'tsconfig.json' }))).toBeNull();
  });
});

describe('detectConfigEdit — commands', () => {
  it.each([
    // From the eval runs (#169).
    ['npm init -y', 'package.json'],
    ['npm init -y && npm install --save-dev jest', 'package.json'],
    ['npm pkg set scripts.test="vitest run"', 'package.json'],
    ['npm pkg delete scripts.lint', 'package.json'],
    ['yarn init -y', 'package.json'],
    ['npx tsc --init', 'tsconfig.json'],
    ['poetry init -n', 'pyproject.toml'],
    ['echo \'{"compilerOptions":{}}\' > tsconfig.json', 'tsconfig.json'],
    ['cat >> package.json <<EOF', 'package.json'],
    ['echo x | tee .eslintrc.json', '.eslintrc.json'],
    ["sed -i 's/commonjs/nodenext/' tsconfig.json", 'tsconfig.json'],
    ["perl -pi -e 's/a/b/' package.json", 'package.json'],
  ])('%s changes %s', (command, file) => {
    expect(run(command)).toMatchObject({ file, via: 'command' });
  });

  it.each([
    'npm install',
    'npm test',
    'npm pkg get version',
    'cat package.json',
    'npx tsc --noEmit -p tsconfig.json',
    "sed -n '1,20p' tsconfig.json",
    'node build.js > out.txt 2>&1',
    'npx eslint . > lint.log',
  ])('leaves %s alone', (command) => {
    expect(run(command)).toBeNull();
  });
});

describe('requestNamesConfigChange', () => {
  const tsconfig = edit('tsconfig.json')!;
  const pkg = edit('package.json')!;
  const eslint = edit('.eslintrc.json')!;
  const vitest = edit('vitest.config.ts')!;
  const pyproject = edit('pyproject.toml')!;
  const npmInit = run('npm init -y')!;

  it("proceeds on the agent eval's two config-task requests (#169)", () => {
    expect(requestNamesConfigChange(pkg, 'Add a test script to package.json that runs node src/sum.test.js.')).toBe(
      true,
    );
    expect(requestNamesConfigChange(tsconfig, 'Enable TypeScript strict mode for this project.')).toBe(true);
  });

  it('proceeds when the request names the file', () => {
    expect(requestNamesConfigChange(tsconfig, 'Set `module` to nodenext in tsconfig.json.')).toBe(true);
    expect(requestNamesConfigChange(pkg, 'Rename the package in package.json to "acme".')).toBe(true);
    expect(requestNamesConfigChange(vitest, 'Fix vitest.config.ts so it finds the tests.')).toBe(true);
    expect(requestNamesConfigChange(edit('tsconfig.build.json')!, 'Exclude tests from tsconfig.build.json')).toBe(true);
  });

  it('proceeds when the request asks for that kind of change', () => {
    expect(requestNamesConfigChange(pkg, 'Add a test script that runs vitest.')).toBe(true);
    expect(requestNamesConfigChange(pkg, 'Add lodash as a dependency.')).toBe(true);
    expect(requestNamesConfigChange(pkg, 'Bump the version to 2.0.0.')).toBe(true);
    expect(requestNamesConfigChange(npmInit, 'Set up a package.json for this folder.')).toBe(true);
    expect(requestNamesConfigChange(tsconfig, 'Enable strict mode.')).toBe(true);
    expect(requestNamesConfigChange(tsconfig, 'Turn on noImplicitAny and fix the errors.')).toBe(true);
    expect(requestNamesConfigChange(tsconfig, 'Update the compiler options for ES2022.')).toBe(true);
    expect(requestNamesConfigChange(eslint, 'Disable the no-console rule.')).toBe(true);
    expect(requestNamesConfigChange(eslint, 'Update our ESLint config to allow underscores.')).toBe(true);
    expect(requestNamesConfigChange(vitest, 'Raise the coverage thresholds to 90%.')).toBe(true);
    expect(requestNamesConfigChange(pyproject, 'Add requests to the project dependencies.')).toBe(true);
    expect(requestNamesConfigChange(pyproject, 'Configure ruff rules to allow long lines.')).toBe(true);
  });

  it('asks when the request is about something else -- the issue cases', () => {
    // sidecar-md-jsdoc-rule: tsconfig module/target rewritten during a JSDoc task.
    expect(
      requestNamesConfigChange(
        tsconfig,
        'Add a `multiply(a: number, b: number): number` function to `src/math.ts` that returns `a * b`.',
      ),
    ).toBe(false);
    // thinking-semantic-version-compare: "version" is not a version bump.
    expect(
      requestNamesConfigChange(
        pkg,
        '`isAtLeast("10.0.0", "9.0.0")` returns false, but it should return true. ' +
          'Fix the bug in src/version.ts so that version comparison is numeric, not lexicographic.',
      ),
    ).toBe(false);
    expect(requestNamesConfigChange(npmInit, 'Write unit tests for src/math.ts.')).toBe(false);
  });

  it('does not take generic words for a config request', () => {
    expect(requestNamesConfigChange(eslint, 'Fix the lint errors in src/a.ts.')).toBe(false);
    expect(requestNamesConfigChange(tsconfig, 'Make sure `tsc --noEmit` passes after your change.')).toBe(false);
    expect(requestNamesConfigChange(tsconfig, 'Use strict equality in src/cmp.ts.')).toBe(false);
    expect(requestNamesConfigChange(pkg, 'Fix the circular dependency between a.ts and b.ts.')).toBe(false);
    expect(requestNamesConfigChange(pkg, 'Refactor the dependency injection in src/app.ts.')).toBe(false);
    expect(requestNamesConfigChange(pkg, 'Update the config loader in src/config.ts.')).toBe(false);
  });

  it('does not count a mention under a negation', () => {
    expect(requestNamesConfigChange(tsconfig, 'Fix the type error in src/a.ts; do not touch tsconfig.json.')).toBe(
      false,
    );
    expect(requestNamesConfigChange(pkg, 'Rename foo to bar without changing package.json.')).toBe(false);
    expect(requestNamesConfigChange(pkg, 'Fix src/a.ts and leave package.json alone.')).toBe(false);
    // ...but a negation reaches only its own clause.
    expect(requestNamesConfigChange(tsconfig, "Don't use any; enable strict mode in tsconfig.json.")).toBe(true);
  });

  it('a mention of one file does not license another', () => {
    expect(requestNamesConfigChange(tsconfig, 'Add a test script to package.json.')).toBe(false);
  });

  it('asks when there is no request to read', () => {
    expect(requestNamesConfigChange(pkg, undefined)).toBe(false);
    expect(requestNamesConfigChange(pkg, '')).toBe(false);
  });
});

describe('configEditQuestion / configEditRefusal', () => {
  const tsconfig: ConfigEdit = { family: 'typescript', file: 'tsconfig.json', via: 'edit_file' };

  it('says which file and why it is asking', () => {
    expect(configEditQuestion(tsconfig)).toMatch(/edit \*\*tsconfig\.json\*\*.*did not ask to change it/);
    expect(configEditQuestion(run('npm init -y')!)).toMatch(
      /command that changes \*\*package\.json\*\* \(`npm init`\)/,
    );
  });

  it('tells the model what to do instead, and never claims a user declined when nobody was asked', () => {
    const declined = configEditRefusal(tsconfig, true);
    expect(declined).toMatch(/^The user declined this change to tsconfig\.json/);
    expect(declined).toMatch(/Do not change it another way/);
    expect(declined).toMatch(/Finish the task without changing project config/);
    expect(declined).toMatch(/say in your answer what change it needs/);
    const nobody = configEditRefusal(tsconfig, false);
    expect(nobody).toMatch(/this run has no one to ask/);
    expect(nobody).not.toMatch(/user declined/i);
  });
});

describe('resolveApprovalNeeded — unrequested config edits', () => {
  const opts = (approvalMode: 'autonomous' | 'cautious' | 'manual' | 'review' | 'sandboxed', toolName: string) => ({
    tool: { requiresApproval: true },
    toolName,
    approvalMode,
    explicitPermission: 'allow' as const,
    isIrrecoverable: false,
    isUnrequestedConfigEdit: true,
  });

  it('asks in every mode, autonomous included, and over an explicit allow', () => {
    for (const mode of ['autonomous', 'cautious', 'manual', 'review'] as const) {
      expect(resolveApprovalNeeded(opts(mode, 'edit_file'))).toBe(true);
      expect(resolveApprovalNeeded(opts(mode, 'run_command'))).toBe(true);
    }
  });

  it('does not ask for a file write contained in a sandboxed shadow, but does for a command', () => {
    expect(resolveApprovalNeeded(opts('sandboxed', 'write_file'))).toBe(false);
    expect(resolveApprovalNeeded(opts('sandboxed', 'run_command'))).toBe(true);
  });
});
