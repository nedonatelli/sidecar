import { describe, it, expect } from 'vitest';
import { generateContextReport } from './contextReport.js';

describe('generateContextReport', () => {
  it('generates a report with token estimates', () => {
    const report = generateContextReport(
      'You are SideCar, an AI assistant.',
      [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ],
      'claude-sonnet-4-6',
      100000,
    );
    expect(report).toContain('# SideCar Context Window');
    expect(report).toContain('claude-sonnet-4-6');
    expect(report).toContain('100,000');
    expect(report).toContain('## Breakdown');
  });

  it('handles empty conversation', () => {
    const report = generateContextReport('System prompt', [], 'llama3', 50000);
    expect(report).toContain('# SideCar Context Window');
    expect(report).toContain('llama3');
    expect(report).toContain('50,000');
  });

  it('includes token budget', () => {
    const report = generateContextReport('prompt', [{ role: 'user', content: 'test' }], 'model', 100000);
    expect(report).toContain('100,000');
  });

  it('handles messages with content blocks', () => {
    const report = generateContextReport(
      'System',
      [{ role: 'user', content: [{ type: 'text' as const, text: 'Hello with blocks' }] }],
      'model',
      50000,
    );
    expect(report).toContain('# SideCar Context Window');
  });

  it('includes SIDECAR.md section when present in system prompt', () => {
    const prompt = 'Preamble.\nProject instructions (from SIDECAR.md):\n# My project\nDetails here.\n\nEnd.';
    const report = generateContextReport(prompt, [], 'model', 50000);
    expect(report).toContain('SIDECAR.md');
  });

  it('splits workspace context into tree and files sections when both present', () => {
    const prompt = '## Workspace Structure\nfile1.ts\nfile2.ts\n## Relevant Files\nfile1.ts: content\n';
    const report = generateContextReport(prompt, [], 'model', 50000);
    expect(report).toContain('Workspace tree');
    expect(report).toContain('Workspace files');
  });

  it('uses "Workspace context" label when no ## Relevant Files section', () => {
    const prompt = '## Workspace Structure\nfile1.ts\nfile2.ts\n';
    const report = generateContextReport(prompt, [], 'model', 50000);
    expect(report).toContain('Workspace context');
  });

  it('counts tool result chars separately from user messages', () => {
    const report = generateContextReport(
      'System',
      [
        {
          role: 'user' as const,
          content: [{ type: 'tool_result' as const, tool_use_id: 'tu-1', content: 'tool output here' }],
        },
      ],
      'model',
      50000,
    );
    expect(report).toContain('Tool results');
  });
});

// #227 (from #116): the SIDECAR.md block was cut at its first blank line, and
// AGENTS.md / CLAUDE.md blocks were never reported.
describe('generateContextReport — project instructions', () => {
  const charsFor = (report: string, name: string) => {
    const row = report.split('\n').find((l) => l.startsWith(`| ${name} |`));
    return row ? Number(row.split('|')[2].trim().replace(/,/g, '')) : undefined;
  };

  it('counts the whole SIDECAR.md block, not its first paragraph', () => {
    const body = '# Rules\n\nFirst paragraph.\n\n## Build\n\nnpm run build';
    const block = `Project instructions (from SIDECAR.md):\n${body}`;
    const prompt = `Base.\n\n${block}\n\n## Session\n- Project root: /x`;
    expect(charsFor(generateContextReport(prompt, [], 'm', 50000), 'SIDECAR.md')).toBe(block.length);
  });

  it('reports AGENTS.md and CLAUDE.md blocks under their own names', () => {
    const prompt =
      'Base.\n\nProject instructions (from AGENTS.md):\nUse gh.\n\n' +
      'Project instructions (from src/CLAUDE.md):\nNo emoji.\n\nUser instructions:\nbe brief';
    const report = generateContextReport(prompt, [], 'm', 50000);
    expect(charsFor(report, 'AGENTS.md')).toBe('Project instructions (from AGENTS.md):\nUse gh.'.length);
    expect(charsFor(report, 'src/CLAUDE.md')).toBe('Project instructions (from src/CLAUDE.md):\nNo emoji.'.length);
  });
});
