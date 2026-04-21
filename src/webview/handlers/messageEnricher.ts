import { window } from 'vscode';
import * as path from 'path';
import type { ChatState } from '../chatState.js';
import { getConfig } from '../../config/settings.js';
import { CHARS_PER_TOKEN } from '../../config/constants.js';
import {
  getWorkspaceRoot,
  resolveFileReferences,
  resolveAtReferences,
  resolveUrlReferences,
} from '../../config/workspace.js';
import { pruneHistory } from '../../agent/context.js';
import { getContentLength } from '../../ollama/types.js';

function getActiveFileContext(): string {
  const editor = window.activeTextEditor;
  if (!editor) return '';
  const doc = editor.document;
  const root = getWorkspaceRoot();
  const fileName = root ? path.relative(root, doc.fileName) : doc.fileName;
  const cursorLine = editor.selection.active.line + 1;
  const content = doc.getText();
  const maxChars = 50_000;
  const truncated = content.length > maxChars ? content.slice(0, maxChars) + '\n... (truncated)' : content;
  return `[Active file: ${fileName}, cursor at line ${cursorLine}]\n\`\`\`\n${truncated}\n\`\`\`\n\n`;
}

/**
 * Enrich the last user message with active file context, @references,
 * and URL content. Then prune the conversation history to fit the budget.
 */
export async function enrichAndPruneMessages(
  chatMessages: import('../../ollama/types.js').ChatMessage[],
  config: ReturnType<typeof getConfig>,
  systemPrompt: string,
  contextLength: number | null,
  state: ChatState,
  verbose: boolean,
): Promise<void> {
  // Enrich last user message
  if (chatMessages.length > 0) {
    let lastUserIdx = -1;
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    if (lastUserIdx !== -1) {
      let enriched =
        typeof chatMessages[lastUserIdx].content === 'string' ? (chatMessages[lastUserIdx].content as string) : '';

      if (config.includeActiveFile) {
        const activeCtx = getActiveFileContext();
        if (activeCtx) {
          enriched = activeCtx + enriched;
        }
      }

      enriched = await resolveFileReferences(enriched);
      enriched = await resolveAtReferences(enriched);
      if (config.fetchUrlContext) {
        enriched = await resolveUrlReferences(enriched);
      }

      chatMessages[lastUserIdx] = { ...chatMessages[lastUserIdx], content: enriched };
    }
  }

  // Prune history.
  // Reserve 75% of the token budget for in-session turns + tool results;
  // only 25% goes to carry-over history from prior chat turns. Without
  // this cap, a long chat history can start the loop near the compression
  // threshold, leaving almost no room for new tool calls.
  //
  // minBudget is a small fixed floor (not proportional to context size)
  // so a gigantic context window doesn't accidentally pin the minimum at
  // tens of thousands of tokens. The old `contextLength * 1` value was
  // meant to be chars but equalled contextLength (tokens), which kept the
  // floor far too high for large-context models.
  const systemChars = systemPrompt.length;
  const historyBudget = contextLength ? Math.floor(contextLength * 4 * 0.25) - systemChars : 80_000 - systemChars;
  const minBudget = 4_000;
  const prunedMessages = pruneHistory(chatMessages, Math.max(historyBudget, minBudget));
  if (prunedMessages.length < chatMessages.length && verbose) {
    const before = chatMessages.reduce((s, m) => s + getContentLength(m.content), 0);
    const after = prunedMessages.reduce((s, m) => s + getContentLength(m.content), 0);
    state.postMessage({
      command: 'verboseLog',
      content: `Pruned conversation: ${chatMessages.length} → ${prunedMessages.length} messages, ~${Math.round((before - after) / CHARS_PER_TOKEN)} tokens freed`,
      verboseLabel: 'Context Pruning',
    });
  }

  // Replace in place
  const pruned = [...prunedMessages];
  chatMessages.length = 0;
  chatMessages.push(...pruned);

  // Warn if context may exceed the model's limit
  if (contextLength) {
    const historyChars = chatMessages.reduce((sum, m) => sum + getContentLength(m.content), 0);
    const estimatedTokens = Math.ceil((historyChars + systemChars) / CHARS_PER_TOKEN);
    if (estimatedTokens > contextLength * 0.8) {
      state.postMessage({
        command: 'assistantMessage',
        content: `⚠️ Warning: Your conversation (~${estimatedTokens} tokens) may exceed this model's ${contextLength} token context window. Consider switching to a model with a larger context, reducing maxFiles, or starting a new conversation.\n\n`,
      });
    }
  }
}
