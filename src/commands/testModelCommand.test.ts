import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

const shell = vi.hoisted(() => ({ execute: vi.fn(), dispose: vi.fn() }));
vi.mock('../terminal/shellSession.js', () => ({
  ShellSession: vi.fn(function () {
    return shell;
  }),
}));
vi.mock('../config/settings.js', () => ({ getConfig: () => ({ model: 'test-model' }) }));

import { registerTestModelCommand } from './testModelCommand.js';

async function runCommand(): Promise<void> {
  const register = vi.spyOn(vscode.commands, 'registerCommand');
  const evalProvider = { start: vi.fn(), updateCase: vi.fn(), finish: vi.fn() };
  registerTestModelCommand({ subscriptions: [] } as unknown as vscode.ExtensionContext, () => evalProvider as never);
  const handler = register.mock.calls.find((c) => c[0] === 'sidecar.testCurrentModel')?.[1];
  expect(handler).toBeDefined();
  register.mockRestore();
  await handler!();
}

describe('sidecar.testCurrentModel (#245)', () => {
  beforeEach(() => {
    shell.execute.mockReset();
    shell.dispose.mockReset();
    vi.spyOn(vscode.window, 'withProgress').mockImplementation(async (_o, task) =>
      task({ report: vi.fn() }, new vscode.CancellationTokenSource().token),
    );
  });

  it('disposes its shell session when the smoke run ends', async () => {
    shell.execute.mockResolvedValue('');
    await runCommand();
    expect(shell.execute).toHaveBeenCalledOnce();
    expect(shell.dispose).toHaveBeenCalledOnce();
  });

  it('disposes its shell session when the smoke run throws', async () => {
    shell.execute.mockRejectedValue(new Error('timed out'));
    await expect(runCommand()).rejects.toThrow('timed out');
    expect(shell.dispose).toHaveBeenCalledOnce();
  });
});
