/**
 * Status, analytics, and utility slash-command handlers.
 *
 * These handlers display information without invoking the LLM:
 * /insight, /usage, /context, /audit, /insights, /mcp, /memory,
 * /memory-search, /lint, /deps, /verbose, /skills.
 *
 * Handlers that drive an agent loop or call the model live in agentHandlers.ts.
 */

import { window, workspace } from 'vscode';
import type { ChatState } from '../chatState.js';
import { getConfig } from '../../config/settings.js';
import { generateInsightReport } from '../../agent/insightReport.js';
import { generateUsageReport } from '../../agent/usageReport.js';
import { generateContextReport } from '../../agent/contextReport.js';
import { analyzeConversation, formatAnalyticsReport } from '../../agent/conversationAnalytics.js';
import type { AuditFilter } from '../../agent/auditLog.js';
import { getOrComputeReport } from './reportCache.js';
import { runLint } from '../../agent/lintFix.js';
import { analyzeDependencies } from '../../agent/depAnalysis.js';

export async function handleInsight(state: ChatState): Promise<void> {
  const history = state.metricsCollector.getHistory();
  const report = generateInsightReport(history);
  const doc = await workspace.openTextDocument({ content: report, language: 'markdown' });
  await window.showTextDocument(doc, { preview: true });
}

export async function handleUsage(state: ChatState): Promise<void> {
  const history = state.metricsCollector.getHistory();
  // Fingerprint: history length + timestamp of latest entry. Changes
  // whenever a new metric row is appended, which is the only mutation
  // that affects the generated report.
  const lastTs = history.length > 0 ? ((history[history.length - 1] as { timestamp?: number }).timestamp ?? 0) : 0;
  const fingerprint = `u:${history.length}:${lastTs}`;
  const { value: report } = await getOrComputeReport('usage', fingerprint, () =>
    generateUsageReport(history, state.metricsCollector),
  );
  const doc = await workspace.openTextDocument({ content: report, language: 'markdown' });
  await window.showTextDocument(doc, { preview: true });
}

export async function handleContext(state: ChatState): Promise<void> {
  const config = getConfig();
  const systemPrompt = state.client.getSystemPrompt();
  const report = generateContextReport(systemPrompt, state.messages, config.model, config.agentMaxTokens);
  const doc = await workspace.openTextDocument({ content: report, language: 'markdown' });
  await window.showTextDocument(doc, { preview: true });
}

export async function handleLint(state: ChatState, command?: string): Promise<void> {
  state.postMessage({ command: 'setLoading', isLoading: true });
  try {
    const { output, success } = await runLint(command);
    state.postMessage({
      command: 'assistantMessage',
      content: success ? `✓ Lint passed:\n\`\`\`\n${output}\n\`\`\`` : `✗ Lint issues:\n\`\`\`\n${output}\n\`\`\``,
    });
  } catch (err) {
    state.postMessage({ command: 'error', content: err instanceof Error ? err.message : String(err) });
  } finally {
    state.postMessage({ command: 'done' });
    state.postMessage({ command: 'setLoading', isLoading: false });
  }
}

export async function handleDeps(state: ChatState): Promise<void> {
  state.postMessage({ command: 'setLoading', isLoading: true });
  try {
    const report = await analyzeDependencies();
    const doc = await workspace.openTextDocument({ content: report, language: 'markdown' });
    await window.showTextDocument(doc, { preview: true });
  } catch (err) {
    state.postMessage({ command: 'error', content: err instanceof Error ? err.message : String(err) });
  } finally {
    state.postMessage({ command: 'done' });
    state.postMessage({ command: 'setLoading', isLoading: false });
  }
}

/**
 * `/audit` command — display structured audit log of agent tool executions.
 * Supports optional filters: `/audit errors`, `/audit tool:grep`, `/audit last:20`
 */
