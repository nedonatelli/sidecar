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

  it('teaches V1 by default — anchor in search, payload in insert_after', () => {
    const p = buildBaseSystemPrompt(base);
    expect(p).toContain('search=<the existing function, verbatim>, insert_after=<ONLY the new hello function>');
    expect(p).not.toContain('new_text');
  });

  it('teaches V2 when enabled — anchor in insert_after, payload in new_text', () => {
    const p = buildBaseSystemPrompt({ ...base, insertApiV2: true });
    expect(p).toContain('insert_after=<the existing function, verbatim>, new_text=<ONLY the new hello function>');
    expect(p).not.toContain('search=<the existing function, verbatim>, insert_after=<ONLY');
  });
});

describe('native tool-call note (notation vs emission)', () => {
  const base = {
    isLocal: true,
    extensionVersion: '0.0.0',
    repoUrl: '',
    docsUrl: '',
    root: '/w',
    approvalMode: 'autonomous',
  };

  it('is absent by default', () => {
    expect(buildBaseSystemPrompt(base)).not.toContain('## How to emit tool calls');
  });

  it('states the notation/emission distinction with a worked mapping when enabled', () => {
    const p = buildBaseSystemPrompt({ ...base, nativeToolCallNote: true });
    expect(p).toContain('## How to emit tool calls');
    expect(p).toContain('shorthand notation');
    expect(p).toContain('never write a tool call as text in your reply');
    // Worked mapping: shorthand on one side, arguments-object on the other.
    expect(p).toContain('edit_file(path="src/app.ts", search="old", replace="new")');
    expect(p).toContain('{"path": "src/app.ts", "search": "old", "replace": "new"}');
    expect(p).toContain('only emitted function calls run');
  });

  it('composes with whole-file rewrite — both blocks present, note first', () => {
    const p = buildBaseSystemPrompt({ ...base, nativeToolCallNote: true, wholeFileRewrite: true });
    expect(p.indexOf('## How to emit tool calls')).toBeLessThan(p.indexOf('## Edit Strategy: Whole-File Rewrite'));
  });
});
