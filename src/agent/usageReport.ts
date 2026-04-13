import type { AgentRunMetrics } from './metrics.js';
import type { MetricsCollector } from './metrics.js';
import { estimateCost, getConfig } from '../config/settings.js';
import { INPUT_TOKEN_RATIO } from '../config/constants.js';

export function generateUsageReport(metrics: AgentRunMetrics[], collector?: MetricsCollector): string {
  if (metrics.length === 0) {
    return '# SideCar Token Usage\n\nNo agent activity recorded yet.';
  }

  const config = getConfig();
  const model = config.model;
  const totalRuns = metrics.length;
  const totalTokens = metrics.reduce((s, m) => s + m.totalTokensEstimate, 0);
  const totalTimeMs = metrics.reduce((s, m) => s + m.durationMs, 0);
  const totalToolCalls = metrics.reduce((s, m) => s + m.toolCalls.length, 0);

  // Use per-run cost data when available, fall back to aggregate estimation
  const totalCostFromRuns = metrics.reduce((s, m) => s + (m.costUsd ?? 0), 0);
  const inputTokens = Math.round(totalTokens * INPUT_TOKEN_RATIO);
  const outputTokens = totalTokens - inputTokens;
  const estimatedCost = estimateCost(model, inputTokens, outputTokens);
  const cost = totalCostFromRuns > 0 ? totalCostFromRuns : estimatedCost;

  // Per-run breakdown
  const recentRuns = metrics.slice(-10).reverse();

  const lines = [
    '# SideCar Token Usage & Cost Dashboard',
    '',
    '## Summary',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Model | ${model} |`,
    `| Total agent runs | ${totalRuns} |`,
    `| Total estimated tokens | ${totalTokens.toLocaleString()} |`,
    `| Est. input tokens | ${inputTokens.toLocaleString()} |`,
    `| Est. output tokens | ${outputTokens.toLocaleString()} |`,
    `| Total tool calls | ${totalToolCalls} |`,
    `| Total time | ${(totalTimeMs / 1000).toFixed(1)}s |`,
  ];

  if (cost !== null) {
    lines.push(`| Estimated cost | $${cost.toFixed(4)} |`);
  } else {
    lines.push(`| Estimated cost | N/A (local model) |`);
  }

  // Budget status section
  if (collector && (config.dailyBudget > 0 || config.weeklyBudget > 0)) {
    lines.push('', '## Budget Status', '');
    lines.push('| Budget | Spent | Limit | Remaining |');
    lines.push('|--------|-------|-------|-----------|');
    if (config.dailyBudget > 0) {
      const daily = collector.getDailySpend();
      const remaining = Math.max(0, config.dailyBudget - daily);
      const pct = Math.round((daily / config.dailyBudget) * 100);
      lines.push(
        `| Daily | $${daily.toFixed(4)} | $${config.dailyBudget.toFixed(2)} | $${remaining.toFixed(4)} (${pct}% used) |`,
      );
    }
    if (config.weeklyBudget > 0) {
      const weekly = collector.getWeeklySpend();
      const remaining = Math.max(0, config.weeklyBudget - weekly);
      const pct = Math.round((weekly / config.weeklyBudget) * 100);
      lines.push(
        `| Weekly | $${weekly.toFixed(4)} | $${config.weeklyBudget.toFixed(2)} | $${remaining.toFixed(4)} (${pct}% used) |`,
      );
    }
  }

  lines.push('', '## Recent Runs (last 10)', '');
  lines.push('| # | Tokens | Cost | Tools | Duration | Errors |');
  lines.push('|---|--------|------|-------|----------|--------|');

  for (let i = 0; i < recentRuns.length; i++) {
    const m = recentRuns[i];
    const dur = (m.durationMs / 1000).toFixed(1);
    const date = new Date(m.timestamp).toLocaleTimeString();
    const runCost = m.costUsd !== null && m.costUsd !== undefined ? `$${m.costUsd.toFixed(4)}` : '—';
    lines.push(
      `| ${date} | ${m.totalTokensEstimate.toLocaleString()} | ${runCost} | ${m.toolCalls.length} | ${dur}s | ${m.errors.length} |`,
    );
  }

  // Tool usage breakdown
  const toolCounts = new Map<string, { calls: number; errors: number; totalMs: number }>();
  for (const m of metrics) {
    for (const tc of m.toolCalls) {
      const entry = toolCounts.get(tc.name) || { calls: 0, errors: 0, totalMs: 0 };
      entry.calls++;
      if (tc.isError) entry.errors++;
      entry.totalMs += tc.durationMs;
      toolCounts.set(tc.name, entry);
    }
  }

  if (toolCounts.size > 0) {
    lines.push('', '## Tool Usage Breakdown', '');
    lines.push('| Tool | Calls | Errors | Avg Duration |');
    lines.push('|------|-------|--------|--------------|');
    const sorted = [...toolCounts.entries()].sort((a, b) => b[1].calls - a[1].calls);
    for (const [name, stats] of sorted) {
      const avgMs = (stats.totalMs / stats.calls).toFixed(0);
      lines.push(`| ${name} | ${stats.calls} | ${stats.errors} | ${avgMs}ms |`);
    }
  }

  return lines.join('\n');
}
