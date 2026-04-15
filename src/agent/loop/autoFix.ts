import type { ToolUseContentBlock } from '../../ollama/types.js';
import type { getConfig } from '../../config/settings.js';
import type { AgentCallbacks } from '../loop.js';
import { getDiagnostics } from '../tools.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Auto-fix on diagnostics — post-turn policy.
//
// After the agent writes code via write_file or edit_file, this
// helper waits a short beat for VS Code's language services to
// update, then pulls diagnostics for every written file and feeds
// errors back to the agent as a synthetic user message asking it to
// fix them. Bounded by a per-file retry budget (stored on
// LoopState.autoFixRetriesByFile) so a persistently broken file
// doesn't loop forever.
//
// Skipped when `sidecar.autoFixOnFailure` is off, when no files were
// written this turn, or when every written file has exhausted its
// retry budget. The 500ms delay before polling diagnostics is
// deliberate — VS Code's language-service updates are async and
// sometimes lag the fs event, so polling too soon produces stale
// clean results.
//
// Returns `true` when an auto-fix reprompt was injected. No-op
// return is `false`.
// ---------------------------------------------------------------------------

/** How long to wait for VS Code's language services to catch up after a write. */
const DIAGNOSTICS_SETTLE_DELAY_MS = 500;

/**
 * Scan diagnostics for every file written this turn, and inject a
 * reprompt when any have errors. Honors the per-file retry budget
 * stored on state.autoFixRetriesByFile — files at their cap are
 * skipped entirely, so the helper is a no-op on persistently broken
 * files once we've given up on them.
 */
export async function applyAutoFix(
  state: LoopState,
  pendingToolUses: ToolUseContentBlock[],
  config: ReturnType<typeof getConfig>,
  callbacks: AgentCallbacks,
): Promise<boolean> {
  if (!config.autoFixOnFailure) return false;

  const writtenFiles = pendingToolUses
    .filter((tu) => tu.name === 'write_file' || tu.name === 'edit_file')
    .map((tu) => (tu.input.path || tu.input.file_path) as string)
    .filter(Boolean);

  const eligibleFiles = writtenFiles.filter((f) => (state.autoFixRetriesByFile.get(f) || 0) < config.autoFixMaxRetries);
  if (eligibleFiles.length === 0) return false;

  // Brief delay so language services finish rebuilding their
  // diagnostics for the just-written file. Without this, polling
  // too soon produces stale clean results and auto-fix never fires.
  await new Promise((r) => setTimeout(r, DIAGNOSTICS_SETTLE_DELAY_MS));

  const diagResults = await Promise.allSettled(eligibleFiles.map((f) => getDiagnostics({ path: f })));
  const fileErrors: { file: string; errors: string }[] = [];
  for (let i = 0; i < eligibleFiles.length; i++) {
    const r = diagResults[i];
    if (r.status === 'fulfilled' && r.value.includes('[Error]')) {
      fileErrors.push({ file: eligibleFiles[i], errors: r.value });
    }
  }

  if (fileErrors.length === 0) return false;

  // Bump the per-file retry counter for every file with errors.
  for (const { file } of fileErrors) {
    state.autoFixRetriesByFile.set(file, (state.autoFixRetriesByFile.get(file) || 0) + 1);
  }

  const attemptSummary = fileErrors
    .map(({ file }) => `${file} (${state.autoFixRetriesByFile.get(file)}/${config.autoFixMaxRetries})`)
    .join(', ');
  callbacks.onText(`\n⚠️ Auto-fixing errors: ${attemptSummary}\n`);
  state.messages.push({
    role: 'user',
    content: [
      {
        type: 'text' as const,
        text: `Errors detected after your edits. Please fix them:\n${fileErrors.map((fe) => fe.errors).join('\n')}`,
      },
    ],
  });
  return true;
}
