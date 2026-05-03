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
