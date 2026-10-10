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
