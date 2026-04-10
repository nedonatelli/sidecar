import { describe, it, expect, vi } from 'vitest';
import { generateUsageReport } from './usageReport.js';
import type { AgentRunMetrics } from './metrics.js';

// Mock getConfig to return a known model
vi.mock('../config/settings.js', () => ({
  getConfig: () => ({ model: 'claude-sonnet-4-6', dailyBudget: 5, weeklyBudget: 20 }),
  estimateCost: (model: string, input: number, output: number) => {
    if (model.includes('claude')) return (input * 3 + output * 15) / 1_000_000;
    return null;
  },
}));

function makeRun(overrides: Partial<AgentRunMetrics> = {}): AgentRunMetrics {
  return {
    timestamp: Date.now(),
    iterations: 3,
    toolCalls: [{ name: 'read_file', durationMs: 50, isError: false }],
    totalTokensEstimate: 1000,
    durationMs: 5000,
    errors: [],
    costUsd: 0.01,
    ...overrides,
  };
}

describe('generateUsageReport', () => {
  it('returns empty message for no metrics', () => {
    const report = generateUsageReport([]);
    expect(report).toContain('No agent activity recorded');
  });

  it('includes summary table', () => {
    const report = generateUsageReport([makeRun()]);
    expect(report).toContain('# SideCar Token Usage & Cost Dashboard');
    expect(report).toContain('## Summary');
    expect(report).toContain('claude-sonnet-4-6');
    expect(report).toContain('Total agent runs');
    expect(report).toContain('1');
  });

  it('includes recent runs table with cost column', () => {
    const report = generateUsageReport([makeRun(), makeRun()]);
    expect(report).toContain('## Recent Runs');
    expect(report).toContain('Cost');
    expect(report).toContain('$0.01');
  });

  it('shows dash for null cost (local models)', () => {
    const report = generateUsageReport([makeRun({ costUsd: null })]);
    expect(report).toContain('—');
  });

  it('includes tool usage breakdown', () => {
    const report = generateUsageReport([makeRun()]);
    expect(report).toContain('## Tool Usage Breakdown');
    expect(report).toContain('read_file');
  });

  it('includes budget status when collector provided', () => {
    const mockCollector = {
      getDailySpend: () => 2.5,
      getWeeklySpend: () => 10.0,
      getHistory: () => [],
    };
    const report = generateUsageReport([makeRun()], mockCollector as never);
    expect(report).toContain('## Budget Status');
    expect(report).toContain('Daily');
    expect(report).toContain('Weekly');
    expect(report).toContain('$5.00');
    expect(report).toContain('$20.00');
  });

  it('omits budget section when no collector', () => {
    const report = generateUsageReport([makeRun()]);
    expect(report).not.toContain('Budget Status');
  });

  it('aggregates tool calls across runs', () => {
    const runs = [
      makeRun({
        toolCalls: [
          { name: 'read_file', durationMs: 50, isError: false },
          { name: 'write_file', durationMs: 100, isError: false },
        ],
      }),
      makeRun({ toolCalls: [{ name: 'read_file', durationMs: 30, isError: true }] }),
    ];
    const report = generateUsageReport(runs);
    expect(report).toContain('read_file');
    expect(report).toContain('write_file');
  });

  it('limits recent runs to 10', () => {
    const runs = Array.from({ length: 15 }, () => makeRun());
    const report = generateUsageReport(runs);
    // Count rows in the recent runs table (header + separator + 10 data rows)
    const tableRows = report
      .split('## Recent Runs')[1]
      .split('## Tool')[0]
      .split('\n')
      .filter((l) => l.startsWith('|'));
    expect(tableRows.length).toBeLessThanOrEqual(12); // header + separator + 10
  });
});
