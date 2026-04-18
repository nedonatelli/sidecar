// ---------------------------------------------------------------------------
// Role-Based Model Routing (v0.64).
//
// Each dispatch in SideCar carries a role tag — agent-loop, chat, completion,
// summarize, critic, worker, planner, judge, visual, embed — and the router
// consults an ordered rule list to pick the right model for the job.
// First match wins; a rule can also declare `fallbackModel` for
// budget-aware downgrade (wired in phase 4c).
//
// The `when` clause syntax is deliberately boring — anything smarter invites
// surprises about why a cheap session suddenly escalated. Supported forms:
//
//   "agent-loop"                       role match only
//   "agent-loop.complexity=high"       equals filter
//   "agent-loop.files~=src/physics/**" glob match on file paths
//   "chat.prompt~=/prove\b|think/i"    regex match on prompt text
//   "agent-loop.retryCount>=3"         integer gte
//
// One filter per rule — compound filters aren't in the spec. Use multiple
// rules for AND semantics (first match still wins).
// ---------------------------------------------------------------------------

/**
 * Every dispatch point tags itself with exactly one role. See the
 * roadmap's "Role taxonomy" section for the canonical list.
 */
export type RoutableRole =
  | 'chat'
  | 'agent-loop'
  | 'completion'
  | 'summarize'
  | 'critic'
  | 'worker'
  | 'planner'
  | 'judge'
  | 'visual'
  | 'embed';

export const ROUTABLE_ROLES: readonly RoutableRole[] = [
  'chat',
  'agent-loop',
  'completion',
  'summarize',
  'critic',
  'worker',
  'planner',
  'judge',
  'visual',
  'embed',
] as const;

/**
 * Signals computed at dispatch time and handed to the router. Fields
 * are optional because not every role needs every signal (an `embed`
 * call has no prompt cues or retry count).
 */
export interface RouteSignals {
  role: RoutableRole;
  /**
   * Pre-computed complexity bucket when the caller already knows it. If
   * absent, `computeComplexity()` derives one from `turnCount`,
   * `filesTouched`, `consecutiveToolUseBlocks`, and `prompt`.
   */
  complexity?: 'low' | 'medium' | 'high';
  /** Files the turn has touched so far (for `files~=<glob>` filters). */
  files?: readonly string[];
  /** User prompt text (for `prompt~=<regex>` filters). */
  prompt?: string;
  /** Retry index for the current request. 0 = first attempt. */
  retryCount?: number;
  /** Agent-loop turn counter — fed into the complexity heuristic. */
  turnCount?: number;
  /** Consecutive tool_use content blocks in the last assistant turn. */
  consecutiveToolUseBlocks?: number;
}

/**
 * User-facing rule entry from `sidecar.modelRouting.rules`. Ordered
 * list, first match wins — keep most specific rules at the top.
 */
export interface RoutingRule {
  when: string;
  model: string;
  /**
   * Reserved for v0.64 phase 4c. When a budget cap below is exceeded,
   * the router will return `fallbackModel` instead of `model`. Phase 4a
   * stores the field but does not act on it — set it now if you want
   * config to be forward-compatible.
   */
  fallbackModel?: string;
  /**
   * Reserved for phase 4c. USD caps; any non-undefined value activates
   * budget gating for this rule. `sessionBudget` resets with a new chat
   * session, `dailyBudget` / `hourlyBudget` on clock boundaries.
   */
  sessionBudget?: number;
  dailyBudget?: number;
  hourlyBudget?: number;
}

/**
 * Parsed form of a rule's `when` clause. Kept as a discriminated union
 * so the matcher doesn't re-parse every dispatch.
 */
type ParsedFilter =
  | { kind: 'none' }
  | { kind: 'equals'; key: string; value: string }
  | { kind: 'gte'; key: string; value: number }
  | { kind: 'regex'; key: string; pattern: RegExp }
  | { kind: 'glob'; key: string; pattern: string };

interface ParsedRule {
  role: RoutableRole;
  filter: ParsedFilter;
  model: string;
  fallbackModel?: string;
  sessionBudget?: number;
  dailyBudget?: number;
  hourlyBudget?: number;
  /** Original `when` text for diagnostics / dryRun logging. */
  when: string;
}

