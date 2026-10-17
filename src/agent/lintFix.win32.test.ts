import { describe, it, expect, vi } from 'vitest';
import { execPortable } from './lintFix.js';

vi.mock('vscode', () => ({ workspace: {}, Uri: {} }));

// #117: the real launch, unmocked. npm is a .cmd script on Windows, which a
// shell-less execFile cannot start -- so this only means something there.
describe('execPortable on a real Windows host', () => {
  it.runIf(process.platform === 'win32')('starts npm', { timeout: 60_000 }, async () => {
    const { stdout } = await execPortable('npm', ['--version'], { timeout: 30_000 });
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
