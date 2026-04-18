import { describe, it, expect, vi } from 'vitest';
import {
  ModelRouter,
  parseRule,
  computeComplexity,
  buildRouterFromConfig,
  synthesizeLegacyRules,
  RoutingRuleParseError,
  type RoutingRule,
  type RouteSignals,
} from './modelRouter.js';

describe('parseRule', () => {
  it('accepts a bare role as a role-only match', () => {
    const parsed = parseRule({ when: 'agent-loop', model: 'claude-sonnet-4-6' });
    expect(parsed.role).toBe('agent-loop');
    expect(parsed.filter).toEqual({ kind: 'none' });
  });

  it('parses an equals filter', () => {
    const parsed = parseRule({ when: 'agent-loop.complexity=high', model: 'claude-opus-4-6' });
    expect(parsed.filter).toEqual({ kind: 'equals', key: 'complexity', value: 'high' });
  });

  it('parses a >= filter as a number', () => {
    const parsed = parseRule({ when: 'agent-loop.retryCount>=3', model: 'claude-sonnet-4-6' });
    expect(parsed.filter).toEqual({ kind: 'gte', key: 'retryCount', value: 3 });
  });

  it('parses ~= /regex/flags as a compiled RegExp', () => {
    const parsed = parseRule({ when: 'chat.prompt~=/prove\\b|think hard/i', model: 'claude-opus-4-6' });
    expect(parsed.filter.kind).toBe('regex');
    if (parsed.filter.kind === 'regex') {
      expect(parsed.filter.pattern.test('prove that')).toBe(true);
      expect(parsed.filter.pattern.test('THINK HARD about it')).toBe(true);
      expect(parsed.filter.pattern.test('normal question')).toBe(false);
    }
  });

  it('parses ~= <literal> as a glob', () => {
    const parsed = parseRule({ when: 'agent-loop.files~=src/physics/**', model: 'claude-opus-4-6' });
    expect(parsed.filter).toEqual({ kind: 'glob', key: 'files', pattern: 'src/physics/**' });
  });

  it('throws on unknown role', () => {
    expect(() => parseRule({ when: 'bogus-role', model: 'x' })).toThrow(RoutingRuleParseError);
    expect(() => parseRule({ when: 'bogus-role.complexity=high', model: 'x' })).toThrow(/unknown role/);
  });

  it('throws on empty when clause', () => {
    expect(() => parseRule({ when: '', model: 'x' })).toThrow(/empty/);
    expect(() => parseRule({ when: '   ', model: 'x' })).toThrow(/empty/);
  });

  it('throws on missing model', () => {
    expect(() => parseRule({ when: 'chat', model: '' })).toThrow(/missing.*model/);
  });

  it('throws on invalid regex body', () => {
    expect(() => parseRule({ when: 'chat.prompt~=/[unclosed/i', model: 'x' })).toThrow(/invalid regex/);
  });

  it('throws when a dotted filter has no operator', () => {
    expect(() => parseRule({ when: 'chat.prompt', model: 'x' })).toThrow(/no operator/);
  });

  it('binds on the LEFTMOST operator so operators inside regex values are not mis-parsed', () => {
    // A priority-based parser would hit the `>=` inside the regex
    // payload before the real `~=` boundary — this test pins the
    // leftmost-wins rule.
    const parsed = parseRule({ when: 'chat.prompt~=/a>=b/i', model: 'x' });
    expect(parsed.filter.kind).toBe('regex');
    if (parsed.filter.kind === 'regex') {
      expect(parsed.filter.pattern.test('a>=b')).toBe(true);
    }
  });

  it('binds on the leftmost `=` for simple equals even when the value contains operators', () => {
    // `complexity=high` has `=` at position 10. A value like `a>=b`
    // lives entirely on the right of that `=`.
    const parsed = parseRule({ when: 'agent-loop.label=a>=b', model: 'x' });
    expect(parsed.filter).toEqual({ kind: 'equals', key: 'label', value: 'a>=b' });
  });
});

