import { describe, it, expect } from 'vitest';
import { detectCheckerInstall } from './checkerInstallDetector.js';
import { resolveApprovalNeeded } from './permissionsGate.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';

const run = (command: string, name = 'run_command'): ToolUseContentBlock => ({
  type: 'tool_use',
  id: 't',
  name,
  input: { command },
});

describe('detectCheckerInstall', () => {
  // Commands the eval agents actually ran on 2026-10-08 to make a check run.
  it.each([
    ['npm install typescript', 'typescript'],
    ['npm install --save-dev @types/node', '@types/node'],
    ['npm i -D typescript ts-node', 'typescript, ts-node'],
    ['npm install typescript ts-node && npx tsc --noEmit', 'typescript, ts-node'],
    ['yarn add -D eslint@8 @typescript-eslint/parser', 'eslint, @typescript-eslint/parser'],
    ['pnpm add -D vitest', 'vitest'],
    // Fetches the npm package literally named `tsc` -- not TypeScript.
    ['npx -y tsc --noEmit', 'tsc'],
    ['npx --yes eslint src/a.ts', 'eslint'],
    ['pip install mypy ruff==0.4.1', 'mypy, ruff'],
    ['python3 -m pip install pytest', 'pytest'],
    ['go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest', 'golangci-lint'],
  ])('flags `%s`', (cmd, packages) => {
    expect(detectCheckerInstall(run(cmd))).toBe(packages);
  });

  it.each([
    'npm install', // the project's own declared dependencies
    'npm ci',
    'npm install express lodash',
    'pip install requests',
    'npx tsc --noEmit', // runs an installed checker; installs nothing
    'npm test',
  ])('ignores `%s`', (cmd) => {
    expect(detectCheckerInstall(run(cmd))).toBeNull();
  });

  it('applies to every tool that runs a shell command, and to nothing else', () => {
    expect(detectCheckerInstall(run('npm install jest', 'run_tests'))).toBe('jest');
    expect(
      detectCheckerInstall({ type: 'tool_use', id: 't', name: 'write_file', input: { command: 'npm install jest' } }),
    ).toBeNull();
  });
});

describe('resolveApprovalNeeded — checker installs', () => {
  it('asks in every mode, autonomous included, and over an explicit allow', () => {
    for (const approvalMode of ['autonomous', 'cautious', 'manual', 'review', 'sandboxed'] as const) {
      expect(
        resolveApprovalNeeded({
          tool: { requiresApproval: true },
          toolName: 'run_command',
          approvalMode,
          explicitPermission: 'allow',
          isIrrecoverable: false,
          isCheckerInstall: true,
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
        isCheckerInstall: false,
      }),
    ).toBe(false);
  });
});
