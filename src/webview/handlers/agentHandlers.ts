/**
 * Action handlers — slash commands that invoke the LLM or run the agent loop.
 *
 * Handlers that only display status/reports without calling a model
 * live in infoHandlers.ts.
 */

import { window, workspace, Uri, WorkspaceEdit, Range } from 'vscode';
import * as path from 'path';
import type { ChatState } from '../chatState.js';
import { getConfig, resolveMode } from '../../config/settings.js';
import { handleUserMessage } from './chatHandlers.js';
import { parseBatchInput, runBatch } from '../../agent/batch.js';
import { generateSpec, saveSpec } from '../../agent/specDriven.js';
import { generateInit } from '../../agent/codebaseInit.js';
import { generateDocumentation } from '../../agent/docGenerator.js';
import { generateTests } from '../../agent/testGenerator.js';
import { generateScaffold, getTemplateList } from '../../agent/scaffold.js';
import { charsToTokens } from '../../config/tokenEstimation.js';

export async function handleExecutePlan(state: ChatState): Promise<void> {
  if (!state.pendingPlan || state.pendingPlanMessages.length === 0) return;
  state.pendingPlanMessages.push({
    role: 'user',
    content: `Execute the following plan step by step:\n\n${state.pendingPlan}`,
  });
  state.messages = state.pendingPlanMessages;
  state.pendingPlan = null;
  state.pendingPlanMessages = [];
  state.saveHistory();
  // Temporarily switch out of plan mode during execution so we execute instead of planning again
  const config = workspace.getConfiguration('sidecar');
  const previousMode = config.get<string>('agentMode', 'cautious');
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
  state.saveHistory();
  // Temporarily switch out of plan mode during revision so we get a revised plan, not another plan of a plan
  const config = workspace.getConfiguration('sidecar');
  const previousMode = config.get<string>('agentMode', 'cautious');
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

  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
  }

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
      {
        logger: state.agentLogger,
        mcpManager: state.mcpManager,
        approvalMode: resolveMode(config.agentMode, config.customModes).approvalBehavior,
      },
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

    // Resolve the target URI for .sidecar/SIDECAR.md.
    const targetUri = state.sidecarDir?.isReady()
      ? state.sidecarDir.getUri('SIDECAR.md')
      : (() => {
          const root = workspace.workspaceFolders?.[0]?.uri;
          return root ? Uri.joinPath(root, '.sidecar', 'SIDECAR.md') : null;
        })();

    if (!targetUri) {
      state.postMessage({ command: 'error', content: 'No workspace folder open to write SIDECAR.md.' });
      state.postMessage({ command: 'setLoading', isLoading: false });
      return;
    }

    // Ensure .sidecar/ exists, and create an empty file on first run so we
    // can obtain a TextDocument handle below.
    try {
      await workspace.fs.createDirectory(Uri.file(path.dirname(targetUri.fsPath)));
    } catch {
      // Already exists
    }
    try {
      await workspace.fs.stat(targetUri);
    } catch {
      await workspace.fs.writeFile(targetUri, new Uint8Array());
    }

    // Apply the update through a WorkspaceEdit so VS Code's in-memory model
    // stays in sync with disk. Writing via workspace.fs.writeFile on a file
    // that's already open in an editor tab leaves the cached TextDocument
    // stale, so the tab keeps showing old content until manual revert.
    const doc = await workspace.openTextDocument(targetUri);
    const fullRange = doc.validateRange(new Range(0, 0, doc.lineCount, 0));
    const edit = new WorkspaceEdit();
    edit.replace(targetUri, fullRange, sidecarMd);
    const applied = await workspace.applyEdit(edit);
    if (!applied) {
      throw new Error('Failed to apply SIDECAR.md edit');
    }
    await doc.save();
    await window.showTextDocument(doc, { preview: true });

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

  try {
    const result = await generateDocumentation(state.client, code, language, fileName);
    if (result) {
      state.postMessage({ command: 'assistantMessage', content: result });
    } else {
      state.postMessage({ command: 'error', content: 'Failed to generate documentation.' });
    }
  } catch (err) {
    state.postMessage({ command: 'error', content: err instanceof Error ? err.message : String(err) });
  } finally {
    state.postMessage({ command: 'done' });
    state.postMessage({ command: 'setLoading', isLoading: false });
  }
}

