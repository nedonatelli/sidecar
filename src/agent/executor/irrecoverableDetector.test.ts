import { describe, it, expect } from 'vitest';
import { detectIrrecoverable } from './irrecoverableDetector.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';

function cmd(command: string): ToolUseContentBlock {
  return { type: 'tool_use', id: 'x', name: 'run_command', input: { command } };
}

function tool(name: string): ToolUseContentBlock {
  return { type: 'tool_use', id: 'x', name, input: {} };
}

describe('detectIrrecoverable', () => {
  // --- rm -rf variants ---
  it('detects rm -rf', () => expect(detectIrrecoverable(cmd('rm -rf /tmp/foo'))).toMatch(/force-delete/i));
  it('detects rm -fr', () => expect(detectIrrecoverable(cmd('rm -fr dist/'))).toMatch(/force-delete/i));
  it('detects rm -Rf', () => expect(detectIrrecoverable(cmd('rm -Rf build/'))).toMatch(/force-delete/i));
  it('detects rm --force --recursive', () =>
    expect(detectIrrecoverable(cmd('rm --force --recursive .'))).toMatch(/force-delete/i));
  it('detects rm --recursive --force', () =>
    expect(detectIrrecoverable(cmd('rm --recursive --force .'))).toMatch(/force-delete/i));

  // --- git push --force variants ---
  it('detects git push --force', () => expect(detectIrrecoverable(cmd('git push --force'))).toMatch(/force push/i));
  it('detects git push -f', () => expect(detectIrrecoverable(cmd('git push origin main -f'))).toMatch(/force push/i));
  it('detects git push --force-with-lease', () =>
    expect(detectIrrecoverable(cmd('git push --force-with-lease'))).toMatch(/force push/i));

  // --- git reset --hard ---
  it('detects git reset --hard', () =>
    expect(detectIrrecoverable(cmd('git reset --hard HEAD~1'))).toMatch(/hard reset/i));

  // --- git branch -D ---
  it('detects git branch -D', () =>
    expect(detectIrrecoverable(cmd('git branch -D old-feature'))).toMatch(/force branch delete/i));

  // --- git clean ---
  it('detects git clean -fd', () => expect(detectIrrecoverable(cmd('git clean -fd'))).toMatch(/git clean/i));
  it('detects git clean -fx', () => expect(detectIrrecoverable(cmd('git clean -fx'))).toMatch(/git clean/i));

  // --- destructive SQL ---
  it('detects DROP TABLE', () => expect(detectIrrecoverable(cmd('psql -c "DROP TABLE users"'))).toMatch(/drop/i));
  it('detects TRUNCATE DATABASE', () =>
    expect(detectIrrecoverable(cmd('TRUNCATE DATABASE mydb'))).toMatch(/truncate/i));

  // --- chmod/chown on root paths ---
  it('detects chmod targeting root /', () =>
    expect(detectIrrecoverable(cmd('chmod -R 777 /'))).toMatch(/permission change/i));
  it('detects chown targeting $HOME', () =>
    expect(detectIrrecoverable(cmd('chown user=$HOME/config'))).toMatch(/permission change/i));
  it('detects chmod targeting ~', () => expect(detectIrrecoverable(cmd('chmod 600 ~'))).toMatch(/permission change/i));

  // --- normal commands should return null ---
  it('returns null for safe rm without -rf', () => expect(detectIrrecoverable(cmd('rm file.txt'))).toBeNull());
  it('returns null for git push without --force', () =>
    expect(detectIrrecoverable(cmd('git push origin main'))).toBeNull());
  it('returns null for git reset --soft', () => expect(detectIrrecoverable(cmd('git reset --soft HEAD'))).toBeNull());
  it('returns null for npm test', () => expect(detectIrrecoverable(cmd('npm test'))).toBeNull());
  it('returns null for non-run_command tool', () => expect(detectIrrecoverable(tool('read_file'))).toBeNull());
  it('returns null for write_file', () => expect(detectIrrecoverable(tool('write_file'))).toBeNull());
});
