import { describe, it, expect } from 'vitest';
import { analyzeConversation, formatAnalyticsReport } from './conversationAnalytics.js';
import type { AuditEntry } from './auditLog.js';
import type { AgentRunMetrics } from './metrics.js';
import type { MemoryEntry } from './agentMemory.js';

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: '2026-04-10T10:00:00.000Z',
    sessionId: 's-1',
    tool: 'read_file',
    toolCallId: 'tc_1',
    input: { path: 'foo.ts' },
    result: 'ok',
    isError: false,
    durationMs: 50,
    iteration: 1,
    approvalMode: 'cautious',
    model: 'test-model',
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<AgentRunMetrics> = {}): AgentRunMetrics {
  return {
    timestamp: Date.now(),
    iterations: 3,
    toolCalls: [],
    totalTokensEstimate: 1000,
    durationMs: 5000,
    errors: [],
    costUsd: null,
    ...overrides,
  };
}

describe('analyzeConversation', () => {
  it('handles empty entries', () => {
    const result = analyzeConversation([], []);
    expect(result.totalEntries).toBe(0);
    expect(result.sessionCount).toBe(0);
    expect(result.toolStats.size).toBe(0);
  });

  it('counts total entries and sessions', () => {
    const entries = [
      makeEntry({ sessionId: 's-1', toolCallId: 'tc_1' }),
      makeEntry({ sessionId: 's-1', toolCallId: 'tc_2' }),
      makeEntry({ sessionId: 's-2', toolCallId: 'tc_3' }),
    ];
    const result = analyzeConversation(entries, []);
    expect(result.totalEntries).toBe(3);
    expect(result.sessionCount).toBe(2);
  });

  it('computes per-tool stats', () => {
    const entries = [
      makeEntry({ tool: 'read_file', durationMs: 100 }),
      makeEntry({ tool: 'read_file', durationMs: 200, isError: true, toolCallId: 'tc_2' }),
      makeEntry({ tool: 'grep', durationMs: 50, toolCallId: 'tc_3' }),
    ];
    const result = analyzeConversation(entries, []);
    const readStats = result.toolStats.get('read_file')!;
    expect(readStats.calls).toBe(2);
    expect(readStats.errors).toBe(1);
    expect(readStats.avgDurationMs).toBe(150);

    const grepStats = result.toolStats.get('grep')!;
    expect(grepStats.calls).toBe(1);
    expect(grepStats.errors).toBe(0);
  });

  it('identifies top 2-tool sequences', () => {
    const entries = [
      makeEntry({ tool: 'read_file', toolCallId: 'tc_1' }),
      makeEntry({ tool: 'edit_file', toolCallId: 'tc_2' }),
      makeEntry({ tool: 'read_file', toolCallId: 'tc_3' }),
      makeEntry({ tool: 'edit_file', toolCallId: 'tc_4' }),
    ];
    const result = analyzeConversation(entries, []);
    expect(result.topSequences.length).toBeGreaterThan(0);
    const rfToEf = result.topSequences.find((s) => s.sequence[0] === 'read_file' && s.sequence[1] === 'edit_file');
    expect(rfToEf).toBeDefined();
    expect(rfToEf!.count).toBe(2);
  });

  it('identifies tool co-occurrences', () => {
    const entries = [
      makeEntry({ tool: 'read_file', toolCallId: 'tc_1' }),
      makeEntry({ tool: 'grep', toolCallId: 'tc_2' }),
    ];
    const result = analyzeConversation(entries, []);
    expect(result.cooccurrences.length).toBe(1);
    expect(result.cooccurrences[0].count).toBe(1);
  });

  it('computes hourly distribution', () => {
    // Use local hours to avoid timezone issues
    const hour1 = new Date(2026, 3, 10, 10, 0, 0).toISOString();
    const hour1b = new Date(2026, 3, 10, 10, 30, 0).toISOString();
    const hour2 = new Date(2026, 3, 10, 14, 0, 0).toISOString();
    const entries = [
      makeEntry({ timestamp: hour1, toolCallId: 'tc_1' }),
      makeEntry({ timestamp: hour1b, toolCallId: 'tc_2' }),
      makeEntry({ timestamp: hour2, toolCallId: 'tc_3' }),
    ];
    const result = analyzeConversation(entries, []);
    expect(result.hourlyDistribution[10]).toBe(2);
    expect(result.hourlyDistribution[14]).toBe(1);
  });

  it('identifies error clusters', () => {
    const entries = [
      makeEntry({ tool: 'read_file', isError: true, toolCallId: 'tc_1' }),
      makeEntry({ tool: 'grep', isError: true, toolCallId: 'tc_2' }),
    ];
    const result = analyzeConversation(entries, []);
    expect(result.errorClusters.length).toBe(1);
    expect(result.errorClusters[0]).toContain('read_file');
    expect(result.errorClusters[0]).toContain('grep');
  });

  it('computes average tools per session', () => {
    const entries = [
      makeEntry({ sessionId: 's-1', toolCallId: 'tc_1' }),
      makeEntry({ sessionId: 's-1', toolCallId: 'tc_2' }),
      makeEntry({ sessionId: 's-1', toolCallId: 'tc_3' }),
      makeEntry({ sessionId: 's-2', toolCallId: 'tc_4' }),
    ];
    const result = analyzeConversation(entries, []);
    expect(result.avgToolsPerSession).toBe(2); // (3+1)/2 = 2
  });

  it('includes learned patterns from memory', () => {
    const memories: MemoryEntry[] = [
      {
        id: 'm1',
        type: 'insight',
        category: 'testing',
        content: 'Always run tests after edits',
        timestamp: Date.now(),
        useCount: 5,
      },
    ];
    const result = analyzeConversation([makeEntry()], [], memories);
    expect(result.learnedPatterns).toContain('Always run tests after edits');
  });
});

