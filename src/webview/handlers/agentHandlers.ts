import { window, workspace, Uri } from 'vscode';
import * as path from 'path';
import type { ChatState } from '../chatState.js';
import { getConfig } from '../../config/settings.js';
import { handleUserMessage } from './chatHandlers.js';
import { parseBatchInput, runBatch } from '../../agent/batch.js';
import { generateInsightReport } from '../../agent/insightReport.js';
import { generateUsageReport } from '../../agent/usageReport.js';
import { generateContextReport } from '../../agent/contextReport.js';
import { generateSpec, saveSpec } from '../../agent/specDriven.js';
import { generateInit } from '../../agent/codebaseInit.js';
import { generateDocumentation } from '../../agent/docGenerator.js';
import { generateTests } from '../../agent/testGenerator.js';
import { runLint } from '../../agent/lintFix.js';
import { analyzeDependencies } from '../../agent/depAnalysis.js';
import { generateScaffold, getTemplateList } from '../../agent/scaffold.js';
import { analyzeConversation, formatAnalyticsReport } from '../../agent/conversationAnalytics.js';
import type { AuditFilter } from '../../agent/auditLog.js';

export async function handleExecutePlan(state: ChatState): Promise<void> {
  if (!state.pendingPlan || state.pendingPlanMessages.length === 0) return;
  state.pendingPlanMessages.push({
    role: 'user',
    content: `Execute the following plan step by step:\n\n${state.pendingPlan}`,
  });
  state.messages = state.pendingPlanMessages;
  state.pendingPlan = null;
  state.pendingPlanMessages = [];
  // Temporarily switch out of plan mode during execution so we execute instead of planning again
  const config = workspace.getConfiguration('sidecar');
  const previousMode = config.get<'cautious' | 'autonomous' | 'manual' | 'plan'>('agentMode', 'cautious');
  if (previousMode === 'plan') {
    await config.update('agentMode', 'cautious', true);
  }
  try {
    await handleUserMessage(state, '');
  } finally {
    // Restore plan mode after execution
    if (previousMode === 'plan') {
      await config.update('agentMode', 'plan', true);
    }
  }
}

export async function handleRevisePlan(state: ChatState, feedback: string): Promise<void> {
  if (state.pendingPlanMessages.length === 0) return;
  state.pendingPlanMessages.push({ role: 'user', content: `Revise the plan based on this feedback: ${feedback}` });
  state.messages = state.pendingPlanMessages;
  state.pendingPlan = null;
  state.pendingPlanMessages = [];
  // Temporarily switch out of plan mode during revision so we get a revised plan, not another plan of a plan
  const config = workspace.getConfiguration('sidecar');
  const previousMode = config.get<'cautious' | 'autonomous' | 'manual' | 'plan'>('agentMode', 'cautious');
  if (previousMode === 'plan') {
    await config.update('agentMode', 'cautious', true);
  }
  try {
    await handleUserMessage(state, '');
  } finally {
    // Restore plan mode after revision
    if (previousMode === 'plan') {
      await config.update('agentMode', 'plan', true);
    }
  }
}

export async function handleBatch(state: ChatState, text: string): Promise<void> {
  const { mode, tasks } = parseBatchInput(text);
  if (tasks.length === 0) return;

  state.postMessage({ command: 'assistantMessage', content: `Starting batch (${mode}): ${tasks.length} task(s)\n\n` });

  const abortController = new AbortController();
  state.abortController = abortController;

  const config = getConfig();
  state.client.updateConnection(config.baseUrl, config.apiKey);
  state.client.updateModel(config.model);

  try {
    await runBatch(
      state.client,
      tasks,
      mode,
      (taskId, status, result) => {
        const preview = result.length > 100 ? result.slice(0, 100) + '...' : result;
        state.postMessage({
          command: 'assistantMessage',
          content: `Task ${taskId + 1}: ${status}${preview ? ' — ' + preview : ''}\n`,
        });
      },
      abortController.signal,
      { logger: state.agentLogger, mcpManager: state.mcpManager, approvalMode: config.agentMode },
    );

    state.postMessage({ command: 'assistantMessage', content: '\nBatch complete.\n' });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      state.postMessage({ command: 'assistantMessage', content: '\nBatch interrupted.\n' });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      state.postMessage({ command: 'error', content: `Batch error: ${msg}` });
    }
  } finally {
    state.postMessage({ command: 'done' });
    state.postMessage({ command: 'setLoading', isLoading: false });
    state.abortController = null;
  }
}

