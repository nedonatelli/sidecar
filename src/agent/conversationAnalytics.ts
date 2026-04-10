import type { AuditEntry } from './auditLog.js';
import type { AgentRunMetrics } from './metrics.js';
import type { MemoryEntry } from './agentMemory.js';

export interface ToolSequence {
  /** Ordered tool names */
  sequence: string[];
  /** How many times this sequence appeared */
  count: number;
}

export interface ToolCooccurrence {
  toolA: string;
  toolB: string;
  count: number;
}

export interface ConversationAnalytics {
  /** Total audit entries analyzed */
  totalEntries: number;
  /** Unique sessions */
  sessionCount: number;
  /** Date range */
  firstEntry: string;
  lastEntry: string;
  /** Per-tool stats */
  toolStats: Map<string, { calls: number; errors: number; avgDurationMs: number; totalDurationMs: number }>;
  /** Most common 2-tool sequences */
  topSequences: ToolSequence[];
  /** Tool co-occurrence within sessions */
  cooccurrences: ToolCooccurrence[];
  /** Hourly distribution (0-23) */
  hourlyDistribution: number[];
  /** Error clusters: tools that tend to fail together */
  errorClusters: string[][];
  /** Average tools per session */
  avgToolsPerSession: number;
  /** Average session duration (ms) */
  avgSessionDurationMs: number;
  /** Learned patterns from memory */
  learnedPatterns: string[];
}

/**
 * Analyze audit log entries and agent memory to produce conversation insights.
 */
export function analyzeConversation(
  entries: AuditEntry[],
  metrics: AgentRunMetrics[],
  memories?: MemoryEntry[],
): ConversationAnalytics {
  if (entries.length === 0) {
    return {
      totalEntries: 0,
      sessionCount: 0,
      firstEntry: '',
      lastEntry: '',
      toolStats: new Map(),
      topSequences: [],
      cooccurrences: [],
      hourlyDistribution: new Array(24).fill(0),
      errorClusters: [],
      avgToolsPerSession: 0,
      avgSessionDurationMs: 0,
      learnedPatterns: [],
    };
  }

  // Per-tool stats
  const toolStats = new Map<string, { calls: number; errors: number; totalDurationMs: number }>();
  for (const entry of entries) {
    const stat = toolStats.get(entry.tool) || { calls: 0, errors: 0, totalDurationMs: 0 };
    stat.calls++;
    if (entry.isError) stat.errors++;
    stat.totalDurationMs += entry.durationMs;
    toolStats.set(entry.tool, stat);
  }

  const toolStatsWithAvg = new Map<
    string,
    { calls: number; errors: number; avgDurationMs: number; totalDurationMs: number }
  >();
  for (const [name, stat] of toolStats) {
    toolStatsWithAvg.set(name, {
      ...stat,
      avgDurationMs: Math.round(stat.totalDurationMs / stat.calls),
    });
  }

  // Sessions
  const sessions = new Map<string, AuditEntry[]>();
  for (const entry of entries) {
    const list = sessions.get(entry.sessionId) || [];
    list.push(entry);
    sessions.set(entry.sessionId, list);
  }

  // 2-tool sequences
  const sequenceCounts = new Map<string, number>();
  for (const sessionEntries of sessions.values()) {
    for (let i = 0; i < sessionEntries.length - 1; i++) {
      const key = `${sessionEntries[i].tool} -> ${sessionEntries[i + 1].tool}`;
      sequenceCounts.set(key, (sequenceCounts.get(key) || 0) + 1);
    }
  }
  const topSequences = [...sequenceCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, count]) => ({
      sequence: key.split(' -> '),
      count,
    }));

  // Co-occurrence: which tools appear in the same session
  const cooccurrenceCounts = new Map<string, number>();
  for (const sessionEntries of sessions.values()) {
    const uniqueTools = [...new Set(sessionEntries.map((e) => e.tool))].sort();
    for (let i = 0; i < uniqueTools.length; i++) {
      for (let j = i + 1; j < uniqueTools.length; j++) {
        const key = `${uniqueTools[i]}|${uniqueTools[j]}`;
        cooccurrenceCounts.set(key, (cooccurrenceCounts.get(key) || 0) + 1);
      }
    }
  }
  const cooccurrences = [...cooccurrenceCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, count]) => {
      const [toolA, toolB] = key.split('|');
      return { toolA, toolB, count };
    });

  // Hourly distribution
  const hourlyDistribution = new Array(24).fill(0);
  for (const entry of entries) {
    const hour = new Date(entry.timestamp).getHours();
    hourlyDistribution[hour]++;
  }

  // Error clusters: sessions where 2+ tools failed
  const errorClusters: string[][] = [];
  for (const sessionEntries of sessions.values()) {
    const failedTools = [...new Set(sessionEntries.filter((e) => e.isError).map((e) => e.tool))];
    if (failedTools.length >= 2) {
      errorClusters.push(failedTools);
    }
  }

  // Session stats
  const sessionToolCounts = [...sessions.values()].map((s) => s.length);
  const avgToolsPerSession =
    sessionToolCounts.length > 0
      ? Math.round(sessionToolCounts.reduce((a, b) => a + b, 0) / sessionToolCounts.length)
      : 0;

  const sessionDurations = [...sessions.values()].map((s) => {
    if (s.length < 2) return 0;
    return new Date(s[s.length - 1].timestamp).getTime() - new Date(s[0].timestamp).getTime();
  });
  const avgSessionDurationMs =
    sessionDurations.length > 0 ? Math.round(sessionDurations.reduce((a, b) => a + b, 0) / sessionDurations.length) : 0;

  // Learned patterns from memory
  const learnedPatterns = (memories || [])
    .filter((m) => m.type === 'insight' || m.type === 'convention' || m.type === 'decision')
    .sort((a, b) => b.useCount - a.useCount)
    .slice(0, 10)
    .map((m) => m.content);

  return {
    totalEntries: entries.length,
    sessionCount: sessions.size,
    firstEntry: entries[0].timestamp,
    lastEntry: entries[entries.length - 1].timestamp,
    toolStats: toolStatsWithAvg,
    topSequences,
    cooccurrences,
    hourlyDistribution,
    errorClusters,
    avgToolsPerSession,
    avgSessionDurationMs,
    learnedPatterns,
  };
}

