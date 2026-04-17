import { workspace, Uri } from 'vscode';
import type { SideCarClient } from '../../ollama/client.js';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { AgentLogger } from '../logger.js';
import type { ChangeLog } from '../changelog.js';
import type { getConfig } from '../../config/settings.js';
import {
  CRITIC_SYSTEM_PROMPT,
  buildEditCriticPrompt,
  buildTestFailureCriticPrompt,
  parseCriticResponse,
  splitBySeverity,
  formatFindingsForChat,
  buildCriticInjection,
  type CriticTrigger,
  type CriticFinding,
} from '../critic.js';
import { computeUnifiedDiff } from '../diff.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Adversarial critic — post-turn policy hook.
//
// After each turn with successful edits or failed tests, we fire an
// independent LLM call whose job is to adversarially review the
// agent's work. High-severity findings inject a synthetic user
// message forcing the agent to address them before the turn can
// finish; low-severity findings surface as chat annotations only.
// Disabled by default (`sidecar.critic.enabled`) because it doubles
// the token cost of every editing turn.
//
// This module owns three things that used to live at the bottom of
// loop.ts where they tangled with unrelated dedup / suggestion
// helpers:
//
//   - `runCriticChecks` (the main function — fires the critic for
//     each trigger, parses responses, accumulates blocking findings,
//     returns the synthetic user-message injection or null)
//   - `buildCriticDiff` + `extractAgentIntent` (internal helpers)
//   - `applyCritic` (thin in-loop wrapper — reads config and state,
//     calls runCriticChecks, pushes the injection into history if
//     the critic blocks)
//
// runCriticChecks + RunCriticOptions are re-exported from loop.ts
// so `critic.runner.test.ts` doesn't need a coordinated import
// rewrite.
// ---------------------------------------------------------------------------

const MAX_CRITIC_INJECTIONS_PER_FILE = 2;

/**
 * Session-level counters for critic activity (v0.62.1 p.1b —
 * observability gap flagged in the post-ship audit). Users could
 * tell the critic fired via chat annotations + the agent output
 * channel, but had no way to ask "how many turns did the critic
 * block this session, and why?" These counters power the
 * `SideCar: Show Session Spend` summary so the cost is visible
 * alongside the $ impact.
 *
 * Reset via `resetCriticStats()` whenever the user resets the
 * spend tracker — they're conceptually the same session surface.
 */
interface CriticStats {
  /** Turns the critic injected a blocking message. One per injection,
   *  not per finding — a single injection can carry many findings. */
  blockedTurns: number;
  /** Last-seen blocking reason, truncated for a one-line summary. */
  lastBlockedReason: string;
  /** Total critic LLM calls this session (informational / cost proxy). */
  totalCalls: number;
}

const _criticStats: CriticStats = { blockedTurns: 0, lastBlockedReason: '', totalCalls: 0 };

export function getCriticStats(): Readonly<CriticStats> {
  return { ..._criticStats };
}

export function resetCriticStats(): void {
  _criticStats.blockedTurns = 0;
  _criticStats.lastBlockedReason = '';
  _criticStats.totalCalls = 0;
}

/**
 * Options for `runCriticChecks`. Exported so the integration test at
 * critic.runner.test.ts can build fixtures without dragging in a full
 * runAgentLoop simulation — every dependency the runner touches comes
 * in through this interface.
 */
export interface RunCriticOptions {
  client: SideCarClient;
  config: ReturnType<typeof getConfig>;
  pendingToolUses: ToolUseContentBlock[];
  toolResults: ToolResultContentBlock[];
  changelog: ChangeLog | undefined;
  fullText: string;
  callbacks: AgentCallbacks;
  logger: AgentLogger | undefined;
  signal: AbortSignal;
  criticInjectionsByFile: Map<string, number>;
  maxPerFile: number;
}

