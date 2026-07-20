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
