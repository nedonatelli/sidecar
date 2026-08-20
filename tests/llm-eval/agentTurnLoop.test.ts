import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTurnLoopSession, type TurnLoopInput } from './agentTurnLoop.js';
import type { AgentCallbacks, AgentOptions } from '../../src/agent/loop.js';

// The core both harnesses will share. Tested with the loop injected, so these
// assertions cost milliseconds rather than a live model.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turnloop-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.SIDECAR_AGENT_SEED;
});

const noopCallbacks = {
  onText: () => {},
  onToolCall: () => {},
  onToolResult: () => {},
  onDone: () => {},
} as unknown as AgentCallbacks;

const mk = (over: Partial<TurnLoopInput> = {}): TurnLoopInput => ({
  model: 'gemma4:e4b',
  baseUrl: 'http://localhost:11434',
  apiKey: 'ollama',
  systemPrompt: 'be a coding agent',
  options: { approvalMode: 'autonomous', config: { agentTemperature: 0.2 } } as unknown as AgentOptions,
  callbacks: noopCallbacks,
  timeoutMs: 5_000,
  caseId: 'case1',
  arm: 'bare',
  trial: 0,
  ragOrientationChars: 0,
  logDir: dir,
  loopFn: (async () => {}) as never,
  ...over,
});

describe('createTurnLoopSession', () => {
  it('records the surface from values actually used, not intended', () => {
    process.env.SIDECAR_AGENT_SEED = '1007';
    const s = createTurnLoopSession(mk());
    expect(s.surface).toMatchObject({ systemPromptChars: 17, seed: 1007, temperature: 0.2, ragOrientationChars: 0 });
    expect(Array.isArray(s.surface.toolNames)).toBe(true);
    s.close('natural');
  });

  it('reports the tool catalog a toolOverride actually produces', () => {
    // SWE strips run_tests via toolOverride. Recording the TIER would have
    // claimed run_tests was present when it was not.
    const opts = {
      approvalMode: 'autonomous',
      config: {},
      toolOverride: [{ name: 'read_file' }, { name: 'edit_file' }],
    } as unknown as AgentOptions;
    const s = createTurnLoopSession(mk({ options: opts }));
    expect(s.surface.toolNames).toEqual(['edit_file', 'read_file']);
    s.close('natural');
  });

  it('supports being re-entered for a continuation', async () => {
    // agentHarness answers a clarifying question and re-runs; SWE runs once.
    // The session owns client/abort/logger across both.
    const calls: number[] = [];
    const s = createTurnLoopSession(
      mk({
        loopFn: (async (_c: unknown, m: unknown[]) => {
          calls.push(m.length);
        }) as never,
      }),
    );
    await s.run([{ role: 'user', content: 'a' }]);
    await s.run([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
    expect(calls).toEqual([1, 3]);
    s.close('natural');
  });

  it('marks the run as timed out rather than letting it look like a failure', async () => {
    vi.useFakeTimers();
    try {
      const s = createTurnLoopSession(mk({ timeoutMs: 10 }));
      vi.advanceTimersByTime(20);
      const r = s.close('incomplete');
      expect(r.timedOut).toBe(true);
      expect(s.signal.aborted).toBe(true);
      expect(fs.readFileSync(s.logger!.logPath, 'utf-8')).toMatch(/TERMINATION: incomplete \(TIMEOUT\)/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is safe to close twice', () => {
    const s = createTurnLoopSession(mk());
    const a = s.close('natural');
    const b = s.close('natural');
    expect(a.timedOut).toBe(false);
    expect(b.durationMs).toBeGreaterThanOrEqual(a.durationMs);
  });

  it('writes a trajectory log whose header states what was on', () => {
    const s = createTurnLoopSession(mk({ ragOrientationChars: 4366 }));
    const head = fs.readFileSync(s.logger!.logPath, 'utf-8');
    expect(head).toMatch(/arm=bare/);
    expect(head).toMatch(/rag_orientation: 4366 chars/);
    s.close('natural');
  });

  it('can be run without logging when a caller opts out', () => {
    const s = createTurnLoopSession(mk({ logDir: null }));
    expect(s.logger).toBeNull();
    expect(() => s.close('natural')).not.toThrow();
  });
});
