/**
 * Notebook Mode handlers.
 *
 * Manages the /notebook slash command lifecycle:
 *   - Activates source-grounded research mode on the chat state
 *   - Injects a citation-constrained system prompt prefix
 *   - Exposes the notebookSystemPromptPrefix helper so chatHandlers
 *     can prepend it to the base system prompt when in notebook mode
 *   - /code exits notebook mode and clears ingested sources
 */

import type { ChatState } from '../chatState.js';
import { getConfig } from '../../config/settings.js';
import { clearIngestedSources, listIngestedSources } from '../../agent/tools/notebook.js';

// ---------------------------------------------------------------------------
// System prompt prefix injected when notebook mode is active
// ---------------------------------------------------------------------------

export function notebookSystemPromptPrefix(requireCitations: 'strict' | 'advisory' | 'off'): string {
  const citationRule =
    requireCitations === 'strict'
      ? 'MANDATORY: Every factual claim must be followed by an inline citation [N] referencing a source the user has ingested with ingest_source. Uncited claims must be flagged as ⚠ unsupported.'
      : requireCitations === 'advisory'
        ? 'Where possible, follow factual claims with inline citations [N] referencing ingested sources.'
        : '';

  return [
    '## Notebook Mode — Source-Grounded Research',
    '',
    'You are operating in Notebook Mode. Your answers must be grounded in the sources the user has indexed.',
    'Do NOT draw on general knowledge beyond what the sources support, unless the user explicitly asks.',
    '',
    ...(citationRule ? [citationRule, ''] : []),
    'Available tools: ingest_source (add a new source), generate_briefing, generate_study_guide,',
    'generate_faq, generate_timeline, generate_outline (study-aid generators).',
    '',
    'When the user asks a question, first check which ingested sources are relevant, then answer',
    'strictly from their content. If no relevant sources are ingested, say so and offer to ingest one.',
    '',
    'Exit notebook mode with /code to return to coding-agent mode.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// /notebook command entry point
// ---------------------------------------------------------------------------

export function handleNotebookStart(state: ChatState): void {
  const config = getConfig();
  const requireCitations = config.notebookModeRequireCitations;

  // Flip the notebook mode flag on the chat state so chatHandlers
  // prepends the citation system prompt for subsequent runs.
  (state as unknown as Record<string, unknown>).notebookModeActive = true;
  (state as unknown as Record<string, unknown>).notebookRequireCitations = requireCitations;

  const citationLabel =
    requireCitations === 'strict'
      ? 'Citations required on every claim'
      : requireCitations === 'advisory'
        ? 'Citations encouraged'
        : 'Citations optional';

  state.postMessage({
    command: 'assistantMessage',
    content:
      `**Notebook Mode activated** — ${citationLabel}.\n\n` +
      `I'll answer strictly from sources you index. Start with:\n` +
      `\`ingest_source\` — or just paste a URL and I'll ingest it automatically.\n\n` +
      `**Currently ingested sources:** ${
        listIngestedSources().length === 0
          ? 'none'
          : listIngestedSources()
              .map((s) => `\`${s.id}\` (${s.title})`)
              .join(', ')
      }\n\n` +
      `Type \`/code\` to exit Notebook Mode.`,
  });
  state.postMessage({ command: 'done' });
}

// ---------------------------------------------------------------------------
// /code command — exit notebook mode
// ---------------------------------------------------------------------------

export function handleNotebookExit(state: ChatState): void {
  (state as unknown as Record<string, unknown>).notebookModeActive = false;
  (state as unknown as Record<string, unknown>).notebookRequireCitations = undefined;
  clearIngestedSources();

  state.postMessage({
    command: 'assistantMessage',
    content: '**Notebook Mode exited.** Returned to coding-agent mode. Ingested sources cleared.',
  });
  state.postMessage({ command: 'done' });
}

// ---------------------------------------------------------------------------
// Query helpers used by chatHandlers.ts
// ---------------------------------------------------------------------------

export function isNotebookModeActive(state: ChatState): boolean {
  return (state as unknown as Record<string, unknown>).notebookModeActive === true;
}

export function getNotebookRequireCitations(state: ChatState): 'strict' | 'advisory' | 'off' {
  return (
    ((state as unknown as Record<string, unknown>).notebookRequireCitations as 'strict' | 'advisory' | 'off') ??
    'strict'
  );
}
