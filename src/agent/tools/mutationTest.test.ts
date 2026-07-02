import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workspace } from 'vscode';

vi.mock('./shell.js', () => ({ runVerificationCommand: vi.fn() }));
import { runVerificationCommand } from './shell.js';
import { mutationTools } from './mutationTest.js';

const exec = mutationTools[0].executor;
const ORIGINAL = 'def below(a, b):\n    return a < b\n';

let fileContent = ORIGINAL;

beforeEach(() => {
  fileContent = ORIGINAL;
  vi.spyOn(workspace.fs, 'readFile').mockImplementation(async () => Buffer.from(fileContent));
  vi.spyOn(workspace.fs, 'writeFile').mockImplementation(async (_uri: unknown, content: Uint8Array) => {
    fileContent = Buffer.from(content).toString('utf-8');
  });
});

/** Wire runVerificationCommand to a "suite" predicate over the current file. */
function suite(passes: (content: string) => boolean): void {
  (runVerificationCommand as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
    exitCode: passes(fileContent) ? 0 : 1,
    output: 'test output',
    timedOut: false,
  }));
}

describe('mutation_test tool', () => {
  it('requires file and test_command', async () => {
    expect(await exec({ test_command: 'pytest' })).toMatch(/`file` is required/);
    expect(await exec({ file: 'm.py' })).toMatch(/`test_command` is required/);
  });

  it('skips when the baseline test does not pass on the original', async () => {
    suite(() => false); // never green
    const out = await exec({ file: 'm.py', test_command: 'pytest' });
    expect(out).toMatch(/baseline test command did not pass/i);
  });

  it('reports 100% when a strong suite kills every mutant', async () => {
    suite((c) => c === ORIGINAL); // fails on any mutation
    const out = await exec({ file: 'm.py', test_command: 'pytest', operators: ['relational'] });
    expect(out).toContain('mutation score 100%');
    expect(out).toMatch(/All \d+ mutants killed/);
    expect(fileContent).toBe(ORIGINAL); // restored
  });

  it('lists surviving mutants when a weak suite catches nothing', async () => {
    suite(() => true); // always green — catches nothing
    const out = await exec({ file: 'm.py', test_command: 'pytest', operators: ['relational'] });
    expect(out).toContain('mutation score 0%');
    expect(out).toMatch(/surviving mutant/i);
    expect(out).toContain('m.py:2'); // the `<` on line 2
    expect(fileContent).toBe(ORIGINAL); // restored
  });

  it('honors the max_mutants cap', async () => {
    const MULTI = 'x = a < b < c < d < e'; // 4 relational mutants
    fileContent = MULTI;
    let runs = 0;
    (runVerificationCommand as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      runs++;
      return { exitCode: fileContent === MULTI ? 0 : 1, output: '', timedOut: false };
    });
    await exec({ file: 'm.py', test_command: 'pytest', operators: ['relational'], max_mutants: 2 });
    // 1 baseline run + at most 2 mutant runs (cap), not all 4.
    expect(runs).toBeLessThanOrEqual(3);
  });
});