describe('computeComplexity', () => {
  it('returns low for an empty signal bundle', () => {
    expect(computeComplexity({ role: 'agent-loop' })).toBe('low');
  });

  it('returns high when turnCount >= 5', () => {
    expect(computeComplexity({ role: 'agent-loop', turnCount: 5 })).toBe('high');
    expect(computeComplexity({ role: 'agent-loop', turnCount: 4 })).toBe('low');
  });

  it('returns high when distinct files >= 3', () => {
    expect(computeComplexity({ role: 'agent-loop', files: ['a.ts', 'b.ts', 'c.ts'] })).toBe('high');
    expect(computeComplexity({ role: 'agent-loop', files: ['a.ts', 'a.ts', 'b.ts'] })).toBe('low');
  });

  it('returns high when consecutive tool_use blocks >= 8', () => {
    expect(computeComplexity({ role: 'agent-loop', consecutiveToolUseBlocks: 8 })).toBe('high');
    expect(computeComplexity({ role: 'agent-loop', consecutiveToolUseBlocks: 7 })).toBe('low');
  });

  it('returns high when the prompt contains reasoning cues', () => {
    expect(computeComplexity({ role: 'chat', prompt: 'prove this theorem' })).toBe('high');
    expect(computeComplexity({ role: 'chat', prompt: 'Please THINK STEP BY STEP' })).toBe('high');
    expect(computeComplexity({ role: 'chat', prompt: 'just a casual hello' })).toBe('low');
  });

  it('passes through explicit complexity when provided', () => {
    expect(computeComplexity({ role: 'agent-loop', complexity: 'medium', turnCount: 100 })).toBe('medium');
  });
});