/**
 * Format analytics as a markdown report.
 */
export function formatAnalyticsReport(analytics: ConversationAnalytics, metrics: AgentRunMetrics[]): string {
  if (analytics.totalEntries === 0) {
    return '# SideCar Conversation Insights\n\nNo audit data recorded yet. Run some agent tasks first.';
  }

  const lines: string[] = ['# SideCar Conversation Insights', ''];

  // Overview
  lines.push('## Overview', '');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total tool executions | ${analytics.totalEntries} |`);
  lines.push(`| Sessions analyzed | ${analytics.sessionCount} |`);
  lines.push(`| Avg tools/session | ${analytics.avgToolsPerSession} |`);
  lines.push(
    `| Avg session duration | ${analytics.avgSessionDurationMs > 0 ? (analytics.avgSessionDurationMs / 1000).toFixed(0) + 's' : 'N/A'} |`,
  );
  lines.push(`| Date range | ${analytics.firstEntry.split('T')[0]} to ${analytics.lastEntry.split('T')[0]} |`);
  lines.push('');

  // Tool performance
  const sortedTools = [...analytics.toolStats.entries()].sort((a, b) => b[1].calls - a[1].calls);
  lines.push('## Tool Performance', '');
  lines.push('| Tool | Calls | Errors | Error Rate | Avg Duration |');
  lines.push('|------|-------|--------|------------|--------------|');
  for (const [name, stats] of sortedTools) {
    const errorRate = stats.calls > 0 ? ((stats.errors / stats.calls) * 100).toFixed(1) : '0.0';
    lines.push(`| ${name} | ${stats.calls} | ${stats.errors} | ${errorRate}% | ${stats.avgDurationMs}ms |`);
  }
  lines.push('');

  // Tool usage chart
  if (sortedTools.length > 0) {
    const maxCount = sortedTools[0][1].calls;
    lines.push('## Usage Distribution', '', '```');
    for (const [name, stats] of sortedTools.slice(0, 15)) {
      const barLen = Math.max(1, Math.ceil((stats.calls / maxCount) * 30));
      lines.push(`${name.padEnd(20)} ${'█'.repeat(barLen)} ${stats.calls}`);
    }
    lines.push('```', '');
  }

  // Top sequences
  if (analytics.topSequences.length > 0) {
    lines.push('## Common Tool Sequences', '');
    lines.push('These tool pairs frequently appear in succession:', '');
    lines.push('| Sequence | Count |');
    lines.push('|----------|-------|');
    for (const seq of analytics.topSequences) {
      lines.push(`| ${seq.sequence.join(' → ')} | ${seq.count} |`);
    }
    lines.push('');
  }

  // Co-occurrences
  if (analytics.cooccurrences.length > 0) {
    lines.push('## Tool Co-occurrence', '');
    lines.push('Tools that frequently appear in the same session:', '');
    lines.push('| Tool A | Tool B | Sessions |');
    lines.push('|--------|--------|----------|');
    for (const co of analytics.cooccurrences) {
      lines.push(`| ${co.toolA} | ${co.toolB} | ${co.count} |`);
    }
    lines.push('');
  }

  // Activity heatmap
  const peakHour = analytics.hourlyDistribution.indexOf(Math.max(...analytics.hourlyDistribution));
  const totalActivity = analytics.hourlyDistribution.reduce((a, b) => a + b, 0);
  if (totalActivity > 0) {
    lines.push('## Activity by Hour', '', '```');
    const maxHourly = Math.max(...analytics.hourlyDistribution);
    for (let h = 0; h < 24; h++) {
      const count = analytics.hourlyDistribution[h];
      if (count === 0) continue;
      const barLen = Math.max(1, Math.ceil((count / maxHourly) * 25));
      const label = `${String(h).padStart(2, '0')}:00`;
      lines.push(`${label}  ${'█'.repeat(barLen)} ${count}`);
    }
    lines.push('```', '');
    lines.push(`Peak activity: ${String(peakHour).padStart(2, '0')}:00`, '');
  }

  // Error clusters
  if (analytics.errorClusters.length > 0) {
    lines.push('## Error Clusters', '');
    lines.push('Sessions where multiple tools failed together:', '');
    for (const cluster of analytics.errorClusters.slice(0, 5)) {
      lines.push(`- ${cluster.join(', ')}`);
    }
    lines.push('');
  }

  // Suggestions
  lines.push('## Suggestions', '');

  // High error rate tools
  for (const [name, stats] of sortedTools) {
    if (stats.calls >= 3 && stats.errors / stats.calls > 0.3) {
      lines.push(
        `- **${name}** has a ${((stats.errors / stats.calls) * 100).toFixed(0)}% error rate (${stats.errors}/${stats.calls}) — review common failure modes`,
      );
    }
  }

  // Slow tools
  for (const [name, stats] of sortedTools) {
    if (stats.avgDurationMs > 5000 && stats.calls >= 3) {
      lines.push(
        `- **${name}** averages ${(stats.avgDurationMs / 1000).toFixed(1)}s — consider if inputs can be narrowed`,
      );
    }
  }

  // Repetitive sequences
  const repetitiveSeqs = analytics.topSequences.filter((s) => s.sequence[0] === s.sequence[1] && s.count >= 3);
  if (repetitiveSeqs.length > 0) {
    for (const seq of repetitiveSeqs) {
      lines.push(
        `- **${seq.sequence[0]}** is called repeatedly (${seq.count}x back-to-back) — may indicate retry loops`,
      );
    }
  }

  // Metrics-based suggestions
  if (metrics.length > 0) {
    const avgIterations = metrics.reduce((s, m) => s + m.iterations, 0) / metrics.length;
    if (avgIterations > 15) {
      lines.push(
        `- Average iterations per run is ${avgIterations.toFixed(1)} — consider breaking complex tasks into smaller prompts`,
      );
    }
  }

  // Learned patterns
  if (analytics.learnedPatterns.length > 0) {
    lines.push('', '## Learned Patterns', '');
    lines.push('Top patterns from agent memory:', '');
    for (const pattern of analytics.learnedPatterns) {
      lines.push(`- ${pattern}`);
    }
  }

  return lines.join('\n');
}
