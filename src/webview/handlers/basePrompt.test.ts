import { describe, it, expect } from 'vitest';
import { buildBaseSystemPrompt } from './basePrompt.js';
import { TOOL_OUTPUT_IS_DATA_RULE } from '../../agent/safetyRules.js';

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

// Rule 10 said "After fixing bugs, call run_tests" with no stop: in a project
// without tests, models built a test setup to have something to run (#170).
describe('rule 10 in a project without tests', () => {
  it('stops at a "no tests" result instead of building a test setup', () => {
    const prompt = buildBaseSystemPrompt({
      isLocal: true,
      extensionVersion: '0.0.0',
      repoUrl: '',
      docsUrl: '',
      root: '/w',
      approvalMode: 'autonomous',
    });
    expect(prompt).toMatch(/if it reports the project has no tests, stop there/);
    expect(prompt).toMatch(/do not write tests or install a test framework to have something to run/);
  });
});

// The SWE harness removes run_tests and web_search; a prompt that still named
// them sent models to call them, and on Ollama the call ended the run (#485).
describe('tools the session does not offer', () => {
  const base = {
    isLocal: true,
    extensionVersion: '0.0.0',
    repoUrl: '',
    docsUrl: '',
    root: '/w',
    approvalMode: 'autonomous',
  };
  const hidden = new Set(['run_tests', 'web_search', 'git_commit']);

  it('names every tool when offersTool is omitted', () => {
    const p = buildBaseSystemPrompt(base);
    expect(p).toContain('call `run_tests`');
    expect(p).toContain('Use `web_search`');
    expect(p).toContain('git_commit');
  });

  it('names none of the hidden tools and points tests at run_command', () => {
    const p = buildBaseSystemPrompt({ ...base, offersTool: (n) => !hidden.has(n) });
    // The shared safety rule lists web_search as a source of untrusted data,
    // not as a tool to call; it stays the same in every session.
    const instructions = p.replace(TOOL_OUTPUT_IS_DATA_RULE, '');
    for (const name of hidden) expect(instructions).not.toContain(name);
    expect(p).toContain(
      "run the project's tests with `run_command`; if it reports the project has no tests, stop there",
    );
    expect(p).toContain("For test running: `run_command` with the project's test runner.");
    expect(p).toContain('**Web:** screenshot_page, analyze_screenshot.');
    expect(p).toContain('`run_command` with `curl -sL <url>` fetches it');
  });
});