export async function handleAudit(state: ChatState, args: string): Promise<void> {
  if (!state.auditLog) {
    state.postMessage({ command: 'error', content: 'Audit log not available — .sidecar directory not initialized.' });
    state.postMessage({ command: 'done' });
    return;
  }

  // Parse filter arguments
  const filter: AuditFilter = { limit: 50 };
  const parts = args.trim().split(/\s+/).filter(Boolean);
  for (const part of parts) {
    if (part === 'errors') {
      filter.errorsOnly = true;
    } else if (part.startsWith('tool:')) {
      filter.tool = part.slice(5);
    } else if (part.startsWith('last:')) {
      const n = parseInt(part.slice(5), 10);
      if (!isNaN(n)) filter.limit = n;
    } else if (part.startsWith('since:')) {
      filter.since = part.slice(6);
    } else if (part === 'clear') {
      await state.auditLog.clear();
      state.postMessage({ command: 'assistantMessage', content: 'Audit log cleared.' });
      state.postMessage({ command: 'done' });
      return;
    }
  }

  const entries = await state.auditLog.query(filter);
  const total = await state.auditLog.count();

  if (entries.length === 0) {
    state.postMessage({
      command: 'assistantMessage',
      content: 'No audit entries found' + (args ? ` matching "${args}"` : '') + '.',
    });
    state.postMessage({ command: 'done' });
    return;
  }

  // Format as markdown table
  const lines = [
    `# Agent Audit Log`,
    '',
    `Showing ${entries.length} of ${total} entries${args ? ` (filter: ${args})` : ''}`,
    '',
    '| Time | Tool | Duration | Status | Input | Result |',
    '|------|------|----------|--------|-------|--------|',
  ];

  for (const entry of entries) {
    const time = entry.timestamp.split('T')[1]?.split('.')[0] || entry.timestamp;
    const status = entry.isError ? '✗' : '✓';
    const inputPreview = Object.entries(entry.input)
      .map(([k, v]) => {
        const val = typeof v === 'string' ? v.slice(0, 30) : String(v).slice(0, 30);
        return `${k}=${val}`;
      })
      .join(', ')
      .slice(0, 60);
    const resultPreview = entry.result.slice(0, 50).replace(/\n/g, ' ');
    lines.push(
      `| ${time} | ${entry.tool} | ${entry.durationMs}ms | ${status} | ${inputPreview || '—'} | ${resultPreview || '—'} |`,
    );
  }

  lines.push('', '---', '');
  lines.push(
    '**Filters:** `/audit errors` · `/audit tool:<name>` · `/audit last:<n>` · `/audit since:YYYY-MM-DD` · `/audit clear`',
  );

  const report = lines.join('\n');
  const doc = await workspace.openTextDocument({ content: report, language: 'markdown' });
  await window.showTextDocument(doc, { preview: true });
  state.postMessage({ command: 'done' });
}

/**
 * `/insights` command — conversation pattern analysis with usage trends and workflow suggestions.
 */
export async function handleInsights(state: ChatState): Promise<void> {
  if (!state.auditLog) {
    state.postMessage({
      command: 'error',
      content: 'Insights not available — .sidecar directory not initialized.',
    });
    state.postMessage({ command: 'done' });
    return;
  }

  // Gather data sources up-front so the fingerprint can reflect their
  // current sizes. The expensive work is in analyzeConversation() walking
  // every audit row, so the cache key below guards that call.
  const auditEntries = await state.auditLog.query({ limit: 5000 });
  const metrics = state.metricsCollector.getHistory();
  const memories = state.agentMemory?.queryAll() || [];

  if (auditEntries.length === 0 && metrics.length === 0) {
    state.postMessage({
      command: 'assistantMessage',
      content: 'No data for insights yet. Run some agent tasks first, then try `/insights` again.',
    });
    state.postMessage({ command: 'done' });
    return;
  }

  const lastAuditTs = auditEntries.length > 0 ? (auditEntries[auditEntries.length - 1].timestamp ?? '') : '';
  const fingerprint = `i:${auditEntries.length}:${metrics.length}:${memories.length}:${lastAuditTs}`;
  const { value: report } = await getOrComputeReport('insights', fingerprint, () => {
    const analytics = analyzeConversation(auditEntries, metrics, memories);
    return formatAnalyticsReport(analytics, metrics);
  });

  const doc = await workspace.openTextDocument({ content: report, language: 'markdown' });
  await window.showTextDocument(doc, { preview: true });
  state.postMessage({ command: 'done' });
}

/**
 * `/mcp` command — show MCP server status, connected tools, and transport info.
 */
