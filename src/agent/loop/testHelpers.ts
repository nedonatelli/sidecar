import { vi } from 'vitest';
import type { LoopState } from './state.js';
import type { AgentCallbacks } from '../loop.js';
import type { SideCarConfig } from '../../config/settings.js';
import { EpisodicMemoryStore } from '../episodicMemory.js';

/**
 * Canonical LoopState stub for unit tests. Callers pass only the
 * fields their test cares about; everything else defaults to a safe,
 * zero-valued equivalent. Import this instead of duplicating the
 * ~30-field object in every loop sub-module test file.
 */
export function stubLoopState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    startTime: Date.now(),
    runId: 'test-run',
    config: {} as SideCarConfig,
    maxIterations: 25,
    maxTokens: 100_000,
    approvalMode: 'cautious',
    tools: [],
    logger: undefined,
    changelog: undefined,
    mcpManager: undefined,
    messages: [],
    iteration: 1,
    totalChars: 0,
    unrepairedMalformedCalls: 0,
    degenerateTurns: 0,
    freePlanTurns: 0,
    recentToolCalls: [],
    episodicMemory: new EpisodicMemoryStore(),
    recentNormalizedCalls: [],
    recentWriteTargets: [],
    autoFixRetriesByFile: new Map(),
    fullRewriteCountByFile: new Map(),
    isolateNudgesByFile: new Map(),
    writeHistoryByFile: new Map(),
    circularRewriteBlocksByFile: new Map(),
    writesSinceVerifyByFile: new Map(),
    forceVerifyBeforeBailByFile: new Map(),
    filesEditedViaEditTool: new Set(),
    editFailureSignatures: new Map(),
    bounceCounts: new Map(),
    planRef: { plan: null },
    escalatedRewriteByFile: new Set(),
    editFailureCountByFile: new Map(),
    escalatedEditToWriteByFile: new Set(),
    enforceEditBlocksByFile: new Map(),
    stubFixRetries: 0,
    actionRepromptCount: 0,
    filesReadThisRun: new Set<string>(),
    criticInjectionsByFile: new Map(),
    criticInjectionsByTestHash: new Map(),
    analysisCriticFired: false,
    unappliedEditNudged: false,
    toolCallCounts: new Map(),
    gateState: {} as LoopState['gateState'],
    currentEditPlan: null,
    checkpointFired: false,
    ...overrides,
  };
}

/**
 * AgentCallbacks stub. Every callback is a `vi.fn()` so callers can
 * assert `.toHaveBeenCalledWith()` etc. `onText` additionally pushes
 * each chunk to `result.texts` so tests can read emitted text by
 * index — combining both assertion styles in one helper.
 */
export function stubCallbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks & { texts: string[] } {
  const texts: string[] = [];
  const onText = vi.fn((t: string) => texts.push(t));
  return {
    texts,
    onText,
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
    ...overrides,
  };
}
