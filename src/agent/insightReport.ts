import type { AgentRunMetrics } from './metrics.js';

export function generateInsightReport(metrics: AgentRunMetrics[]): string {
  if (metrics.length === 0) {
    return '# SideCar Insight Report\n\nNo agent activity recorded yet.';
  }

  const totalRuns = metrics.length;
  const totalToolCalls = metrics.reduce((s, m) => s + m.toolCalls.length, 0);
  const totalTokens = metrics.reduce((s, m) => s + m.totalTokensEstimate, 0);
  const totalTimeMs = metrics.reduce((s, m) => s + m.durationMs, 0);
  const totalErrors = metrics.reduce((s, m) => s + m.errors.length, 0);
  const avgIterations = (metrics.reduce((s, m) => s + m.iterations, 0) / totalRuns).toFixed(1);
  const avgDuration = (totalTimeMs / totalRuns / 1000).toFixed(1);

  // Tool usage breakdown
  const toolCounts = new Map<string, { count: number; errors: number; totalMs: number }>();
  for (const run of metrics) {
    for (const tc of run.toolCalls) {
      const entry = toolCounts.get(tc.name) || { count: 0, errors: 0, totalMs: 0 };
      entry.count++;
      if (tc.isError) entry.errors++;
      entry.totalMs += tc.durationMs;
      toolCounts.set(tc.name, entry);
    }
  }

  const sortedTools = [...toolCounts.entries()].sort((a, b) => b[1].count - a[1].count);

  let report = `# SideCar Insight Report\n\n`;
  report += `## Summary\n\n`;
  report += `| Metric | Value |\n|--------|-------|\n`;
  report += `| Total agent runs | ${totalRuns} |\n`;
  report += `| Total tool calls | ${totalToolCalls} |\n`;
  report += `| Estimated tokens | ${totalTokens.toLocaleString()} |\n`;
  report += `| Total time | ${(totalTimeMs / 1000).toFixed(0)}s |\n`;
  report += `| Avg iterations/run | ${avgIterations} |\n`;
  report += `| Avg duration/run | ${avgDuration}s |\n`;
  report += `| Total errors | ${totalErrors} |\n`;
  report += `| Error rate | ${totalToolCalls > 0 ? ((totalErrors / totalToolCalls) * 100).toFixed(1) : 0}% |\n\n`;

  report += `## Tool Usage\n\n`;
  report += `| Tool | Calls | Errors | Avg Time |\n|------|-------|--------|----------|\n`;
  for (const [name, stats] of sortedTools) {
    const avgMs = (stats.totalMs / stats.count).toFixed(0);
    report += `| ${name} | ${stats.count} | ${stats.errors} | ${avgMs}ms |\n`;
  }

  // Bar chart
  if (sortedTools.length > 0) {
    const maxCount = sortedTools[0][1].count;
    report += `\n## Usage Chart\n\n\`\`\`\n`;
    for (const [name, stats] of sortedTools) {
      const barLen = Math.ceil((stats.count / maxCount) * 30);
      const bar = '█'.repeat(barLen);
      report += `${name.padEnd(20)} ${bar} ${stats.count}\n`;
    }
    report += `\`\`\`\n`;
  }

  // Suggestions
  report += `\n## Suggestions\n\n`;
  const highErrorTools = sortedTools.filter(([, s]) => s.errors > s.count * 0.3);
  if (highErrorTools.length > 0) {
    for (const [name, stats] of highErrorTools) {
      report += `- **${name}** has a ${((stats.errors / stats.count) * 100).toFixed(0)}% error rate — investigate common failure patterns\n`;
    }
  }

  const frequentApprovalTools = sortedTools.filter(([name]) =>
    ['write_file', 'edit_file', 'run_command'].includes(name) && toolCounts.get(name)!.count > 10
  );
  if (frequentApprovalTools.length > 0) {
    report += `- Consider setting \`"allow"\` permission for frequently-approved tools to reduce prompts\n`;
  }

  if (totalErrors === 0 && totalRuns > 5) {
    report += `- No errors recorded — your agent runs are clean!\n`;
  }

  return report;
}
