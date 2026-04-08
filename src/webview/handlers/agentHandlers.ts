import { window, workspace } from 'vscode';
import * as path from 'path';
import type { ChatState } from '../chatState.js';
import { getConfig } from '../../config/settings.js';
import { handleUserMessage } from './chatHandlers.js';
import { parseBatchInput, runBatch } from '../../agent/batch.js';
import { generateInsightReport } from '../../agent/insightReport.js';
import { generateUsageReport } from '../../agent/usageReport.js';
import { generateContextReport } from '../../agent/contextReport.js';
import { generateSpec, saveSpec } from '../../agent/specDriven.js';
import { generateDocumentation } from '../../agent/docGenerator.js';
import { generateTests } from '../../agent/testGenerator.js';
import { runLint } from '../../agent/lintFix.js';
import { analyzeDependencies } from '../../agent/depAnalysis.js';
import { generateScaffold, getTemplateList } from '../../agent/scaffold.js';

export async function handleExecutePlan(state: ChatState): Promise<void> {
  if (!state.pendingPlan || state.pendingPlanMessages.length === 0) return;
  state.pendingPlanMessages.push({
    role: 'user',
    content: `Execute the following plan step by step:\n\n${state.pendingPlan}`,
  });
  state.messages = state.pendingPlanMessages;
  state.pendingPlan = null;
  state.pendingPlanMessages = [];
  await handleUserMessage(state, '');
}

export async function handleRevisePlan(state: ChatState, feedback: string): Promise<void> {
  if (state.pendingPlanMessages.length === 0) return;
  state.pendingPlanMessages.push({ role: 'user', content: `Revise the plan based on this feedback: ${feedback}` });
  state.messages = state.pendingPlanMessages;
  state.pendingPlan = null;
  state.pendingPlanMessages = [];
  await handleUserMessage(state, '');
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
  const report = generateUsageReport(history);
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
