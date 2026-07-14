import { workspace, Uri } from 'vscode';
import type { SideCarClient } from '../../ollama/client.js';
import type { ChatMessage } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { AgentLogger } from '../logger.js';
import type { ChangeLog } from '../changelog.js';
import type { getConfig } from '../../config/settings.js';
import {
  CRITIC_SYSTEM_PROMPT,
  ANALYSIS_CRITIC_SYSTEM_PROMPT,
  CRITIC_FINDINGS_SCHEMA,
  buildEditCriticPrompt,
  buildTestFailureCriticPrompt,
  buildAnalysisCriticPrompt,
  parseCriticResponse,
  splitBySeverity,
  formatFindingsForChat,
  buildCriticInjection,
  type CriticTrigger,
  type CriticFinding,
} from '../critic.js';
import { isAnalysisRequest, firstUserText } from '../completionGate.js';
import { computeUnifiedDiff } from '../diff.js';
import type { LoopState } from './state.js';

/** Read-capable tools whose results form the evidence an analysis is judged against. */
const READ_TOOL_NAMES = new Set([
  'read_file',
  'grep',
  'search_files',
  'list_directory',
  'project_knowledge_search',
  'find_references',
]);

/** Cap on a single read-result excerpt folded into the evidence block. */
const MAX_EVIDENCE_PER_RESULT = 4000;

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
  /**
   * Every file the agent edited during the run — reviewed once, at completion.
   * Previously the critic read the CURRENT TURN's tool uses, which is what made
   * it judge half-finished work; see runCriticChecks.
   */
  editedFilePaths: readonly string[];
  changelog: ChangeLog | undefined;
  fullText: string;
  callbacks: AgentCallbacks;
  logger: AgentLogger | undefined;
  signal: AbortSignal;
  criticInjectionsByFile: Map<string, number>;
  maxPerFile: number;
}

/**
 * Run the adversarial critic over the run's COMPLETED work — every file the
 * agent edited, reviewed once, at the point it believes it is finished. Returns
 * a synthetic user-message string if high-severity findings should block, or
 * null to let the loop end normally.
 *
 * ## Why completion, and not after every edit
 *
 * This used to fire in `afterToolResults` — once per successful write_file /
 * edit_file, i.e. after every step. That means it judged HALF-FINISHED WORK. On
 * a multi-file change it reviewed file A alone, mid-refactor, before file B
 * existed, and reported the entirely real "problems" of an incomplete job:
 * dangling references, a helper that isn't called yet, a signature that no
 * caller has been updated for. With blocking on, it then injected those findings
 * as a synthetic user message and sent the agent off to fix a phantom.
 *
 * That is the early-bail signature in the SWE-bench ablation: the critic-bearing
 * arm terminated ~7.5x faster (50s vs 379s) while producing MORE empty patches
 * (20 vs 18) — it made runs give up sooner rather than resolve more. It also
 * explains "doubles API spend": N critic calls per run, one per edit.
 *
 * A critic is supposed to review the work. So it now runs where the work exists:
 * once, at the completion boundary, over the cumulative diff of every edited
 * file. `buildCriticDiff` diffs the file's CURRENT content against the
 * changelog's original snapshot, so at this point each diff is the whole change,
 * not a fragment of it.
 *
 * Failed `run_tests` no longer triggers a critic pass at all. A failing test
 * mid-run is not a finished job either — and "the tests must pass before you may
 * declare done" is the completion gate's job, deterministically, with no model
 * call and no opinion.
 *
 * The critic is opportunistic: any exception (network, parse error, bad model
 * response) is logged and swallowed so the loop can proceed. Findings are always
 * surfaced to the chat via `onText` whether or not they block.
 */