export async function handleSpec(state: ChatState, description: string): Promise<void> {
  state.postMessage({ command: 'setLoading', isLoading: true });
  const config = getConfig();
  state.client.updateConnection(config.baseUrl, config.apiKey);
  state.client.updateModel(config.model);

  try {
    const spec = await generateSpec(state.client, description);
    if (spec) {
      state.postMessage({ command: 'assistantMessage', content: spec });
      await saveSpec(spec, description.slice(0, 40), state.sidecarDir);
    } else {
      state.postMessage({ command: 'error', content: 'Failed to generate spec.' });
    }
  } catch (err) {
    state.postMessage({ command: 'error', content: err instanceof Error ? err.message : String(err) });
  } finally {
    state.postMessage({ command: 'done' });
    state.postMessage({ command: 'setLoading', isLoading: false });
  }
}

/**
 * `/resume` — continue a response that was cut off mid-stream.
 *
 * When a backend stream fails partway through (network drop, provider
 * timeout, transient error), the agent loop captures whatever text had
 * been streamed before the throw into `state.pendingPartialAssistant`.
 * This command consumes that partial and re-dispatches the last turn
 * with a "please continue from where you left off" hint synthesized
 * from the partial. The underlying message history is untouched — the
 * failed turn never appended an assistant message — so the model sees
 * the same inputs as before plus the continuation nudge.
 *
 * Clears `pendingPartialAssistant` after consumption so repeated /resume
 * calls don't replay the same partial over and over.
 */
