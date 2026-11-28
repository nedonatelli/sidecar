import * as vscode from 'vscode';
import * as path from 'path';
import { runAgentLoop, type AgentCallbacks } from '../agent/loop.js';
import { getWorkspaceRoot } from '../config/workspace.js';
import type { SideCarClient } from '../ollama/client.js';
import type { ChatMessage } from '../ollama/types.js';
import type { MCPManager } from '../agent/mcpManager.js';
import { getConfig, resolveMode, type SideCarConfig } from '../config/settings.js';
import { recordUserAuthoredText } from '../agent/conversationSummarizer.js';
import type { ApprovalMode, ConfirmFn } from '../agent/executor.js';

/**
 * How `@sidecar` asks before acting. It runs SideCar's own agent loop, so
 * VS Code's chat tool-approval UI never sees its tool calls; it used to pass
 * `approvalMode: 'autonomous'` unconditionally, so a user in cautious mode got
 * no prompt at all here. It now follows `sidecar.agentMode` like the SideCar
 * panel does, asking through a modal (a participant's response stream cannot
 * wait on a click). Two modes need the panel's own UI -- `plan` (the plan
 * view) and `review` (the pending-edit queue; without one, writes would land
 * unprompted) -- so they run as `cautious` here.
 */
export function participantApprovalOptions(config: Pick<SideCarConfig, 'agentMode' | 'customModes'>): {
  approvalMode: ApprovalMode;
  modeToolPermissions: Record<string, 'allow' | 'deny' | 'ask'>;
  confirmFn: ConfirmFn;
} {
  const resolved = resolveMode(config.agentMode, config.customModes);
  const approvalMode: ApprovalMode =
    resolved.approvalBehavior === 'plan' || resolved.approvalBehavior === 'review'
      ? 'cautious'
      : resolved.approvalBehavior;
  return {
    approvalMode,
    modeToolPermissions: resolved.toolPermissions,
    // Only bold markers are stripped: the message and the detail carry the
    // command and paths being approved, which must be shown exactly.
    confirmFn: async (message, actions, options) => {
      const plain = message.replace(/\*\*/g, '').trim();
      return vscode.window.showWarningMessage(
        `SideCar (@sidecar): ${plain}`,
        { modal: true, detail: options?.detail },
        ...actions,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Slash-command dispatch table
// ---------------------------------------------------------------------------

export interface SlashCommandDef {
  readonly systemPrompt: string;
  readonly preamble: (prompt: string) => string;
}

export const GENERIC_SYSTEM_PROMPT =
  'You are SideCar, an expert AI coding assistant. ' +
  'Give concise, accurate answers. Format code in fenced code blocks with the language identifier.';

export const SLASH_COMMANDS: Record<string, SlashCommandDef> = {
  review: {
    systemPrompt:
      'You are SideCar, an expert code reviewer. ' +
      'Review the provided code for bugs, security issues, performance problems, and style. ' +
      'Be specific: cite line numbers or symbol names when relevant. ' +
      'Format findings as a short bulleted list followed by any suggested rewrite.',
    preamble: (p) => (p.trim() ? `Review the following:\n\n${p}` : 'Review the attached code.'),
  },
  fix: {
    systemPrompt:
      'You are SideCar, an expert debugging assistant. ' +
      'Identify the root cause of the issue and provide a corrected version of the code. ' +
      'Output only the fixed code block followed by a one-sentence explanation.',
    preamble: (p) => (p.trim() ? `Fix the following:\n\n${p}` : 'Fix the attached code.'),
  },
  explain: {
    systemPrompt:
      'You are SideCar, an expert code explainer. ' +
      'Explain what the code does clearly and concisely. ' +
      'Cover: purpose, key logic, inputs/outputs, and any non-obvious behaviour.',
    preamble: (p) => (p.trim() ? `Explain the following:\n\n${p}` : 'Explain the attached code.'),
  },
  'commit-message': {
    systemPrompt:
      'You are SideCar, a git commit-message writer. ' +
      'Output a single conventional-commits message (type(scope): subject, ≤72 chars). ' +
      'Optionally add a short body paragraph if the change warrants it. ' +
      'Do not wrap in code fences.',
    preamble: (p) =>
      p.trim()
        ? `Write a commit message for the following diff or description:\n\n${p}`
        : 'Write a commit message for the attached diff.',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Adapt a VS Code CancellationToken to an AbortSignal. */
export function tokenToSignal(token: vscode.CancellationToken): AbortSignal {
  const ac = new AbortController();
  if (token.isCancellationRequested) {
    ac.abort();
  } else {
    token.onCancellationRequested(() => ac.abort());
  }
  return ac.signal;
}

/** Read a VS Code Uri into text, capped at maxBytes. */
export async function readUri(uri: vscode.Uri, maxBytes = 512_000): Promise<string> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    return text.length > maxBytes ? text.slice(0, maxBytes) + '\n[...truncated]' : text;
  } catch {
    return '';
  }
}

/** Read a Location (range within a file) into text. */
async function readLocation(loc: vscode.Location, maxBytes = 512_000): Promise<string> {
  try {
    const doc = await vscode.workspace.openTextDocument(loc.uri);
    const text = doc.getText(loc.range);
    return text.length > maxBytes ? text.slice(0, maxBytes) + '\n[...truncated]' : text;
  } catch {
    return '';
  }
}

/**
 * Resolve the effective user text and system prompt from a ChatRequest.
 * Inlines any attached file/selection references into the user text.
 */
export async function resolveRequestContent(request: vscode.ChatRequest): Promise<{
  userText: string;
  systemPrompt: string;
}> {
  const cmd = SLASH_COMMANDS[request.command ?? ''];
  const systemPrompt = cmd?.systemPrompt ?? GENERIC_SYSTEM_PROMPT;

  // Collect attachment text from references.
  // Use duck-typing rather than instanceof — the VS Code mock exposes Uri
  // as a plain object with static methods, not a class, so instanceof would
  // always be false in tests (and in some extension host environments).
  const attachments: string[] = [];
  for (const ref of request.references ?? []) {
    const val = ref.value as { fsPath?: string; uri?: { fsPath: string }; range?: unknown } | string | unknown;
    if (typeof val === 'object' && val !== null && 'fsPath' in val && !('uri' in val)) {
      // Uri-shaped value
      const text = await readUri(val as vscode.Uri);
      if (text) attachments.push(`\`${ref.id ?? (val as vscode.Uri).fsPath}\`:\n\`\`\`\n${text}\n\`\`\``);
    } else if (typeof val === 'object' && val !== null && 'uri' in val && 'range' in val) {
      // Location-shaped value
      const text = await readLocation(val as vscode.Location);
      if (text) attachments.push(`\`${ref.id ?? (val as vscode.Location).uri.fsPath}\`:\n\`\`\`\n${text}\n\`\`\``);
    } else if (typeof val === 'string' && val.trim()) {
      attachments.push(val);
    }
  }

  const basePrompt = request.prompt ?? '';
  recordUserAuthoredText(basePrompt);
  const withPreamble = cmd ? cmd.preamble(basePrompt) : basePrompt;
  const userText = attachments.length > 0 ? `${withPreamble}\n\n${attachments.join('\n\n')}` : withPreamble;

  return { userText, systemPrompt };
}

/**
 * Convert VS Code chat history to ChatMessage[].
 * Caps at maxTurns (pairs) to avoid context overflow.
 */
export function buildHistoryFromChatContext(
  history: readonly vscode.ChatContext['history'][number][],
  currentUserText: string,
  maxTurns = 20,
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // VS Code history is oldest-first; each entry is ChatRequestTurn | ChatResponseTurn
  const capped = history.slice(-maxTurns * 2);
  for (const entry of capped) {
    if ('prompt' in entry) {
      // ChatRequestTurn
      messages.push({ role: 'user', content: entry.prompt });
    } else if ('response' in entry) {
      // ChatResponseTurn — concatenate markdown parts
      const parts = entry.response;
      const text = Array.isArray(parts)
        ? parts
            .map((p: unknown) => {
              const part = p as { value?: unknown };
              return typeof part.value === 'string' ? part.value : '';
            })
            .join('')
        : typeof parts === 'string'
          ? parts
          : '';
      if (text) messages.push({ role: 'assistant', content: text });
    }
  }

  messages.push({ role: 'user', content: currentUserText });
  return messages;
}

// ---------------------------------------------------------------------------
// Runs shared with the sidecar_delegate tool
// ---------------------------------------------------------------------------

/**
 * A slash command: one plain completion under its own system prompt. The
 * prompt is passed per call, not set on the client -- the client is the
 * SideCar panel's, and setting it replaced the panel's prompt.
 */
export async function streamSlashCompletion(
  client: SideCarClient,
  messages: ChatMessage[],
  systemPrompt: string,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<void> {
  for await (const event of client.streamChat(messages, signal, undefined, systemPrompt)) {
    if (signal.aborted) break;
    if (event.type === 'text') {
      onText(event.text);
    } else if (event.type === 'stop') {
      break;
    }
  }
}

/** Where an agent run reports what it is doing. */
export interface AgentRunSink {
  onText: (text: string) => void;
  onProgress: (message: string) => void;
  onToolError: () => void;
  /** Streamed tool output; omitted, it is dropped. */
  onToolOutput?: (chunk: string) => void;
}

/**
 * A request through SideCar's own agent loop under the user's approval mode
 * (`participantApprovalOptions`). Returns the absolute paths of the files the
 * run wrote or edited.
 */
export async function runSidecarAgent(
  client: SideCarClient,
  messages: ChatMessage[],
  systemPrompt: string,
  signal: AbortSignal,
  sink: AgentRunSink,
  mcpManager?: MCPManager,
): Promise<Set<string>> {
  const editedFiles = new Set<string>();
  const workspaceRoot = getWorkspaceRoot();

  const callbacks: AgentCallbacks = {
    onText: sink.onText,
    onThinking: () => {}, // suppress raw thinking blocks in chat
    // Capture file paths from write/edit tool calls.
    onToolCall: (name, input) => {
      if ((name === 'write_file' || name === 'edit_file' || name === 'create_file') && typeof input.path === 'string') {
        editedFiles.add(path.isAbsolute(input.path) ? input.path : path.join(workspaceRoot, input.path));
      }
      sink.onProgress(`Running \`${name}\`…`);
    },
    onToolResult: (_name, _result, isError) => {
      if (isError) sink.onToolError();
    },
    onToolOutput: (_name, chunk) => sink.onToolOutput?.(chunk),
    onProgressSummary: sink.onProgress,
    onDone: () => {},
  };

  await runAgentLoop(client, messages, callbacks, signal, {
    ...participantApprovalOptions(getConfig()),
    systemPromptOverride: systemPrompt,
    mcpManager,
  });
  return editedFiles;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the `@sidecar` native VS Code chat participant.
 * Called from extension.ts after chatProvider is initialised.
 *
 * Deprecated (#493): VS Code's Copilot harness does not run chat
 * participants, and the Local harness is removed in February 2027.
 * `sidecar_delegate` (delegateTool.ts) replaces it; remove this before then.
 *
 * Slash commands (/review, /fix, /explain, /commit-message) run a plain
 * completion with a specialised system prompt — they're Q&A style, not
 * agentic, so the full loop would be overkill. All other requests go
 * through `runAgentLoop` under the user's own approval mode
 * (`participantApprovalOptions`).
 */
export function registerSidecarParticipant(
  context: vscode.ExtensionContext,
  getClient: () => SideCarClient,
  mcpManager?: MCPManager,
): void {
  const handler: vscode.ChatRequestHandler = async (request, chatContext, response, token) => {
    const client = getClient();
    const { userText, systemPrompt } = await resolveRequestContent(request);
    const messages = buildHistoryFromChatContext(chatContext.history, userText);
    const signal = tokenToSignal(token);

    // Slash commands use a focused system prompt + plain completion.
    if (request.command && SLASH_COMMANDS[request.command]) {
      response.progress('Thinking…');
      try {
        await streamSlashCompletion(client, messages, systemPrompt, signal, (text) => response.markdown(text));
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        throw err;
      }
      return;
    }

    // All other requests: full agent loop with tool use.
    response.progress('Starting SideCar agent…');

    const workspaceRoot = getWorkspaceRoot();
    let editedFiles: Set<string>;
    try {
      editedFiles = await runSidecarAgent(
        client,
        messages,
        systemPrompt,
        signal,
        {
          onText: (text) => response.markdown(text),
          onProgress: (message) => response.progress(message),
          onToolError: () => response.markdown('\n> ⚠️ Tool returned an error.\n'),
          onToolOutput: (chunk) => response.markdown(chunk),
        },
        mcpManager,
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    }

    // Surface edited files as clickable anchors and a review button.
    if (editedFiles.size > 0) {
      response.markdown('\n\n**Files changed:**\n');
      for (const filePath of editedFiles) {
        response.anchor(vscode.Uri.file(filePath), path.relative(workspaceRoot, filePath));
      }
      response.button({ command: 'sidecar.reviewChanges', title: 'Review Changes' });
    }
  };

  const participant = vscode.chat.createChatParticipant('sidecar.sidecar', handler);
  participant.iconPath = new vscode.ThemeIcon('robot');
  context.subscriptions.push(participant);
}