export async function handleInsight(state: ChatState): Promise<void> {
  const history = state.metricsCollector.getHistory();
  const report = generateInsightReport(history);
  const doc = await workspace.openTextDocument({ content: report, language: 'markdown' });
  await window.showTextDocument(doc, { preview: true });
}

/**
 * `/init` command — scan the codebase and generate a persistent SIDECAR.md
 * that provides project context for all future conversations.
 */
export async function handleInit(state: ChatState): Promise<void> {
  // Check if SIDECAR.md already exists and ask before overwriting
  const rootUri = workspace.workspaceFolders?.[0]?.uri;
  if (rootUri) {
    const existingUri = state.sidecarDir?.isReady()
      ? state.sidecarDir.getUri('SIDECAR.md')
      : Uri.joinPath(rootUri, '.sidecar', 'SIDECAR.md');
    try {
      await workspace.fs.stat(existingUri);
      const choice = await window.showWarningMessage(
        'SIDECAR.md already exists. Regenerating will overwrite it.',
        'Overwrite',
        'Cancel',
      );
      if (choice !== 'Overwrite') {
        state.postMessage({ command: 'assistantMessage', content: 'Init cancelled — existing SIDECAR.md kept.' });
        state.postMessage({ command: 'done' });
        return;
      }
    } catch {
      // File doesn't exist — proceed
    }
  }

  state.postMessage({ command: 'setLoading', isLoading: true });
  state.postMessage({ command: 'assistantMessage', content: 'Scanning codebase and generating SIDECAR.md...' });

  const config = getConfig();
  state.client.updateConnection(config.baseUrl, config.apiKey);
  state.client.updateModel(config.model);

  try {
    const sidecarMd = await generateInit(state.client, state.workspaceIndex);
    if (!sidecarMd) {
      state.postMessage({
        command: 'error',
        content: 'Failed to generate SIDECAR.md — no workspace open or LLM error.',
      });
      state.postMessage({ command: 'setLoading', isLoading: false });
      return;
    }

    // Save to .sidecar/SIDECAR.md via SidecarDir if available, otherwise fallback
    if (state.sidecarDir?.isReady()) {
      await state.sidecarDir.writeText('SIDECAR.md', sidecarMd);
      const doc = await workspace.openTextDocument(state.sidecarDir.getUri('SIDECAR.md'));
      await window.showTextDocument(doc, { preview: true });
    } else {
      const rootUri = workspace.workspaceFolders?.[0]?.uri;
      if (rootUri) {
        const sidecarDir = Uri.joinPath(rootUri, '.sidecar');
        try {
          await workspace.fs.createDirectory(sidecarDir);
        } catch {
          // Already exists
        }
        const fileUri = Uri.joinPath(sidecarDir, 'SIDECAR.md');
        await workspace.fs.writeFile(fileUri, Buffer.from(sidecarMd, 'utf-8'));
        const doc = await workspace.openTextDocument(fileUri);
        await window.showTextDocument(doc, { preview: true });
      }
    }

    state.postMessage({
      command: 'assistantMessage',
      content:
        'SIDECAR.md generated and saved to `.sidecar/SIDECAR.md`. This file will be automatically loaded into context for all future conversations. You can edit it to refine the project notes.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.postMessage({ command: 'error', content: `Failed to generate SIDECAR.md: ${msg}` });
  }

  state.postMessage({ command: 'done' });
  state.postMessage({ command: 'setLoading', isLoading: false });
}

export async function handleGenerateDoc(state: ChatState): Promise<void> {
  const editor = window.activeTextEditor;
  if (!editor) {
    state.postMessage({ command: 'error', content: 'No active editor. Open a file first.' });
    return;
  }
  const doc = editor.document;
  const code = editor.selection.isEmpty ? doc.getText() : doc.getText(editor.selection);
  const language = doc.languageId;
  const fileName = path.basename(doc.fileName);

  state.postMessage({ command: 'setLoading', isLoading: true });
  const config = getConfig();
  state.client.updateConnection(config.baseUrl, config.apiKey);
  state.client.updateModel(config.model);

  const result = await generateDocumentation(state.client, code, language, fileName);
  if (result) {
    state.postMessage({ command: 'assistantMessage', content: result });
  } else {
    state.postMessage({ command: 'error', content: 'Failed to generate documentation.' });
  }
  state.postMessage({ command: 'done' });
  state.postMessage({ command: 'setLoading', isLoading: false });
}

export async function handleSpec(state: ChatState, description: string): Promise<void> {
  state.postMessage({ command: 'setLoading', isLoading: true });
  const config = getConfig();
  state.client.updateConnection(config.baseUrl, config.apiKey);
  state.client.updateModel(config.model);

  const spec = await generateSpec(state.client, description);
  if (spec) {
    state.postMessage({ command: 'assistantMessage', content: spec });
    state.postMessage({ command: 'done' });
    await saveSpec(spec, description.slice(0, 40), state.sidecarDir);
  } else {
    state.postMessage({ command: 'error', content: 'Failed to generate spec.' });
  }
  state.postMessage({ command: 'setLoading', isLoading: false });
}

export async function handleUsage(state: ChatState): Promise<void> {
  const history = state.metricsCollector.getHistory();
  const report = generateUsageReport(history, state.metricsCollector);
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

export async function handleGenerateTests(state: ChatState): Promise<void> {
  const editor = window.activeTextEditor;
  if (!editor) {
    state.postMessage({ command: 'error', content: 'No active editor. Open a file first.' });
    return;
  }
  const doc = editor.document;
  const code = editor.selection.isEmpty ? doc.getText() : doc.getText(editor.selection);
  const language = doc.languageId;
  const fileName = path.basename(doc.fileName);

  state.postMessage({ command: 'setLoading', isLoading: true });
  const config = getConfig();
  state.client.updateConnection(config.baseUrl, config.apiKey);
  state.client.updateModel(config.model);

  const result = await generateTests(state.client, code, language, fileName);
  if (result) {
    state.postMessage({
      command: 'assistantMessage',
      content: `Generated tests for **${fileName}** → \`${result.testFileName}\`\n\n\`\`\`${language}:${result.testFileName}\n${result.content}\n\`\`\``,
    });
  } else {
    state.postMessage({ command: 'error', content: 'Failed to generate tests.' });
  }
  state.postMessage({ command: 'done' });
  state.postMessage({ command: 'setLoading', isLoading: false });
}

export async function handleLint(state: ChatState, command?: string): Promise<void> {
  state.postMessage({ command: 'setLoading', isLoading: true });
  const { output, success } = await runLint(command);
  state.postMessage({
    command: 'assistantMessage',
    content: success ? `✓ Lint passed:\n\`\`\`\n${output}\n\`\`\`` : `✗ Lint issues:\n\`\`\`\n${output}\n\`\`\``,
  });
  state.postMessage({ command: 'done' });
  state.postMessage({ command: 'setLoading', isLoading: false });
}

export async function handleDeps(state: ChatState): Promise<void> {
  state.postMessage({ command: 'setLoading', isLoading: true });
  const report = await analyzeDependencies();
  const doc = await workspace.openTextDocument({ content: report, language: 'markdown' });
  await window.showTextDocument(doc, { preview: true });
  state.postMessage({ command: 'done' });
  state.postMessage({ command: 'setLoading', isLoading: false });
}

export async function handleScaffold(state: ChatState, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const templateType = parts[0] || '';
  const description = parts.slice(1).join(' ');

  if (!templateType) {
    state.postMessage({
      command: 'assistantMessage',
      content: getTemplateList(),
    });
    state.postMessage({ command: 'done' });
    return;
  }

  const editor = window.activeTextEditor;
  const language = editor?.document.languageId || 'typescript';

  state.postMessage({ command: 'setLoading', isLoading: true });
  const config = getConfig();
  state.client.updateConnection(config.baseUrl, config.apiKey);
  state.client.updateModel(config.model);

  const result = await generateScaffold(state.client, templateType, description, language);
  if (result) {
    state.postMessage({ command: 'assistantMessage', content: `\`\`\`${language}\n${result}\n\`\`\`` });
  } else {
    state.postMessage({ command: 'error', content: `Failed to generate ${templateType} scaffold.` });
  }
  state.postMessage({ command: 'done' });
  state.postMessage({ command: 'setLoading', isLoading: false });
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

  // Gather all data sources
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

  const analytics = analyzeConversation(auditEntries, metrics, memories);
  const report = formatAnalyticsReport(analytics, metrics);

  const doc = await workspace.openTextDocument({ content: report, language: 'markdown' });
  await window.showTextDocument(doc, { preview: true });
  state.postMessage({ command: 'done' });
}

/**
 * Handle "Why?" button click — explain why the model chose a particular tool call.
 */
export async function handleExplainToolDecision(state: ChatState, toolCallId: string): Promise<void> {
  if (!state.auditLog) {
    state.postMessage({ command: 'assistantMessage', content: 'Audit log not available.' });
    state.postMessage({ command: 'done' });
    return;
  }

  const entry = await state.auditLog.getByToolCallId(toolCallId);
  if (!entry) {
    state.postMessage({
      command: 'assistantMessage',
      content: 'Could not find audit entry for this tool call.',
    });
    state.postMessage({ command: 'done' });
    return;
  }

  state.postMessage({ command: 'setLoading', isLoading: true });
  const config = getConfig();
  state.client.updateConnection(config.baseUrl, config.apiKey);
  state.client.updateModel(config.model);

  // Build a focused prompt to explain the tool decision
  const inputSummary = JSON.stringify(entry.input, null, 2).slice(0, 500);
  const resultPreview = entry.result.slice(0, 300);
  const prompt = [
    `Explain why you chose to call the tool "${entry.tool}" with the following parameters:`,
    '',
    '```json',
    inputSummary,
    '```',
    '',
    `Result (${entry.isError ? 'ERROR' : 'success'}, ${entry.durationMs}ms): ${resultPreview}`,
    '',
    'Provide a concise explanation (2-3 sentences) of:',
    '1. What information or goal motivated this tool call',
    '2. Why this tool was chosen over alternatives',
    '3. Whether the result was as expected',
  ].join('\n');

  try {
    const explanation = await state.client.complete([{ role: 'user', content: prompt }]);
    state.postMessage({
      command: 'assistantMessage',
      content: `**Why \`${entry.tool}\`?**\n\n${explanation || 'No explanation generated.'}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.postMessage({
      command: 'assistantMessage',
      content: `Could not generate explanation: ${msg}`,
    });
  }

  state.postMessage({ command: 'done' });
  state.postMessage({ command: 'setLoading', isLoading: false });
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
  const statusIcon = (s: string) =>
    s === 'connected' ? '\u2713' : s === 'connecting' ? '\u23F3' : s === 'failed' ? '\u2717' : '\u25CB';

  for (const server of status) {
    const icon = statusIcon(server.status);
    const uptime = server.connectedSinceMs !== undefined ? ` (up ${Math.round(server.connectedSinceMs / 1000)}s)` : '';
    lines.push(`${icon} **${server.name}** — ${server.status}${uptime}`);
    lines.push(`  Transport: ${server.transport} | Tools: ${server.toolCount}`);
    if (server.error) {
      lines.push(`  Error: ${server.error}`);
    }
  }

  lines.push('', `**Total tools:** ${totalTools}`);

  state.postMessage({ command: 'assistantMessage', content: lines.join('\n') });
  state.postMessage({ command: 'done' });
}
