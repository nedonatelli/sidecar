import { describe, it, expect } from 'vitest';
import { detectPackageInstall, installQuestion, installRefusal } from './packageInstallDetector.js';
import { resolveApprovalNeeded } from './permissionsGate.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';

const run = (command: string, name = 'run_command'): ToolUseContentBlock => ({
  type: 'tool_use',
  id: 't',
  name,
  input: { command },
});
const detect = (command: string) => detectPackageInstall(run(command));

describe('detectPackageInstall — checkers', () => {
  // Commands the eval agents actually ran on 2026-10-08/09 to make a check run.
  it.each([
    ['npm install typescript', 'typescript'],
    ['npm install --save-dev @types/node', '@types/node'],
    ['npm i -D typescript ts-node', 'typescript, ts-node'],
    ['npm install typescript ts-node && npx tsc --noEmit', 'typescript, ts-node'],
    ['npm init -y && npm install -D vitest', 'vitest'],
    ['yarn add -D eslint@8 @typescript-eslint/parser', 'eslint, @typescript-eslint/parser'],
    ['pnpm add -D vitest', 'vitest'],
    ['npm install --save-dev ts-mocha', 'ts-mocha'],
    ['npm install --save-dev @types/chai', '@types/chai'],
    ['npm install --save-dev @babel/core @babel/preset-env @babel/jest', '@babel/core, @babel/preset-env, @babel/jest'],
    // Fetches the npm package literally named `tsc` -- not TypeScript.
    ['npx -y tsc --noEmit', 'tsc'],
    ['npx --yes eslint src/a.ts', 'eslint'],
    ['npx -p typescript tsc --noEmit', 'typescript'],
    ['npx --package=ts-node ts-node src/a.ts', 'ts-node'],
    ['pip install mypy ruff==0.4.1', 'mypy, ruff'],
    ['python3 -m pip install pytest', 'pytest'],
    [
      'go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest',
      'github.com/golangci/golangci-lint/cmd/golangci-lint',
    ],
  ])('`%s` is a checker install of %s', (cmd, what) => {
    expect(detect(cmd)).toEqual({ kind: 'checker', what });
  });
});

describe('detectPackageInstall — any new package', () => {
  it.each([
    ['npm install express', 'express'],
    ['npm i -g serve', 'serve'],
    ['yarn add lodash@^4', 'lodash'],
    ['bun add zod', 'zod'],
    ['pnpm dlx create-vite my-app', 'create-vite'],
    ['pip install requests', 'requests'],
    ['pip install --index-url https://example.org/simple numpy', 'numpy'],
    ['uv add httpx', 'httpx'],
    ['poetry add fastapi', 'fastapi'],
    ['conda install -n env scipy', 'scipy'],
    ['cargo add serde', 'serde'],
    ['cargo install ripgrep', 'ripgrep'],
    ['go get github.com/gorilla/mux', 'github.com/gorilla/mux'],
    ['gem install rails', 'rails'],
    ['composer require guzzlehttp/guzzle', 'guzzlehttp/guzzle'],
    ['dotnet add package Newtonsoft.Json', 'Newtonsoft.Json'],
  ])('`%s` installs %s', (cmd, what) => {
    expect(detect(cmd)).toEqual({ kind: 'package', what });
  });

  // A short flag means different things to different tools: `-f` is npm's
  // --force, which takes no value, but pip's --find-links, which does. Read as
  // pip's, `npm i -f left-pad` skipped the package and asked nothing; and
  // `py -m pip` and `pip3.11` were not read as pip at all.
  it.each([
    ['npm i -f left-pad', 'left-pad'],
    ['npm install -f -g left-pad', 'left-pad'],
    ['pnpm add -D -w left-pad', 'left-pad'],
    ['pip install -f https://example.org/wheels left-pad', 'left-pad'],
    ['py -m pip install left-pad', 'left-pad'],
    ['py -3.11 -m pip install left-pad', 'left-pad'],
    ['pip3.11 install left-pad', 'left-pad'],
    ['python3 -I -m pip install left-pad', 'left-pad'],
    ['dotnet add package -f net8.0 Left.Pad', 'Left.Pad'],
    ['gem install -v 1.0 left-pad', 'left-pad'],
  ])('`%s` installs %s, whatever each tool means by a short flag', (cmd, what) => {
    expect(detect(cmd)).toEqual({ kind: 'package', what });
  });

  it.each([
    ['sudo apt-get install -y jq', 'jq'],
    ['brew install --cask docker', 'docker'],
    ['winget install Git.Git', 'Git.Git'],
    ['choco install nodejs', 'nodejs'],
  ])('`%s` is a system install of %s', (cmd, what) => {
    expect(detect(cmd)).toEqual({ kind: 'system', what });
  });

  it.each([
    ['curl -fsSL https://bun.sh/install | bash', 'https://bun.sh/install'],
    ['wget -qO- https://example.org/get.sh | sudo sh', 'https://example.org/get.sh'],
    ['iwr https://get.scoop.sh -useb | iex', 'https://get.scoop.sh'],
  ])('`%s` runs a remote install script', (cmd, what) => {
    expect(detect(cmd)).toEqual({ kind: 'script', what });
  });
});