describe('formatAnalyticsReport', () => {
  it('handles empty analytics', () => {
    const analytics = analyzeConversation([], []);
    const report = formatAnalyticsReport(analytics, []);
    expect(report).toContain('No audit data recorded yet');
  });

  it('generates full report with sections', () => {
    const entries = [
      makeEntry({ tool: 'read_file', toolCallId: 'tc_1' }),
      makeEntry({ tool: 'edit_file', toolCallId: 'tc_2' }),
      makeEntry({ tool: 'read_file', toolCallId: 'tc_3', isError: true }),
    ];
    const metrics = [makeMetrics()];
    const analytics = analyzeConversation(entries, metrics);
    const report = formatAnalyticsReport(analytics, metrics);

    expect(report).toContain('# SideCar Conversation Insights');
    expect(report).toContain('## Overview');
    expect(report).toContain('## Tool Performance');
    expect(report).toContain('## Usage Distribution');
    expect(report).toContain('read_file');
    expect(report).toContain('edit_file');
  });

  it('includes suggestions for high error rate tools', () => {
    const entries = [
      makeEntry({ tool: 'bad_tool', isError: true, toolCallId: 'tc_1' }),
      makeEntry({ tool: 'bad_tool', isError: true, toolCallId: 'tc_2' }),
      makeEntry({ tool: 'bad_tool', isError: true, toolCallId: 'tc_3' }),
      makeEntry({ tool: 'bad_tool', isError: false, toolCallId: 'tc_4' }),
    ];
    const analytics = analyzeConversation(entries, []);
    const report = formatAnalyticsReport(analytics, []);
    expect(report).toContain('## Suggestions');
    expect(report).toContain('bad_tool');
    expect(report).toContain('error rate');
  });

  it('flags repetitive tool sequences', () => {
    const entries: AuditEntry[] = [];
    for (let i = 0; i < 8; i++) {
      entries.push(makeEntry({ tool: 'read_file', toolCallId: `tc_${i}` }));
    }
    const analytics = analyzeConversation(entries, []);
    const report = formatAnalyticsReport(analytics, []);
    expect(report).toContain('read_file');
    expect(report).toContain('back-to-back');
  });

  it('includes activity chart', () => {
    const entries = [makeEntry()];
    const analytics = analyzeConversation(entries, []);
    const report = formatAnalyticsReport(analytics, []);
    expect(report).toContain('Activity by Hour');
  });
});