/**
 * Thrown by `parseRule` when a rule entry is malformed. The router
 * catches these during construction and falls back to `defaultModel`
 * for the offending rule rather than crashing — a bad rule shouldn't
 * brick the extension.
 */
export class RoutingRuleParseError extends Error {
  constructor(
    public readonly rule: RoutingRule,
    reason: string,
  ) {
    super(`Invalid routing rule ${JSON.stringify(rule.when)}: ${reason}`);
    this.name = 'RoutingRuleParseError';
  }
}

/**
 * Parse a single rule. Exposed for tests; callers should use the
 * router directly. Throws `RoutingRuleParseError` on any structural
 * problem so the router's constructor can log-and-skip.
 */
export function parseRule(rule: RoutingRule): ParsedRule {
  const when = (rule.when ?? '').trim();
  if (!when) throw new RoutingRuleParseError(rule, 'empty `when` clause');

  // Find the first boundary between the role and the filter: `.`
  // belonging to the first filter operator follows the role head.
  // Role itself has no dots, so split on the first dot.
  const dotIdx = when.indexOf('.');
  const role = (dotIdx >= 0 ? when.slice(0, dotIdx) : when) as RoutableRole;
  if (!ROUTABLE_ROLES.includes(role)) {
    throw new RoutingRuleParseError(rule, `unknown role "${role}" — must be one of ${ROUTABLE_ROLES.join(', ')}`);
  }

  let filter: ParsedFilter = { kind: 'none' };
  if (dotIdx >= 0) {
    filter = parseFilterExpression(when.slice(dotIdx + 1), rule);
  }

  if (!rule.model || typeof rule.model !== 'string') {
    throw new RoutingRuleParseError(rule, 'missing `model`');
  }

  return {
    role,
    filter,
    model: rule.model,
    fallbackModel: rule.fallbackModel,
    sessionBudget: rule.sessionBudget,
    dailyBudget: rule.dailyBudget,
    hourlyBudget: rule.hourlyBudget,
    when: rule.when,
  };
}

function parseFilterExpression(expr: string, rule: RoutingRule): ParsedFilter {
  // Pick the LEFTMOST operator in the string, not the first one by
  // priority. The key never contains operators, so the operator closest
  // to the left of the expression is always the real boundary — whereas
  // a priority-based scan would mis-bind on values like
  // `prompt~=/a>=b/i` by matching the `>=` inside the regex payload.
  // Ties at the same position prefer the longer operator (`>=` beats
  // `=`), which only matters for keys that happen to equal another
  // operator's prefix — defensive rather than observed.
  const ops = ['>=', '~=', '='] as const;
  let bestOp: (typeof ops)[number] | null = null;
  let bestIdx = Infinity;
  for (const op of ops) {
    const idx = expr.indexOf(op);
    if (idx < 0) continue;
    if (idx < bestIdx || (idx === bestIdx && op.length > (bestOp?.length ?? 0))) {
      bestOp = op;
      bestIdx = idx;
    }
  }
  if (!bestOp) {
    throw new RoutingRuleParseError(rule, 'filter expression present but no operator (=, ~=, >=) found');
  }

  const op = bestOp;
  const key = expr.slice(0, bestIdx).trim();
  const value = expr.slice(bestIdx + op.length).trim();
  if (!key) throw new RoutingRuleParseError(rule, `filter missing key before ${op}`);
  if (!value) throw new RoutingRuleParseError(rule, `filter missing value after ${op}`);

  if (op === '>=') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new RoutingRuleParseError(rule, `${op} expects an integer, got ${value}`);
    return { kind: 'gte', key, value: n };
  }
  if (op === '~=') {
    // `/pattern/flags` → RegExp; anything else → literal glob.
    if (value.startsWith('/') && value.length > 2) {
      const closeIdx = value.lastIndexOf('/');
      if (closeIdx > 0) {
        const pattern = value.slice(1, closeIdx);
        const flags = value.slice(closeIdx + 1);
        try {
          return { kind: 'regex', key, pattern: new RegExp(pattern, flags) };
        } catch (err) {
          throw new RoutingRuleParseError(rule, `invalid regex: ${(err as Error).message}`);
        }
      }
    }
    return { kind: 'glob', key, pattern: value };
  }
  return { kind: 'equals', key, value };
}