describe('ModelRouter.route', () => {
  const rules: RoutingRule[] = [
    { when: 'agent-loop.complexity=high', model: 'claude-opus-4-6' },
    { when: 'agent-loop', model: 'claude-sonnet-4-6' },
    { when: 'chat.prompt~=/prove\\b/i', model: 'claude-opus-4-6' },
    { when: 'chat', model: 'ollama/llama3:70b' },
    { when: 'completion', model: 'ollama/qwen2.5-coder:7b' },
    { when: 'summarize', model: 'claude-haiku-4-5' },
    { when: 'agent-loop.retryCount>=3', model: 'claude-opus-4-6' },
    { when: 'agent-loop.files~=src/physics/**', model: 'claude-opus-4-6' },
  ];

  it('uses the first matching rule (most specific first)', () => {
    const router = new ModelRouter(rules, 'ollama/qwen3-coder:30b');
    const signal: RouteSignals = { role: 'agent-loop', turnCount: 10 };
    expect(router.route(signal).model).toBe('claude-opus-4-6');
  });

  it('falls through to a less-specific role match', () => {
    const router = new ModelRouter(rules, 'ollama/qwen3-coder:30b');
    expect(router.route({ role: 'agent-loop', turnCount: 1 }).model).toBe('claude-sonnet-4-6');
  });

  it('falls through to the default model when no rule matches', () => {
    const router = new ModelRouter(rules, 'ollama/qwen3-coder:30b');
    const d = router.route({ role: 'embed' });
    expect(d.model).toBe('ollama/qwen3-coder:30b');
    expect(d.matched).toBeNull();
  });

  it('matches a regex filter on prompt text', () => {
    const router = new ModelRouter(rules, 'ollama/qwen3-coder:30b');
    expect(router.route({ role: 'chat', prompt: 'Please prove Fermat' }).model).toBe('claude-opus-4-6');
    expect(router.route({ role: 'chat', prompt: 'what is the weather' }).model).toBe('ollama/llama3:70b');
  });

  it('matches a gte filter on retryCount', () => {
    const router = new ModelRouter([{ when: 'agent-loop.retryCount>=3', model: 'escalate' }], 'base');
    expect(router.route({ role: 'agent-loop', retryCount: 3 }).model).toBe('escalate');
    expect(router.route({ role: 'agent-loop', retryCount: 2 }).model).toBe('base');
  });

  it('matches a glob filter on the files array (any file)', () => {
    const router = new ModelRouter([{ when: 'agent-loop.files~=src/physics/**', model: 'physics-specialist' }], 'base');
    expect(router.route({ role: 'agent-loop', files: ['src/physics/fft.ts'] }).model).toBe('physics-specialist');
    expect(router.route({ role: 'agent-loop', files: ['src/ui/button.ts'] }).model).toBe('base');
  });

  it('flags swap=true when the decision changes the active model', () => {
    const router = new ModelRouter(rules, 'default-model');
    const first = router.route({ role: 'chat', prompt: 'hello' });
    expect(first.swap).toBe(true);
    const second = router.route({ role: 'chat', prompt: 'hello again' });
    expect(second.swap).toBe(false);
    const third = router.route({ role: 'summarize' });
    expect(third.swap).toBe(true);
  });

  it('logs and skips malformed rules without breaking valid ones', () => {
    const warn = vi.fn();
    const router = new ModelRouter(
      [
        { when: 'not-a-role', model: 'oops' },
        { when: '', model: 'also-oops' },
        { when: 'chat', model: 'good-model' },
      ],
      'default',
      warn,
    );
    expect(warn).toHaveBeenCalledTimes(2);
    expect(router.route({ role: 'chat' }).model).toBe('good-model');
  });

  it('getRules returns only successfully parsed rules', () => {
    const router = new ModelRouter(
      [
        { when: 'chat', model: 'a' },
        { when: 'bogus', model: 'b' },
      ],
      'default',
    );
    expect(router.getRules()).toHaveLength(1);
    expect(router.getRules()[0].role).toBe('chat');
  });

  it('getActiveModel reflects the most recent route() decision', () => {
    const router = new ModelRouter(rules, 'default');
    expect(router.getActiveModel()).toBe('default');
    router.route({ role: 'chat', prompt: 'hi' });
    expect(router.getActiveModel()).toBe('ollama/llama3:70b');
    router.route({ role: 'summarize' });
    expect(router.getActiveModel()).toBe('claude-haiku-4-5');
  });
});

describe('ModelRouter — glob matcher edge cases', () => {
  it('matches `**` across path separators', () => {
    const router = new ModelRouter([{ when: 'agent-loop.files~=src/**/*.ts', model: 'ts-specialist' }], 'base');
    expect(router.route({ role: 'agent-loop', files: ['src/config/settings.ts'] }).model).toBe('ts-specialist');
    expect(router.route({ role: 'agent-loop', files: ['src/a/b/c/deep.ts'] }).model).toBe('ts-specialist');
  });

  it('uses `*` as single-segment wildcard', () => {
    const router = new ModelRouter([{ when: 'agent-loop.files~=*.tsx', model: 'tsx-specialist' }], 'base');
    expect(router.route({ role: 'agent-loop', files: ['button.tsx'] }).model).toBe('tsx-specialist');
    expect(router.route({ role: 'agent-loop', files: ['src/button.tsx'] }).model).toBe('base');
  });
});

describe('ModelRouter.setInitialActiveModel', () => {
  it('suppresses swap=true on the first route() when the chosen model matches the client state', () => {
    const router = new ModelRouter([{ when: 'chat', model: 'claude-sonnet-4-6' }], 'ollama/qwen3-coder:30b');
    // Pretend the client was already on sonnet before the router was attached.
    router.setInitialActiveModel('claude-sonnet-4-6');
    const decision = router.route({ role: 'chat' });
    expect(decision.model).toBe('claude-sonnet-4-6');
    expect(decision.swap).toBe(false);
  });

  it('still reports swap=true when the initial state differs from the first route choice', () => {
    const router = new ModelRouter([{ when: 'chat', model: 'claude-sonnet-4-6' }], 'ollama/qwen3-coder:30b');
    router.setInitialActiveModel('ollama/qwen3-coder:30b');
    const decision = router.route({ role: 'chat' });
    expect(decision.swap).toBe(true);
  });
});

