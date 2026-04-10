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
});
