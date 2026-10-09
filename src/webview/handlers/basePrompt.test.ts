import { describe, it, expect } from 'vitest';
import { buildBaseSystemPrompt } from './basePrompt.js';

describe('whole-file-rewrite strategy block', () => {
  const base = {
    isLocal: true,
    extensionVersion: '0.0.0',
    repoUrl: '',
    docsUrl: '',
    root: '/w',
    approvalMode: 'autonomous',
  };

  it('is absent by default', () => {
    expect(buildBaseSystemPrompt(base)).not.toContain('Whole-File Rewrite');
  });

  it('appends the read-then-rewrite directive when enabled', () => {
    const p = buildBaseSystemPrompt({ ...base, wholeFileRewrite: true });
    expect(p).toContain('## Edit Strategy: Whole-File Rewrite');
    expect(p).toContain('write_file');
    expect(p).toContain('read_file');
    expect(p).toContain('COMPLETE updated file');
  });
});

describe('insert API V2 prompt variant', () => {
  const base = {
    isLocal: true,
    extensionVersion: '0.0.0',
    repoUrl: '',
    docsUrl: '',
    root: '/w',
    approvalMode: 'autonomous',
  };

  it('teaches insertion via the one substitution primitive — anchor repeated in replace', () => {
    // insert_before / insert_after / new_text were removed: the field names
    // contradicted their semantics and V1 declared no home for the payload.
    const p = buildBaseSystemPrompt(base);
    expect(p).toContain('replace=<that SAME anchor line, then the new hello function>');
    expect(p).not.toContain('insert_after');
    expect(p).not.toContain('insert_before');
    expect(p).not.toContain('new_text');
  });
});

// Rule 9 said to fix any erroring command and re-run "until it exits cleanly",
// and rule 10 named `npx tsc --noEmit`. In a project without TypeScript the
// check fails to launch, and the way to make it exit cleanly is to install it:
// 30 of 32 ministral-3 runs that still installed packages or edited project
// config after the completion-gate fix did so after a task edit.
describe('checks that cannot run', () => {
  const prompt = buildBaseSystemPrompt({
    isLocal: true,
    extensionVersion: '0.0.0',
    repoUrl: '',
    docsUrl: '',
    root: '/w',
    approvalMode: 'autonomous',
  });

  it('says a check that cannot run is not an error to fix by installing or reconfiguring', () => {
    expect(prompt).toMatch(/cannot run at all .* is not an error in your code/);
    expect(prompt).toMatch(/do not install packages or create or edit project config to make it run/);
  });

  it('limits verification to the tools the project already has, and asks before installing one', () => {
    expect(prompt).toMatch(/Use only the checkers and test runners the project already has/);
    expect(prompt).toMatch(/in any mode, autonomous included: say which checker is missing and ask the user/);
  });
});