describe('ModelRouter — budget-aware downgrade', () => {
  it('uses fallbackModel when sessionBudget is exceeded', () => {
    const router = new ModelRouter(
      [{ when: 'agent-loop', model: 'opus', fallbackModel: 'haiku', sessionBudget: 1.0 }],
      'default',
    );
    router.setInitialActiveModel('default');

    const first = router.route({ role: 'agent-loop' });
    expect(first.model).toBe('opus');
    expect(first.downgraded).toBe(false);

    // Charge $1.50 against the matched rule — exceeds the $1.00 cap.
    router.recordSpend(first.matched!, 1.5);

    const second = router.route({ role: 'agent-loop' });
    expect(second.model).toBe('haiku');
    expect(second.downgraded).toBe(true);
    expect(second.matched?.model).toBe('opus'); // `matched` still points at the original rule
  });

  it('falls through to the next matching rule when over-budget and no fallbackModel is set', () => {
    const router = new ModelRouter(
      [
        { when: 'agent-loop', model: 'opus', sessionBudget: 0.5 }, // capped, no fallback
        { when: 'agent-loop', model: 'sonnet' }, // catches the fall-through
      ],
      'default',
    );
    const first = router.route({ role: 'agent-loop' });
    expect(first.model).toBe('opus');
    router.recordSpend(first.matched!, 1.0);

    const second = router.route({ role: 'agent-loop' });
    expect(second.model).toBe('sonnet');
    expect(second.downgraded).toBe(false); // second rule matched cleanly
    expect(second.matched?.model).toBe('sonnet');
  });

  it('falls through to defaultModel when every matching rule is over-budget without a fallback', () => {
    const router = new ModelRouter(
      [
        { when: 'agent-loop', model: 'opus', sessionBudget: 0.5 },
        { when: 'agent-loop', model: 'sonnet', sessionBudget: 0.5 },
      ],
      'ollama/qwen3-coder:30b',
    );
    const rule1 = router.route({ role: 'agent-loop' });
    router.recordSpend(rule1.matched!, 1.0);
    const rule2 = router.route({ role: 'agent-loop' });
    router.recordSpend(rule2.matched!, 1.0);
    const third = router.route({ role: 'agent-loop' });
    expect(third.model).toBe('ollama/qwen3-coder:30b');
    expect(third.matched).toBeNull();
  });

  it('rules with no budget caps are never considered over-budget regardless of recorded spend', () => {
    const router = new ModelRouter([{ when: 'agent-loop', model: 'opus' }], 'default');
    const decision = router.route({ role: 'agent-loop' });
    router.recordSpend(decision.matched!, 1_000); // huge spend, but no cap declared
    expect(router.route({ role: 'agent-loop' }).model).toBe('opus');
    expect(router.route({ role: 'agent-loop' }).downgraded).toBe(false);
  });

  it('honors hourlyBudget independently of sessionBudget', () => {
    const router = new ModelRouter(
      [{ when: 'summarize', model: 'sonnet', fallbackModel: 'haiku', hourlyBudget: 0.25 }],
      'default',
    );
    const first = router.route({ role: 'summarize' });
    router.recordSpend(first.matched!, 0.3); // above hourly cap
    const second = router.route({ role: 'summarize' });
    expect(second.model).toBe('haiku');
    expect(second.downgraded).toBe(true);
  });

  it('honors dailyBudget independently of hourlyBudget', () => {
    const router = new ModelRouter(
      [{ when: 'summarize', model: 'sonnet', fallbackModel: 'haiku', dailyBudget: 1.0 }],
      'default',
    );
    const first = router.route({ role: 'summarize' });
    router.recordSpend(first.matched!, 1.5);
    const second = router.route({ role: 'summarize' });
    expect(second.model).toBe('haiku');
    expect(second.downgraded).toBe(true);
  });

  it('recordSpend ignores non-positive usd (untracked providers)', () => {
    const router = new ModelRouter(
      [{ when: 'agent-loop', model: 'opus', sessionBudget: 0.01, fallbackModel: 'haiku' }],
      'default',
    );
    const decision = router.route({ role: 'agent-loop' });
    router.recordSpend(decision.matched!, 0); // ollama dispatch, no billing
    router.recordSpend(decision.matched!, -1); // defensive — never from real code
    expect(router.isRuleOverBudget(decision.matched!)).toBe(false);
    expect(router.route({ role: 'agent-loop' }).model).toBe('opus');
  });

  it('getRuleSpendUsd surfaces the running session total', () => {
    const router = new ModelRouter([{ when: 'agent-loop', model: 'opus' }], 'default');
    const decision = router.route({ role: 'agent-loop' });
    expect(router.getRuleSpendUsd(decision.matched!)).toBe(0);
    router.recordSpend(decision.matched!, 0.42);
    router.recordSpend(decision.matched!, 0.58);
    expect(router.getRuleSpendUsd(decision.matched!)).toBeCloseTo(1.0, 2);
  });

  it('builds an implicit chain via multiple rules when each declares its own budget', () => {
    // opus → sonnet → haiku → default. User expresses this as three
    // rules, each with its own sessionBudget. As spend accrues, the
    // next dispatch falls through to the next rule naturally.
    const router = new ModelRouter(
      [
        { when: 'agent-loop', model: 'opus', sessionBudget: 0.5 },
        { when: 'agent-loop', model: 'sonnet', sessionBudget: 0.5 },
        { when: 'agent-loop', model: 'haiku', sessionBudget: 0.5 },
      ],
      'ollama/qwen3-coder:30b',
    );

    const d1 = router.route({ role: 'agent-loop' });
    expect(d1.model).toBe('opus');
    router.recordSpend(d1.matched!, 1.0);

    const d2 = router.route({ role: 'agent-loop' });
    expect(d2.model).toBe('sonnet');
    router.recordSpend(d2.matched!, 1.0);

    const d3 = router.route({ role: 'agent-loop' });
    expect(d3.model).toBe('haiku');
    router.recordSpend(d3.matched!, 1.0);

    const d4 = router.route({ role: 'agent-loop' });
    expect(d4.model).toBe('ollama/qwen3-coder:30b');
    expect(d4.matched).toBeNull();
  });
});