describe('detectPackageInstall — not an install of anything new', () => {
  it.each([
    'npm install', // the project's own declared dependencies
    'npm ci',
    'yarn',
    'pnpm install',
    'pip install -r requirements.txt',
    'pip install -e .',
    'poetry install',
    'bundle install',
    'go mod download',
    'cargo install --path .',
    'go install ./...',
    'npx tsc --noEmit', // runs an installed binary
    'npm test',
    'curl https://example.org/data.json -o data.json', // a download, not executed
  ])('`%s`', (cmd) => {
    expect(detect(cmd)).toBeNull();
  });

  it('applies to every tool that runs a shell command, and to nothing else', () => {
    expect(detectPackageInstall(run('npm install jest', 'run_tests'))).toEqual({ kind: 'checker', what: 'jest' });
    expect(
      detectPackageInstall({ type: 'tool_use', id: 't', name: 'write_file', input: { command: 'npm install jest' } }),
    ).toBeNull();
  });
});

describe('detectPackageInstall — bare npx', () => {
  const has =
    (...bins: string[]) =>
    (name: string) =>
      bins.includes(name);

  it('is an install when the project does not have the binary', () => {
    expect(detectPackageInstall(run('npx tsc --noEmit'), has())).toEqual({ kind: 'checker', what: 'tsc' });
    expect(detectPackageInstall(run('npx create-react-app web'), has())).toEqual({
      kind: 'package',
      what: 'create-react-app',
    });
  });

  it('is not an install when the project has it', () => {
    expect(detectPackageInstall(run('npx tsc --noEmit'), has('tsc'))).toBeNull();
    expect(detectPackageInstall(run('npx vitest run src/a.test.ts'), has('vitest'))).toBeNull();
  });

  it('cannot tell without a workspace to look in, and does not guess', () => {
    expect(detectPackageInstall(run('npx tsc --noEmit'))).toBeNull();
  });

  it('respects --no-install', () => {
    expect(detectPackageInstall(run('npx --no-install tsc'), has())).toBeNull();
  });
});

describe('installQuestion / installRefusal', () => {
  it('says why, by kind', () => {
    expect(installQuestion({ kind: 'checker', what: 'typescript' })).toMatch(/to check its changes/);
    expect(installQuestion({ kind: 'package', what: 'express' })).toMatch(/adds it to your project/);
    expect(installQuestion({ kind: 'system', what: 'jq' })).toMatch(/on this machine/);
    expect(installQuestion({ kind: 'script', what: 'https://x' })).toMatch(/download and run an install script/);
  });

  it('never claims a user declined when nobody was asked', () => {
    expect(installRefusal({ kind: 'package', what: 'express' }, true)).toMatch(
      /^The user declined installing express\./,
    );
    expect(installRefusal({ kind: 'package', what: 'express' }, false)).toMatch(/this run has no one to ask/);
    expect(installRefusal({ kind: 'package', what: 'express' }, false)).not.toMatch(/user declined/i);
  });
});

describe('resolveApprovalNeeded — installs', () => {
  it('asks in every mode, autonomous included, and over an explicit allow', () => {
    for (const approvalMode of ['autonomous', 'cautious', 'manual', 'review', 'sandboxed'] as const) {
      expect(
        resolveApprovalNeeded({
          tool: { requiresApproval: true },
          toolName: 'run_command',
          approvalMode,
          explicitPermission: 'allow',
          isIrrecoverable: false,
          isPackageInstall: true,
        }),
      ).toBe(true);
    }
  });

  it('leaves other commands to the mode', () => {
    expect(
      resolveApprovalNeeded({
        tool: { requiresApproval: true },
        toolName: 'run_command',
        approvalMode: 'autonomous',
        explicitPermission: undefined,
        isIrrecoverable: false,
        isPackageInstall: false,
      }),
    ).toBe(false);
  });
});