/**
 * Complexity heuristic — kept boring on purpose. See roadmap for rationale.
 * Matches the spec: turnCount ≥ 5 OR filesTouched ≥ 3 OR consecutiveToolUseBlocks ≥ 8
 * OR prompt contains reasoning cues.
 */
const REASONING_CUE_PATTERN = /\b(prove|verify|reason through|think step by step)\b/i;

export function computeComplexity(signals: RouteSignals): 'low' | 'medium' | 'high' {
  if (signals.complexity) return signals.complexity;
  const files = signals.files ? new Set(signals.files).size : 0;
  if (
    (signals.turnCount ?? 0) >= 5 ||
    files >= 3 ||
    (signals.consecutiveToolUseBlocks ?? 0) >= 8 ||
    (signals.prompt ? REASONING_CUE_PATTERN.test(signals.prompt) : false)
  ) {
    return 'high';
  }
  return 'low';
}

/**
 * Glob matcher with `*` and `**` semantics scoped to the substring-level
 * use case we need here (path-like strings). Not a general-purpose glob —
 * just enough to handle patterns like `src/<star><star>/<star>.ts`,
 * `src/physics/<star><star>`, and `<star>.tsx`.
 */
function globMatch(pattern: string, text: string): boolean {
  // Escape regex metacharacters except `*`, then turn `**` into `.*`
  // and single `*` into `[^/]*`. Order matters — `**` first.
  const rx = pattern
    .replace(/[.+^$|()[\]{}\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*');
  return new RegExp('^' + rx + '$').test(text);
}

/**
 * Evaluate a rule's filter against signals. The router walks parsed
 * rules top-to-bottom and returns the first rule whose filter accepts
 * the signal bundle.
 */
function filterAccepts(filter: ParsedFilter, signals: RouteSignals): boolean {
  if (filter.kind === 'none') return true;

  const getValue = (): unknown => {
    switch (filter.key) {
      case 'complexity':
        return computeComplexity(signals);
      case 'files':
        return signals.files;
      case 'prompt':
        return signals.prompt;
      case 'retryCount':
        return signals.retryCount;
      case 'turnCount':
        return signals.turnCount;
      default:
        return undefined;
    }
  };
  const raw = getValue();

  switch (filter.kind) {
    case 'equals':
      return String(raw ?? '') === filter.value;
    case 'gte':
      return typeof raw === 'number' && raw >= filter.value;
    case 'regex':
      if (Array.isArray(raw)) return raw.some((v) => filter.pattern.test(String(v)));
      return filter.pattern.test(String(raw ?? ''));
    case 'glob':
      if (Array.isArray(raw)) return raw.some((v) => globMatch(filter.pattern, String(v)));
      return globMatch(filter.pattern, String(raw ?? ''));
  }
}

/**
 * Decision returned by `route()`. The caller uses `model` to dispatch
 * and can surface `matched.when` in a toast when visibleSwaps is on.
 */
export interface RouteDecision {
  model: string;
  /** The rule that matched, or `null` when the default model was chosen. */
  matched: ParsedRule | null;
  /** True when `model` differs from the prior active model. */
  swap: boolean;
  /**
   * True when this decision downgraded to the matched rule's `fallbackModel`
   * because a budget cap had tripped. `matched` still points at the
   * original rule so callers can report which budget fired.
   */
  downgraded: boolean;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

interface SpendRecord {
  at: number;
  usd: number;
}

interface RuleSpendState {
  sessionTotalUsd: number;
  /** Pruned to at least ONE_DAY_MS ago on every record. */
  records: SpendRecord[];
}

export class ModelRouter {
  private readonly parsed: ParsedRule[];
  private activeModel: string;
  /**
   * Per-rule spend keyed by `ParsedRule` reference. References are
   * stable for the lifetime of this router since parsing happens once
   * in the constructor. A new router (from `refreshModelRouter` on
   * config change) gets a fresh map — rule edits reset budget tracking,
   * which is the only sane default: a user who just edited their rules
   * doesn't want yesterday's spend counting against a newly-introduced
   * cap.
   */
  private ruleSpend = new Map<ParsedRule, RuleSpendState>();

  /**
   * Build a router from raw user-supplied rules. Malformed rules are
   * logged once (to the warnLog callback) and skipped — one bad entry
   * shouldn't take down routing for every other rule.
   */
  constructor(
    rules: readonly RoutingRule[],
    private readonly defaultModel: string,
    warnLog: (message: string) => void = () => void 0,
  ) {
    const parsed: ParsedRule[] = [];
    for (const rule of rules) {
      try {
        parsed.push(parseRule(rule));
      } catch (err) {
        warnLog(err instanceof Error ? err.message : String(err));
      }
    }
    this.parsed = parsed;
    this.activeModel = defaultModel;
  }

  /**
   * Pick a model for the given signals. Never throws — falls back to
   * `defaultModel` if no rule matches. Respects per-rule budget caps:
   * a matching rule whose budget has tripped returns its `fallbackModel`
   * with `downgraded: true`, or (when no fallback is declared) falls
   * through to the next matching rule. The ordered-list-with-fall-through
   * shape means users can chain N downgrade steps by listing rules
   * most-expensive-first and relying on budget exhaustion to walk the
   * list naturally.
   */
  route(signals: RouteSignals): RouteDecision {
    for (const rule of this.parsed) {
      if (rule.role !== signals.role) continue;
      if (!filterAccepts(rule.filter, signals)) continue;

      // Budget check. A rule with no caps is never over-budget, so the
      // common zero-config case short-circuits without state lookups.
      if (this.isRuleOverBudget(rule)) {
        if (rule.fallbackModel) {
          const swap = rule.fallbackModel !== this.activeModel;
          this.activeModel = rule.fallbackModel;
          return { model: rule.fallbackModel, matched: rule, swap, downgraded: true };
        }
        // No fallback — skip this rule so the loop can fall through to
        // the next matching one. Ordered rule lists give the user an
        // implicit downgrade chain without needing explicit fallbacks
        // everywhere.
        continue;
      }

      const swap = rule.model !== this.activeModel;
      this.activeModel = rule.model;
      return { model: rule.model, matched: rule, swap, downgraded: false };
    }
    const swap = this.defaultModel !== this.activeModel;
    this.activeModel = this.defaultModel;
    return { model: this.defaultModel, matched: null, swap, downgraded: false };
  }

  /**
   * Charge spend against a rule after a dispatch completes. Usage
   * sources that don't have pricing info (local Ollama, unknown
   * providers) should pass `0` — the router treats that as a no-op so
   * budgets don't mis-trip for untracked spend.
   */
  recordSpend(rule: ParsedRule, usd: number): void {
    if (usd <= 0) return;
    const state = this.ruleSpend.get(rule) ?? { sessionTotalUsd: 0, records: [] };
    state.sessionTotalUsd += usd;
    state.records.push({ at: Date.now(), usd });
    // Prune records older than the longest window we ever check (24h).
    // `sessionTotalUsd` grows independently so this cleanup stays cheap
    // and bounded even on long-lived sessions.
    const cutoff = Date.now() - ONE_DAY_MS;
    while (state.records.length > 0 && state.records[0].at < cutoff) {
      state.records.shift();
    }
    this.ruleSpend.set(rule, state);
  }

  /**
   * True when at least one declared budget on the rule has been
   * exceeded. Windowed caps (`dailyBudget`, `hourlyBudget`) sum only
   * the spend records within their window; `sessionBudget` uses the
   * cumulative session total.
   */
  isRuleOverBudget(rule: ParsedRule): boolean {
    if (rule.sessionBudget === undefined && rule.dailyBudget === undefined && rule.hourlyBudget === undefined) {
      return false;
    }
    const state = this.ruleSpend.get(rule);
    if (!state) return false;

    if (rule.sessionBudget !== undefined && state.sessionTotalUsd >= rule.sessionBudget) return true;

    if (rule.dailyBudget !== undefined || rule.hourlyBudget !== undefined) {
      const now = Date.now();
      let hourlyUsd = 0;
      let dailyUsd = 0;
      for (const record of state.records) {
        if (record.at > now - ONE_HOUR_MS) hourlyUsd += record.usd;
        if (record.at > now - ONE_DAY_MS) dailyUsd += record.usd;
      }
      if (rule.dailyBudget !== undefined && dailyUsd >= rule.dailyBudget) return true;
      if (rule.hourlyBudget !== undefined && hourlyUsd >= rule.hourlyBudget) return true;
    }

    return false;
  }

  /** Read-only accessor for parsed rules — useful for diagnostics / tests. */
  getRules(): readonly ParsedRule[] {
    return this.parsed;
  }

  /** Current active model (last returned by `route`). */
  getActiveModel(): string {
    return this.activeModel;
  }

  /**
   * Align the router's swap-tracking state with an external active
   * model. Called right after `setRouter` on a SideCarClient so the
   * first dispatch doesn't produce a spurious `swap=true` when the
   * resolved model already matches what the client is using.
   */
  setInitialActiveModel(model: string): void {
    this.activeModel = model;
  }

  /** Introspect accumulated session spend against a rule. Exposed for the status-bar tooltip (phase 4d) and tests. */
  getRuleSpendUsd(rule: ParsedRule): number {
    return this.ruleSpend.get(rule)?.sessionTotalUsd ?? 0;
  }

  /**
   * One-shot "should I notify the user about this rule's downgrade?"
   * check. Returns `true` the first time it's called for a rule, then
   * `false` for every subsequent call against the same rule — so
   * `applyAgentLoopRouting` can fire exactly one toast per budget cap
   * instead of one per turn once the downgrade is sticky.
   */
  claimDowngradeNotification(rule: ParsedRule): boolean {
    if (this.notifiedDowngrades.has(rule)) return false;
    this.notifiedDowngrades.add(rule);
    return true;
  }

  private notifiedDowngrades = new Set<ParsedRule>();
}

/**
 * Shape of the settings fields this module needs. Narrower than the
 * full `SideCarConfig` so `buildRouterFromConfig` can be unit-tested
 * without dragging in the whole workspace-settings machinery.
 *
 * The legacy per-role fields (`completionModel` / `criticModel` /
 * `delegateTaskWorkerModel`) are read by `synthesizeLegacyRules` and
 * auto-translated into routing rules at router-build time. Users who
 * enable routing without rewriting their settings get sensible defaults
 * for free, and users who opt-in with explicit rules override the
 * synthesized ones by first-match-wins priority.
 */
export interface RouterConfigSlice {
  modelRoutingEnabled: boolean;
  modelRoutingRules: RoutingRule[];
  modelRoutingDefaultModel: string;
  /** Falls back to this when `modelRoutingDefaultModel` is empty. */
  model: string;
  /** Legacy — translates into a synthesized `completion` rule. */
  completionModel?: string;
  /** Legacy — translates into a synthesized `critic` rule. */
  criticModel?: string;
  /** Legacy — translates into a synthesized `worker` rule. */
  delegateTaskWorkerModel?: string;
}

/**
 * Build a router from the `modelRouting.*` slice of SideCarConfig, or
 * return `null` when routing is disabled. User-declared rules appear
 * first; legacy per-role settings are appended as synthesized rules
 * so explicit user rules win on first-match. Malformed rules are
 * logged via `console.warn` — the router itself already does
 * log-and-skip so this is just the default sink.
 */
export function buildRouterFromConfig(config: RouterConfigSlice): ModelRouter | null {
  if (!config.modelRoutingEnabled) return null;
  const defaultModel = config.modelRoutingDefaultModel || config.model;
  const allRules = [...config.modelRoutingRules, ...synthesizeLegacyRules(config)];
  return new ModelRouter(allRules, defaultModel, (msg) => {
    console.warn(`[SideCar modelRouting] ${msg}`);
  });
}

/**
 * Translate non-default per-role settings (`sidecar.completionModel`,
 * `sidecar.critic.model`, `sidecar.delegateTask.workerModel`) into
 * `RoutingRule[]` entries. Users upgrading to v0.64 who had these set
 * shouldn't have to re-express them in `sidecar.modelRouting.rules`;
 * enabling routing auto-propagates their existing preferences.
 *
 * Exported for direct testing — `buildRouterFromConfig` is the
 * production caller.
 */
export function synthesizeLegacyRules(config: RouterConfigSlice): RoutingRule[] {
  const rules: RoutingRule[] = [];
  if (config.completionModel && config.completionModel.trim().length > 0) {
    rules.push({ when: 'completion', model: config.completionModel });
  }
  if (config.criticModel && config.criticModel.trim().length > 0) {
    rules.push({ when: 'critic', model: config.criticModel });
  }
  if (config.delegateTaskWorkerModel && config.delegateTaskWorkerModel.trim().length > 0) {
    rules.push({ when: 'worker', model: config.delegateTaskWorkerModel });
  }
  return rules;
}
