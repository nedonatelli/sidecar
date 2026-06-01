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
    recentToolCalls: [],
    episodicMemory: new EpisodicMemoryStore(),
    recentNormalizedCalls: [],
    autoFixRetriesByFile: new Map(),
    stubFixRetries: 0,
    filesReadThisRun: new Set<string>(),
    criticInjectionsByFile: new Map(),
    criticInjectionsByTestHash: new Map(),
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
