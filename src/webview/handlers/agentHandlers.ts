import { window, workspace } from 'vscode';
import * as path from 'path';
import type { ChatState } from '../chatState.js';
import { getConfig } from '../../config/settings.js';
import { handleUserMessage } from './chatHandlers.js';
import { parseBatchInput, runBatch } from '../../agent/batch.js';
import { generateInsightReport } from '../../agent/insightReport.js';
import { generateSpec, saveSpec } from '../../agent/specDriven.js';
import { generateDocumentation } from '../../agent/docGenerator.js';

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
  state.postMessage({ command: 'done' });
  state.abortController = null;
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
    await saveSpec(spec, description.slice(0, 40));
  } else {
    state.postMessage({ command: 'error', content: 'Failed to generate spec.' });
  }
  state.postMessage({ command: 'setLoading', isLoading: false });
}