/**
 * Run the adversarial critic against the current iteration's edits and any
 * failed test runs. Returns a synthetic user-message string if high-severity
 * findings should block the turn, or null to let the loop continue normally.
 *
 * The critic is opportunistic: any exception (network, parse error, bad
 * model response) is logged and swallowed so the main loop can proceed.
 * Findings are always surfaced to the chat via `onText` regardless of
 * whether they block — users want to see the review even when it's passive.
 */
export async function runCriticChecks(opts: RunCriticOptions): Promise<string | null> {
  const {
    client,
    config,
    pendingToolUses,
    toolResults,
    changelog,
    fullText,
    callbacks,
    logger,
    signal,
    criticInjectionsByFile,
    maxPerFile,
  } = opts;

  // Build the set of triggers: one per successful edit, plus one per
  // failed run_tests. A turn can have multiple triggers — we fire the
  // critic on each independently so per-trigger findings are traceable.
  const triggers: CriticTrigger[] = [];

  // --- Edit triggers ---
  const editedFiles: { filePath: string; diff: string }[] = [];
  for (let i = 0; i < pendingToolUses.length; i++) {
    const tu = pendingToolUses[i];
    const tr = toolResults[i];
    if (!tr || tr.is_error) continue;
    if (tu.name !== 'write_file' && tu.name !== 'edit_file') continue;

    const filePath = (tu.input.path ?? tu.input.file_path) as string | undefined;
    if (!filePath) continue;

    const diff = await buildCriticDiff(filePath, changelog);
    if (!diff) continue;

    editedFiles.push({ filePath, diff });
    triggers.push({
      kind: 'edit',
      filePath,
      diff,
      intent: extractAgentIntent(fullText),
    });
  }

  // --- Test-failure triggers ---
  for (let i = 0; i < pendingToolUses.length; i++) {
    const tu = pendingToolUses[i];
    const tr = toolResults[i];
    if (!tr || !tr.is_error) continue;
    if (tu.name !== 'run_tests') continue;

    triggers.push({
      kind: 'test_failure',
      testOutput: tr.content,
      recentEdits: editedFiles.slice(),
    });
  }

  if (triggers.length === 0) return null;

  // --- Fire the critic for each trigger, collecting findings ---
  const highFindings: CriticFinding[] = [];
  const blockedFiles = new Set<string>();

  for (const trigger of triggers) {
    if (signal.aborted) return null;

    // Per-file injection cap: skip edit triggers whose file has already
    // been blocked twice this turn. Test-failure triggers aren't capped
    // because there's no single "file" to scope them to.
    if (trigger.kind === 'edit') {
      const used = criticInjectionsByFile.get(trigger.filePath) ?? 0;
      if (used >= maxPerFile) {
        logger?.info(`Critic: skipping ${trigger.filePath} — cap reached (${used}/${maxPerFile})`);
        continue;
      }
    }

    let raw: string;
    try {
      const userPrompt =
        trigger.kind === 'edit' ? buildEditCriticPrompt(trigger) : buildTestFailureCriticPrompt(trigger);
      _criticStats.totalCalls += 1;
      raw = await client.completeWithOverrides(
        CRITIC_SYSTEM_PROMPT,
        [{ role: 'user', content: userPrompt }],
        config.criticModel || undefined,
        1024,
        signal,
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return null;
      logger?.warn(`Critic call failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const parsed = parseCriticResponse(raw);
    if (parsed.malformed) {
      logger?.warn(`Critic returned malformed response; skipping this trigger`);
      continue;
    }
    if (parsed.explicitlyClean || parsed.findings.length === 0) continue;

    const { high } = splitBySeverity(parsed.findings);

    // Surface every finding (high + low) to the chat as an annotation.
    // Users want visibility even for passive (non-blocking) reviews.
    const chatText = formatFindingsForChat(parsed.findings, trigger);
    if (chatText) callbacks.onText(chatText);

    // High-severity findings accumulate into the blocking injection iff
    // the config says we should block on them.
    if (config.criticBlockOnHighSeverity && high.length > 0) {
      highFindings.push(...high);
      if (trigger.kind === 'edit') blockedFiles.add(trigger.filePath);
    }
  }

  if (highFindings.length === 0) return null;

  // Increment the per-file injection counter for every file that will be
  // blocked this turn so successive iterations can't re-block indefinitely.
  for (const filePath of blockedFiles) {
    criticInjectionsByFile.set(filePath, (criticInjectionsByFile.get(filePath) ?? 0) + 1);
  }

  // Use the max per-file attempt across blocked files as the "attempt"
  // number in the injection banner — gives the model a sense of urgency
  // on the final retry.
  let attempt = 1;
  for (const filePath of blockedFiles) {
    attempt = Math.max(attempt, criticInjectionsByFile.get(filePath) ?? 1);
  }

  logger?.info(
    `Critic: blocking with ${highFindings.length} high-severity finding(s) across ${blockedFiles.size} file(s), attempt ${attempt}/${maxPerFile}`,
  );

  // Session-level stats for the `SideCar: Show Session Spend` summary.
  // Users flagged this as an observability gap: they couldn't tell
  // how often the critic was blocking or why.
  _criticStats.blockedTurns += 1;
  const reason = highFindings[0]?.title ?? '';
  _criticStats.lastBlockedReason = reason.length > 120 ? reason.slice(0, 120) + '…' : reason;

  return buildCriticInjection(highFindings, attempt, maxPerFile);
}

/**
 * Compute a unified diff for a file that was just written or edited,
 * using the ChangeLog's pre-edit snapshot as the baseline. Falls back to
 * "null → current" (showing the full file as an addition) when no
 * snapshot exists — the critic still sees the content, just without a
 * proper before/after.
 */
async function buildCriticDiff(filePath: string, changelog: ChangeLog | undefined): Promise<string | null> {
  const rootUri = workspace.workspaceFolders?.[0]?.uri;
  if (!rootUri) return null;

  let currentContent: string | null = null;
  try {
    const bytes = await workspace.fs.readFile(Uri.joinPath(rootUri, filePath));
    currentContent = Buffer.from(bytes).toString('utf-8');
  } catch {
    return null; // file disappeared mid-turn
  }

  const snapshot = changelog?.getChanges().find((c) => c.filePath === filePath);
  const originalContent = snapshot?.originalContent ?? null;

  return computeUnifiedDiff(filePath, originalContent, currentContent);
}

/**
 * Extract the agent's stated intent from its most recent text emission.
 * Grabs the first 500 chars of non-empty text so the critic sees what
 * the agent said it was trying to do without burning tokens on the full
 * stream-of-consciousness.
 */
function extractAgentIntent(fullText: string): string | undefined {
  const trimmed = fullText.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
}

/**
 * In-loop wrapper around `runCriticChecks`. Reads config and the
 * critic-enabled flag, runs the critic with state's logger / changelog
 * / criticInjectionsByFile, and pushes the blocking injection into
 * history when the critic returns one. No-op when the critic is
 * disabled or the run is aborted.
 */
export async function applyCritic(
  state: LoopState,
  client: SideCarClient,
  config: ReturnType<typeof getConfig>,
  pendingToolUses: ToolUseContentBlock[],
  toolResults: ToolResultContentBlock[],
  fullText: string,
  callbacks: AgentCallbacks,
  signal: AbortSignal,
): Promise<void> {
  if (!config.criticEnabled || signal.aborted) return;

  const injection = await runCriticChecks({
    client,
    config,
    pendingToolUses,
    toolResults,
    changelog: state.changelog,
    fullText,
    callbacks,
    logger: state.logger,
    signal,
    criticInjectionsByFile: state.criticInjectionsByFile,
    maxPerFile: MAX_CRITIC_INJECTIONS_PER_FILE,
  });

  if (injection) {
    state.messages.push({
      role: 'user',
      content: [{ type: 'text' as const, text: injection }],
    });
  }
}