export async function handleResume(state: ChatState): Promise<void> {
  const partial = state.pendingPartialAssistant;
  if (!partial || partial.length === 0) {
    state.postMessage({
      command: 'assistantMessage',
      content:
        'No partial response to resume. /resume picks up where a stream failed mid-turn — it only has something to do after an error.',
    });
    state.postMessage({ command: 'done' });
    return;
  }

  // Truncate the preview so a huge partial doesn't balloon the hint.
  const preview = partial.length > 600 ? partial.slice(0, 600) + '\n... (partial truncated)' : partial;
  const hint =
    `Your previous response was cut off mid-stream by a backend failure. ` +
    `You had emitted the following text before the connection dropped:\n\n` +
    `---\n${preview}\n---\n\n` +
    `Please continue from exactly where you left off. Do not repeat the text above verbatim; ` +
    `pick up the next sentence or action as if the stream had not broken.`;

  // Consume the partial before dispatching so a second failure doesn't
  // replay against the already-used partial.
  state.pendingPartialAssistant = null;
  await handleUserMessage(state, hint);
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

  try {
    const result = await generateTests(state.client, code, language, fileName);
    if (result) {
      state.postMessage({
        command: 'assistantMessage',
        content: `Generated tests for **${fileName}** → \`${result.testFileName}\`\n\n\`\`\`${language}:${result.testFileName}\n${result.content}\n\`\`\``,
      });
    } else {
      state.postMessage({ command: 'error', content: 'Failed to generate tests.' });
    }
  } catch (err) {
    state.postMessage({ command: 'error', content: err instanceof Error ? err.message : String(err) });
  } finally {
    state.postMessage({ command: 'done' });
    state.postMessage({ command: 'setLoading', isLoading: false });
  }
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

  try {
    const result = await generateScaffold(state.client, templateType, description, language);
    if (result) {
      state.postMessage({ command: 'assistantMessage', content: `\`\`\`${language}\n${result}\n\`\`\`` });
    } else {
      state.postMessage({ command: 'error', content: `Failed to generate ${templateType} scaffold.` });
    }
  } catch (err) {
    state.postMessage({ command: 'error', content: err instanceof Error ? err.message : String(err) });
  } finally {
    state.postMessage({ command: 'done' });
    state.postMessage({ command: 'setLoading', isLoading: false });
  }
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

export async function handleCompactContext(state: ChatState): Promise<void> {
  if (state.abortController) {
    state.postMessage({
      command: 'assistantMessage',
      content: 'Cannot compact context while an agent is running.',
    });
    state.postMessage({ command: 'done' });
    return;
  }
  const msgCount = state.messages.length;
  if (msgCount < 4) {
    state.postMessage({
      command: 'assistantMessage',
      content: 'Context is already minimal — nothing to compact.',
    });
    state.postMessage({ command: 'done' });
    return;
  }

  state.postMessage({
    command: 'assistantMessage',
    content: 'Compacting conversation context...',
  });

  try {
    const { ConversationSummarizer } = await import('../../agent/conversationSummarizer.js');
    const summarizer = new ConversationSummarizer(state.client);
    const result = await summarizer.summarize(state.messages, {
      keepRecentTurns: 2,
      minCharsToSave: 500,
      maxSummaryLength: 1200,
      summaryTimeoutMs: 15000,
    });

    if (result.freedChars > 0) {
      state.messages.splice(0, state.messages.length, ...result.messages);
      state.saveHistory();
      const tokensFreed = charsToTokens(result.freedChars);
      state.postMessage({
        command: 'assistantMessage',
        content: `Compacted: ${result.metadata.turnsSummarized}/${result.metadata.turnsCount} turns summarized, ~${tokensFreed} tokens freed. The conversation context is now smaller and the model will respond faster.`,
      });
    } else {
      state.postMessage({
        command: 'assistantMessage',
        content: 'Context is already compact — not enough old turns to summarize.',
      });
    }
  } catch (err) {
    state.postMessage({
      command: 'assistantMessage',
      content: `Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  state.postMessage({ command: 'done' });
}

/**
 * `/guards` — list active regression guards from workspace config and report
 * the current mode. Does not require an agent to be running.
 */
export async function handleGuardsStatus(state: ChatState): Promise<void> {
  const cfg = workspace.getConfiguration('sidecar');
  const mode = cfg.get<'off' | 'strict' | 'warn'>('regressionGuards.mode', 'strict');
  const raw = cfg.get<unknown[]>('regressionGuards', []);

  const { BUILT_IN_GUARD_IDS, BUILT_IN_GUARD_DESCRIPTIONS } = await import('../../agent/guards/builtInGuards.js');
  const { validateGuard } = await import('../../agent/guards/regressionGuardHook.js');

  const lines: string[] = ['**Regression Guards**', ''];

  lines.push(`Mode: \`${mode}\``);
  if (mode === 'off') {
    lines.push('All guards are disabled (`sidecar.regressionGuards.mode: "off"`).');
    state.postMessage({ command: 'assistantMessage', content: lines.join('\n') });
    state.postMessage({ command: 'done' });
    return;
  }

  // User-configured guards
  const configured: string[] = [];
  if (Array.isArray(raw) && raw.length > 0) {
    lines.push('', '**Configured guards** (`sidecar.regressionGuards`):');
    for (const entry of raw) {
      const g = validateGuard(entry);
      if (!g) continue;
      const blocking = mode === 'warn' ? 'advisory (mode=warn)' : g.blocking === false ? 'advisory' : 'blocking';
      lines.push(`  - \`${g.name}\` — trigger: \`${g.trigger}\`, ${blocking}`);
      configured.push(g.name);
    }
    if (configured.length === 0) lines.push('  (none — all entries failed validation)');
  } else {
    lines.push('', 'No guards configured in `sidecar.regressionGuards`.');
  }

  // Built-in guards overview
  lines.push('', '**Built-in guard IDs** (use in skill frontmatter `guards:` field):');
  for (const id of BUILT_IN_GUARD_IDS) {
    lines.push(`  - \`${id}\` — ${BUILT_IN_GUARD_DESCRIPTIONS[id]}`);
  }
  lines.push('');
  lines.push(
    "To activate built-in guards for a skill, add `guards: [lint-clean, tests-pass]` to the skill's frontmatter.",
  );

  state.postMessage({ command: 'assistantMessage', content: lines.join('\n') });
  state.postMessage({ command: 'done' });
}