describe('buildRouterFromConfig', () => {
  it('returns null when modelRouting is disabled', () => {
    const router = buildRouterFromConfig({
      modelRoutingEnabled: false,
      modelRoutingRules: [{ when: 'chat', model: 'whatever' }],
      modelRoutingDefaultModel: '',
      model: 'ollama/qwen3-coder:30b',
    });
    expect(router).toBeNull();
  });

  it('builds a router with the configured rules + default model when enabled', () => {
    const router = buildRouterFromConfig({
      modelRoutingEnabled: true,
      modelRoutingRules: [{ when: 'chat', model: 'claude-haiku-4-5' }],
      modelRoutingDefaultModel: 'default-override',
      model: 'ollama/qwen3-coder:30b',
    });
    expect(router).not.toBeNull();
    expect(router!.route({ role: 'chat' }).model).toBe('claude-haiku-4-5');
    expect(router!.route({ role: 'embed' }).model).toBe('default-override');
  });

  it('falls back to config.model when modelRoutingDefaultModel is empty', () => {
    const router = buildRouterFromConfig({
      modelRoutingEnabled: true,
      modelRoutingRules: [],
      modelRoutingDefaultModel: '',
      model: 'ollama/qwen3-coder:30b',
    });
    expect(router!.route({ role: 'embed' }).model).toBe('ollama/qwen3-coder:30b');
  });
});