export async function runCriticChecks(opts: RunCriticOptions): Promise<string | null> {
  const {
    client,
    config,
    editedFilePaths,
    changelog,
    fullText,
    callbacks,
    logger,
    signal,
    criticInjectionsByFile,
    maxPerFile,
  } = opts;

  // One trigger per edited file, each carrying that file's cumulative diff.
  // Per-file (rather than one lump) so findings stay traceable to a file, and so
  // the per-file injection cap still applies.
  const triggers: CriticTrigger[] = [];
  for (const filePath of editedFilePaths) {
    const diff = await buildCriticDiff(filePath, changelog);
    if (!diff) continue; // unchanged, or the file is gone
    triggers.push({
      kind: 'edit',
      filePath,
      diff,
      intent: extractAgentIntent(fullText),
    });
  }

  if (triggers.length === 0) return null;

  // --- Fire the critic for each trigger, collecting findings ---
  const highFindings: CriticFinding[] = [];
  const blockedFiles = new Set<string>();

  for (const trigger of triggers) {
    if (signal.aborted) return null;

    // Per-file injection cap: skip edit triggers whose file has
    // already been blocked the max times this run.
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
        trigger.kind === 'edit'
          ? buildEditCriticPrompt(trigger)
          : trigger.kind === 'test_failure'
            ? buildTestFailureCriticPrompt(trigger)
            : buildAnalysisCriticPrompt(trigger);
      _criticStats.totalCalls += 1;

      // Role-Based Model Routing . When a router is
      // attached, a matching `critic` rule wins over the legacy
      // `sidecar.critic.model` override (phase 4e will auto-synthesize
      // rules from that legacy field). When no router is attached the
      // legacy override continues to steer this call verbatim.
      const decision = client.routeForDispatch({ role: 'critic' });
      const modelOverride = decision ? undefined : config.criticModel || undefined;

      raw = await client.completeWithOverrides(
        CRITIC_SYSTEM_PROMPT,
        [{ role: 'user', content: userPrompt }],
        modelOverride,
        1024,
        signal,
        CRITIC_FINDINGS_SCHEMA,
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
  fullText: string,
  callbacks: AgentCallbacks,
  signal: AbortSignal,
): Promise<void> {
  if (!config.criticEnabled || signal.aborted) return;

  // D2 — a weak primary gets no critic at all: it is the SAME small model judging
  // its own work, which doubles latency and cost for a bounded, unproven lift.
  //
  // The broader finding is not about model size. The critic has not demonstrated
  // a benefit at ANY tier, and when it BLOCKS it has demonstrated harm — the
  // SWE-bench arm carrying it terminated ~7.5x faster while producing MORE empty
  // patches, i.e. it made runs bail early rather than resolve more. That is why
  // `critic.blockOnHighSeverity` now defaults false: the critic may observe and
  // annotate, but a model's opinion of another model's work no longer redirects
  // the run. Deterministic checks (completion gate, lint, tests, syntax) block;
  // the critic advises.
  if (state.scaffoldingProfile && !state.scaffoldingProfile.runLlmCritic) {
    state.logger?.info('Critic skipped — weak-tier primary relies on deterministic gate/lint/test (D2)');
    return;
  }

  // Every file edited across the whole run — not just this turn's. The critic
  // reviews finished work, so it needs the finished set.
  const editedFilePaths = [...(state.gateState?.editedFiles ?? [])];
  if (editedFilePaths.length === 0) return;

  const injection = await runCriticChecks({
    client,
    config,
    editedFilePaths,
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

/**
 * Assemble the evidence the agent actually gathered this run: the content of
 * every read/grep/search/PKI tool result, each tagged with the path/query it
 * came from. This is the ground truth the analysis critic judges claims
 * against. Returns an empty string when no read evidence exists.
 */
export function gatherReadEvidence(messages: ChatMessage[]): string {
  // Map tool_use id -> a label from its input (path/query/pattern).
  const labelById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (typeof b !== 'object' || b === null || !('type' in b) || b.type !== 'tool_use') continue;
      const tu = b as { id: string; name: string; input?: Record<string, unknown> };
      if (!READ_TOOL_NAMES.has(tu.name)) continue;
      const input = tu.input ?? {};
      const label = (input.path ?? input.pattern ?? input.query ?? input.file_path ?? tu.name) as string;
      labelById.set(tu.id, `${tu.name}(${label})`);
    }
  }
  if (labelById.size === 0) return '';

  const blocks: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (typeof b !== 'object' || b === null || !('type' in b) || b.type !== 'tool_result') continue;
      const tr = b as { tool_use_id: string; content: string; is_error?: boolean };
      const label = labelById.get(tr.tool_use_id);
      if (!label || tr.is_error || typeof tr.content !== 'string') continue;
      const excerpt =
        tr.content.length > MAX_EVIDENCE_PER_RESULT
          ? tr.content.slice(0, MAX_EVIDENCE_PER_RESULT) + '\n[... truncated ...]'
          : tr.content;
      blocks.push(`### ${label}\n${excerpt}`);
    }
  }
  return blocks.join('\n\n');
}

/**
 * V2 — adversarial analysis critic. Fires once per run on the final answer of
 * an analysis/review turn (no tool calls this turn), fact-checking the answer's
 * claims against the read-evidence the agent gathered. Catches the semantic
 * failures V1's deterministic citation check cannot — a real file mislabeled
 * as something it isn't, a claim contradicted by the code it cites.
 *
 * Gated behind `criticEnabled` (default off), so it ships dark. Like the edit
 * critic it is opportunistic: any error is logged and swallowed.
 */
export async function applyAnalysisCritic(
  state: LoopState,
  client: SideCarClient,
  config: ReturnType<typeof getConfig>,
  fullText: string,
  callbacks: AgentCallbacks,
  signal: AbortSignal,
): Promise<void> {
  if (!config.criticEnabled || signal.aborted) return;
  if (state.analysisCriticFired) return;
  const answer = fullText.trim();
  if (!answer) return;
  if (!isAnalysisRequest(firstUserText(state.messages))) return;

  const evidence = gatherReadEvidence(state.messages);
  if (!evidence) return;

  state.analysisCriticFired = true;
  const trigger: CriticTrigger = { kind: 'analysis', answer, evidence };

  let raw: string;
  try {
    _criticStats.totalCalls += 1;
    const decision = client.routeForDispatch({ role: 'critic' });
    const modelOverride = decision ? undefined : config.criticModel || undefined;
    raw = await client.completeWithOverrides(
      ANALYSIS_CRITIC_SYSTEM_PROMPT,
      [{ role: 'user', content: buildAnalysisCriticPrompt(trigger) }],
      modelOverride,
      1024,
      signal,
      CRITIC_FINDINGS_SCHEMA,
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return;
    state.logger?.warn(`Analysis critic call failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const parsed = parseCriticResponse(raw);
  if (parsed.malformed || parsed.explicitlyClean || parsed.findings.length === 0) return;

  const { high } = splitBySeverity(parsed.findings);
  // Analysis critique is ADVISORY — surface it to the user, never block.
  // Dogfooding showed blocking a read-only review forces the model to "fix" its
  // review against a possibly-wrong critic (the critic's evidence is often
  // incomplete), producing incoherent self-contradicting output. Unlike the
  // edit critic (which blocks bad code from shipping), there's nothing here to
  // protect by blocking — the user reads both the review and the critique.
  const chatText = formatFindingsForChat(parsed.findings, trigger);
  if (chatText) callbacks.onText(chatText);
  if (high.length > 0) {
    _criticStats.lastBlockedReason = (high[0]?.title ?? '').slice(0, 120);
  }
}
