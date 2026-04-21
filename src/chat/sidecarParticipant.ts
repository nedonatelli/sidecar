import * as vscode from 'vscode';
import type { SideCarClient } from '../ollama/client.js';
import type { ChatMessage } from '../ollama/types.js';

// ---------------------------------------------------------------------------
// Slash-command dispatch table
// ---------------------------------------------------------------------------

interface SlashCommandDef {
  readonly systemPrompt: string;
  readonly preamble: (prompt: string) => string;
}

const GENERIC_SYSTEM_PROMPT =
  'You are SideCar, an expert AI coding assistant. ' +
  'Give concise, accurate answers. Format code in fenced code blocks with the language identifier.';

const SLASH_COMMANDS: Record<string, SlashCommandDef> = {
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
function tokenToSignal(token: vscode.CancellationToken): AbortSignal {
  const ac = new AbortController();
  if (token.isCancellationRequested) {
    ac.abort();
  } else {
    token.onCancellationRequested(() => ac.abort());
  }
  return ac.signal;
}

/** Read a VS Code Uri into text, capped at maxBytes. */
async function readUri(uri: vscode.Uri, maxBytes = 512_000): Promise<string> {
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
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the `@sidecar` native VS Code chat participant.
 * Called from extension.ts after chatProvider is initialised.
 */
export function registerSidecarParticipant(context: vscode.ExtensionContext, getClient: () => SideCarClient): void {
  const handler: vscode.ChatRequestHandler = async (request, chatContext, response, token) => {
    const client = getClient();
    const { userText, systemPrompt } = await resolveRequestContent(request);

    client.updateSystemPrompt(systemPrompt);
    const messages = buildHistoryFromChatContext(chatContext.history, userText);
    const signal = tokenToSignal(token);

    response.progress('Thinking…');

    try {
      for await (const event of client.streamChat(messages, signal)) {
        if (token.isCancellationRequested) break;
        if (event.type === 'text') {
          response.markdown(event.text);
        } else if (event.type === 'warning') {
          response.markdown(`\n> ⚠️ ${event.message}\n`);
        } else if (event.type === 'stop') {
          break;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    }
  };

  const participant = vscode.chat.createChatParticipant('sidecar.sidecar', handler);
  participant.iconPath = new vscode.ThemeIcon('robot');
  context.subscriptions.push(participant);
}