export function handleMcpStatus(state: ChatState): void {
  const status = state.mcpManager.getServerStatus();
  const totalTools = state.mcpManager.getToolCount();

  if (status.length === 0) {
    state.postMessage({
      command: 'assistantMessage',
      content:
        '**MCP Servers:** None configured.\n\n' +
        'Add MCP servers in VS Code settings (`sidecar.mcpServers`) or create a `.mcp.json` file at the workspace root.\n\n' +
        '```json\n' +
        '// .mcp.json\n' +
        '{\n' +
        '  "mcpServers": {\n' +
        '    "my-server": {\n' +
        '      "type": "stdio",\n' +
        '      "command": "npx",\n' +
        '      "args": ["my-mcp-server"]\n' +
        '    }\n' +
        '  }\n' +
        '}\n' +
        '```',
    });
    state.postMessage({ command: 'done' });
    return;
  }

  const lines = ['**MCP Servers**', ''];
  const statusIcon = (s: string) => (s === 'connected' ? '✓' : s === 'connecting' ? '⏳' : s === 'failed' ? '✗' : '○');

  for (const server of status) {
    const icon = statusIcon(server.status);
    const uptime = server.connectedSinceMs !== undefined ? ` (up ${Math.round(server.connectedSinceMs / 1000)}s)` : '';
    lines.push(`${icon} **${server.name}** — ${server.status}${uptime}`);
    const schemas = server.lazyToolSchemas ? 'lazy (describe_tool on first use)' : 'full (alwaysLoad)';
    lines.push(`  Transport: ${server.transport} | Tools: ${server.toolCount} | Schemas: ${schemas}`);
    if (server.error) {
      lines.push(`  Error: ${server.error}`);
    }
  }

  lines.push('', `**Total tools:** ${totalTools}`);

  state.postMessage({ command: 'assistantMessage', content: lines.join('\n') });
  state.postMessage({ command: 'done' });
}

export function handleListMemories(state: ChatState): void {
  if (!state.agentMemory) {
    state.postMessage({
      command: 'assistantMessage',
      content: 'Agent memory is not enabled. Set `sidecar.enableAgentMemory` to true.\n\n',
    });
    return;
  }
  const memories = state.agentMemory.queryAll();
  if (memories.length === 0) {
    state.postMessage({ command: 'assistantMessage', content: 'No agent memories stored yet.\n\n' });
    return;
  }
  const byType = new Map<string, number>();
  for (const m of memories) byType.set(m.type, (byType.get(m.type) ?? 0) + 1);
  const stats = state.agentMemory.getStats();
  let content = `**Agent Memories** — ${memories.length} entries\n\n`;
  content += `| Type | Count |\n|------|-------|\n`;
  for (const [type, count] of byType) content += `| ${type} | ${count} |\n`;
  content += `\nTotal entries: ${stats.totalCount}. Use \`/memory-search <query>\` to search.\n\n`;
  state.postMessage({ command: 'assistantMessage', content });
}

export function handleSearchMemories(state: ChatState, query: string): void {
  if (!state.agentMemory || !query) {
    state.postMessage({
      command: 'assistantMessage',
      content: 'Agent memory is not enabled or no query provided.\n\n',
    });
    return;
  }
  const results = state.agentMemory.search(query, undefined, 10);
  if (results.length === 0) {
    state.postMessage({ command: 'assistantMessage', content: `No memories found for "${query}".\n\n` });
    return;
  }
  let content = `**Memory search:** "${query}" — ${results.length} results\n\n`;
  for (const m of results) {
    content += `- **[${m.type}]** ${m.content.slice(0, 120)}${m.content.length > 120 ? '...' : ''} *(used ${m.useCount}x)*\n`;
  }
  content += '\n';
  state.postMessage({ command: 'assistantMessage', content });
}

export function handleToggleVerbose(state: ChatState): void {
  const current = getConfig().verboseMode;
  workspace.getConfiguration('sidecar').update('verboseMode', !current, true);
  const label = !current ? 'on' : 'off';
  state.postMessage({
    command: 'assistantMessage',
    content: `Verbose mode ${label}. ${!current ? 'Agent reasoning will be shown during runs.' : 'Agent reasoning hidden.'}`,
  });
  state.postMessage({ command: 'done' });
}

export function handleGetSkillsForMenu(state: ChatState): void {
  const skills = state.skillLoader?.getAll() || [];
  const items = skills.map((s) => ({ id: s.id, name: s.name, description: s.description }));
  state.postMessage({ command: 'skillsMenu', skills: items });
}