describe('synthesizeLegacyRules (v0.64 phase 4e)', () => {
  it('returns an empty list when no legacy fields are set', () => {
    expect(
      synthesizeLegacyRules({
        modelRoutingEnabled: true,
        modelRoutingRules: [],
        modelRoutingDefaultModel: '',
        model: 'base',
      }),
    ).toEqual([]);
  });

  it('translates completionModel / criticModel / delegateTaskWorkerModel into their respective role rules', () => {
    const rules = synthesizeLegacyRules({
      modelRoutingEnabled: true,
      modelRoutingRules: [],
      modelRoutingDefaultModel: '',
      model: 'base',
      completionModel: 'ollama/qwen2.5-coder:7b',
      criticModel: 'claude-haiku-4-5',
      delegateTaskWorkerModel: 'ollama/qwen3-coder:30b',
    });
    expect(rules).toEqual([
      { when: 'completion', model: 'ollama/qwen2.5-coder:7b' },
      { when: 'critic', model: 'claude-haiku-4-5' },
      { when: 'worker', model: 'ollama/qwen3-coder:30b' },
    ]);
  });

  it('treats empty / whitespace-only strings as "not set"', () => {
    expect(
      synthesizeLegacyRules({
        modelRoutingEnabled: true,
        modelRoutingRules: [],
        modelRoutingDefaultModel: '',
        model: 'base',
        completionModel: '',
        criticModel: '   ',
        delegateTaskWorkerModel: '',
      }),
    ).toEqual([]);
  });
});

describe('buildRouterFromConfig — legacy migration (v0.64 phase 4e)', () => {
  it('appends synthesized legacy rules after user-declared ones so user rules win first-match', () => {
    const router = buildRouterFromConfig({
      modelRoutingEnabled: true,
      modelRoutingRules: [{ when: 'critic', model: 'user-preferred-critic' }],
      modelRoutingDefaultModel: '',
      model: 'ollama/qwen3-coder:30b',
      criticModel: 'legacy-critic',
      completionModel: 'legacy-completion',
    });
    expect(router).not.toBeNull();

    // User's explicit critic rule wins.
    expect(router!.route({ role: 'critic' }).model).toBe('user-preferred-critic');

    // Legacy completion rule still applies — user didn't override it.
    expect(router!.route({ role: 'completion' }).model).toBe('legacy-completion');
  });

  it('routing disabled => null regardless of legacy settings', () => {
    expect(
      buildRouterFromConfig({
        modelRoutingEnabled: false,
        modelRoutingRules: [],
        modelRoutingDefaultModel: '',
        model: 'base',
        completionModel: 'x',
        criticModel: 'y',
      }),
    ).toBeNull();
  });

  it('with no user rules and only legacy fields, routes every role via synthesized rules', () => {
    const router = buildRouterFromConfig({
      modelRoutingEnabled: true,
      modelRoutingRules: [],
      modelRoutingDefaultModel: '',
      model: 'ollama/qwen3-coder:30b',
      completionModel: 'ollama/qwen2.5-coder:7b',
      criticModel: 'claude-haiku-4-5',
      delegateTaskWorkerModel: 'ollama/qwen3-coder:30b',
    });
    expect(router!.route({ role: 'completion' }).model).toBe('ollama/qwen2.5-coder:7b');
    expect(router!.route({ role: 'critic' }).model).toBe('claude-haiku-4-5');
    expect(router!.route({ role: 'worker' }).model).toBe('ollama/qwen3-coder:30b');
    expect(router!.route({ role: 'agent-loop' }).model).toBe('ollama/qwen3-coder:30b'); // default
  });
});
