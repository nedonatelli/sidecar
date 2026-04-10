import { describe, it, expect } from 'vitest';
import { generateInsightReport } from './insightReport.js';
import type { AgentRunMetrics } from './metrics.js';

describe('generateInsightReport', () => {
  it('handles empty metrics array', () => {
    const report = generateInsightReport([]);
    expect(report).toContain('# SideCar Insight Report');
    expect(report).toContain('No agent activity recorded yet');
  });

  it('generates report header for non-empty metrics', () => {
    const metrics: AgentRunMetrics[] = [
      {
        iterations: 1,
        toolCalls: [],
        totalTokensEstimate: 100,
        durationMs: 1000,
        errors: [],
        timestamp: Date.now(),
        costUsd: null,
      },
    ];
    const report = generateInsightReport(metrics);
    expect(report).toContain('# SideCar Insight Report');
    expect(report).toContain('## Summary');
  });

  it('calculates total runs correctly', () => {
    const metrics: AgentRunMetrics[] = [
      {
        iterations: 2,
        toolCalls: [],
        totalTokensEstimate: 100,
        durationMs: 1000,
        errors: [],
        timestamp: Date.now(),
        costUsd: null,
      },
      {
        iterations: 3,
        toolCalls: [],
        totalTokensEstimate: 150,
        durationMs: 1500,
        errors: [],
        timestamp: Date.now(),
        costUsd: null,
      },
    ];
    const report = generateInsightReport(metrics);
    expect(report).toContain('| Total agent runs | 2');
  });

  it('calculates average iterations correctly', () => {
    const metrics: AgentRunMetrics[] = [
      {
        iterations: 5,
        toolCalls: [],
        totalTokensEstimate: 100,
        durationMs: 5000,
        errors: [],
        timestamp: Date.now(),
        costUsd: null,
      },
      {
        iterations: 3,
        toolCalls: [],
        totalTokensEstimate: 100,
        durationMs: 3000,
        errors: [],
        timestamp: Date.now(),
        costUsd: null,
      },
    ];
    const report = generateInsightReport(metrics);
    expect(report).toContain('Avg iterations/run | 4.0');
  });

  it('includes tool usage breakdown', () => {
    const metrics: AgentRunMetrics[] = [
      {
        iterations: 1,
        toolCalls: [
          { name: 'read_file', durationMs: 100, isError: false },
          { name: 'write_file', durationMs: 200, isError: false },
        ],
        totalTokensEstimate: 100,
        durationMs: 1000,
        errors: [],
        timestamp: Date.now(),
        costUsd: null,
      },
    ];
    const report = generateInsightReport(metrics);
    expect(report).toContain('## Tool Usage');
    expect(report).toContain('read_file');
    expect(report).toContain('write_file');
  });

  it('tracks tool call counts', () => {
    const metrics: AgentRunMetrics[] = [
      {
        iterations: 1,
        toolCalls: [
          { name: 'read_file', durationMs: 100, isError: false },
          { name: 'read_file', durationMs: 100, isError: false },
          { name: 'write_file', durationMs: 200, isError: false },
        ],
        totalTokensEstimate: 100,
        durationMs: 1000,
        errors: [],
        timestamp: Date.now(),
        costUsd: null,
      },
    ];
    const report = generateInsightReport(metrics);
    expect(report).toContain('| Total tool calls | 3');
  });

  it('counts tool errors correctly', () => {
    const metrics: AgentRunMetrics[] = [
      {
        iterations: 1,
        toolCalls: [
          { name: 'read_file', durationMs: 100, isError: false },
          { name: 'read_file', durationMs: 100, isError: true },
          { name: 'write_file', durationMs: 200, isError: true },
        ],
        totalTokensEstimate: 100,
        durationMs: 1000,
        errors: ['error 1', 'error 2'],
        timestamp: Date.now(),
        costUsd: null,
      },
    ];
    const report = generateInsightReport(metrics);
    expect(report).toContain('| Total errors | 2');
  });

  it('calculates error rate correctly', () => {
    const metrics: AgentRunMetrics[] = [
      {
        iterations: 1,
        toolCalls: [
          { name: 'read_file', durationMs: 100, isError: false },
          { name: 'read_file', durationMs: 100, isError: true },
        ],
        totalTokensEstimate: 100,
        durationMs: 1000,
        errors: ['test error'],
        timestamp: Date.now(),
        costUsd: null,
      },
    ];
    const report = generateInsightReport(metrics);
    // 1 error out of 2 tool calls = 50%
    expect(report).toContain('Error rate | 50.0%');
  });

  it('includes tokens estimate in report', () => {
    const metrics: AgentRunMetrics[] = [
      {
        iterations: 1,
        toolCalls: [],
        totalTokensEstimate: 5000,
        durationMs: 1000,
        errors: [],
        timestamp: Date.now(),
        costUsd: null,
      },
    ];
    const report = generateInsightReport(metrics);
    expect(report).toContain('Estimated tokens | 5,000');
  });

  it('includes duration in report', () => {
    const metrics: AgentRunMetrics[] = [
      {
        iterations: 1,
        toolCalls: [],
        totalTokensEstimate: 100,
        durationMs: 2000,
        errors: [],
        timestamp: Date.now(),
        costUsd: null,
      },
    ];
    const report = generateInsightReport(metrics);
    expect(report).toContain('Avg duration/run | 2.0s');
  });

  it('generates usage chart for tools', () => {
    const metrics: AgentRunMetrics[] = [
      {
        iterations: 1,
        toolCalls: [
          { name: 'read_file', durationMs: 100, isError: false },
          { name: 'read_file', durationMs: 100, isError: false },
          { name: 'read_file', durationMs: 100, isError: false },
          { name: 'write_file', durationMs: 200, isError: false },
        ],
        totalTokensEstimate: 100,
        durationMs: 1000,
        errors: [],
        timestamp: Date.now(),
        costUsd: null,
      },
    ];
    const report = generateInsightReport(metrics);
    expect(report).toContain('## Usage Chart');
    expect(report).toMatch(/█+/);
  });

  it('identifies high error rate tools', () => {
    const metrics: AgentRunMetrics[] = [
      {
        iterations: 1,
        toolCalls: [
          { name: 'problematic_tool', durationMs: 100, isError: true },
          { name: 'problematic_tool', durationMs: 100, isError: true },
          { name: 'problematic_tool', durationMs: 100, isError: true },
          { name: 'problematic_tool', durationMs: 100, isError: false },
        ],
        totalTokensEstimate: 100,
        durationMs: 1000,
        errors: ['e1', 'e2', 'e3'],
        timestamp: Date.now(),
        costUsd: null,
      },
    ];
    const report = generateInsightReport(metrics);
    expect(report).toContain('## Suggestions');
    expect(report).toContain('problematic_tool');
    expect(report).toContain('error rate');
  });

  it('formats report with markdown', () => {
    const metrics: AgentRunMetrics[] = [
      {
        iterations: 1,
        toolCalls: [],
        totalTokensEstimate: 100,
        durationMs: 1000,
        errors: [],
        timestamp: Date.now(),
        costUsd: null,
      },
    ];
    const report = generateInsightReport(metrics);
    expect(report).toContain('#');
    expect(report).toContain('|');
    expect(report).toContain('-');
  });

  it('handles multiple runs with varied metrics', () => {
    const metrics: AgentRunMetrics[] = [
      {
        iterations: 1,
        toolCalls: [{ name: 'tool_a', durationMs: 100, isError: false }],
        totalTokensEstimate: 100,
        durationMs: 1000,
        errors: [],
        timestamp: Date.now(),
        costUsd: null,
      },
      {
        iterations: 2,
        toolCalls: [
          { name: 'tool_b', durationMs: 200, isError: false },
          { name: 'tool_b', durationMs: 200, isError: true },
        ],
        totalTokensEstimate: 200,
        durationMs: 2000,
        errors: ['failed'],
        timestamp: Date.now(),
        costUsd: null,
      },
    ];
    const report = generateInsightReport(metrics);
    expect(report).toContain('tool_a');
    expect(report).toContain('tool_b');
    expect(report).toContain('Total agent runs | 2');
  });
});
