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

// The patterns matched one spelling of each flag: an extra letter, another
// order, a flag on its own, or another shell's command for the same thing
// went through with one-click approval, or none in autonomous mode.
describe('other spellings of the same destructive commands', () => {
  it.each([
    ['rm -rfv build/', /force-delete/i],
    ['rm -vrf build/', /force-delete/i],
    ['rm -r -f build/', /force-delete/i],
    ['rm build/ -rf', /force-delete/i],
    ['cd x && rm -fR --no-preserve-root /', /force-delete/i],
    ['rmdir /s /q build', /recursive delete/i],
    ['rd /S build', /recursive delete/i],
    ['del /s /q *.log', /recursive delete/i],
    ['Remove-Item -Recurse -Force .\\build', /recursive delete/i],
    ['powershell -Command "Remove-Item build -Recurse"', /recursive delete/i],
    ['find build -delete', /find/i],
    ['find build -type f -exec rm {} +', /find/i],
    ['find . -name * -delete', /find/i],
    ['git push origin +main', /force push/i],
    ['git push -fu origin main', /force push/i],
    ['git push -uf origin main', /force push/i],
    ['git push --force-if-includes origin main', /force push/i],
    ['git checkout -- .', /discards/i],
    ['git checkout .', /discards/i],
    ['git checkout -f main', /discards/i],
    ['git restore .', /discards/i],
    ['git clean -xdf', /git clean/i],
    ['git branch --delete --force old', /force branch delete/i],
    ['bash -c "rm -rf build"', /force-delete/i],
    ['sudo /bin/rm -rf /var/x', /force-delete/i],
    ['ls | xargs rm -rf', /force-delete/i],
    ['git -C repo push --force', /force push/i],
  ])('flags %s', (command, kind) => expect(detectIrrecoverable(cmd(command))).toMatch(kind));

  it.each([
    'rm -r -i build/',
    'rm -f stale.lock',
    'rmdir build',
    'del notes.txt',
    'Remove-Item build\\out.txt',
    'find . -name "*.py"',
    'find src/ -name "*.bak" -type f -delete', // the usual cleanup after sed -i.bak
    "find src -name '*.bak' -exec rm {} +",
    'git push origin main',
    'git push -u origin feature',
    'git push origin main:main',
    'git checkout main',
    'git checkout -b feature',
    'git checkout -- src/app.ts',
    'git restore --staged src/app.ts',
    'grep -rf patterns.txt src',
  ])('leaves %s alone', (command) => expect(detectIrrecoverable(cmd(command))).toBeNull());
});

// run_tests and research_log_experiment take a free-form command; the
// type-to-CONFIRM gate saw only run_command.
describe('every tool that runs a shell command', () => {
  it.each(['run_tests', 'research_log_experiment'])('%s with a destructive command is flagged', (name) => {
    for (const command of ['rm -rf ~/project', 'git push --force origin main', 'git reset --hard HEAD~3']) {
      expect(detectIrrecoverable({ type: 'tool_use', id: 'x', name, input: { command } } as never)).not.toBeNull();
    }
  });

  it('run_tests without a command (auto-detected runner) is not flagged', () => {
    expect(detectIrrecoverable({ type: 'tool_use', id: 'x', name: 'run_tests', input: {} } as never)).toBeNull();
  });
});
