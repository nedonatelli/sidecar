import { describe, it, expect, vi, afterEach } from 'vitest';
import { runAgentLoop } from './loop.js';
import { getConfig } from '../config/settings.js';
import { baseToolBudget } from './loop/toolBudget.js';
import type { StreamEvent, ToolDefinition } from '../ollama/types.js';
import type { SideCarClient } from '../ollama/client.js';
import type { AgentCallbacks } from './loop.js';

// run_command has to be in the catalog for the test to see it withdrawn
// (extraTools run, but are not offered).
const { shellDef } = vi.hoisted(() => ({
  shellDef: {
    name: 'run_command',
    description: 'run a shell command',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
}));

vi.mock('./tools.js', () => ({
  getToolDefinitions: () => [shellDef],
  getToolDefinitionsForTier: () => [shellDef],
  getDiagnostics: async () => 'No diagnostics',
}));

// #510: SWE cells set SIDECAR_DISABLE_CYCLE_DETECTION, and the budget stop
// (#268) lived inside cycle detection, so nothing ended a run whose model kept
// calling a spent tool: nemotron-3.5-lightning:30b did it until the iteration
// cap. A model that only ever calls run_command, here with cycle detection
// off: the tool is withdrawn from the catalog at its 3rd refusal, and the run
// stops when the model calls it anyway.

afterEach(() => {
  delete process.env.SIDECAR_DISABLE_CYCLE_DETECTION;
});

async function runCommandForever(cycleDetectionOff: boolean) {
  if (cycleDetectionOff) process.env.SIDECAR_DISABLE_CYCLE_DETECTION = 'true';
  let turn = 0;
  const offered: string[][] = [];
  const client = {
    async *streamChat(_m: unknown, _s: unknown, tools?: ToolDefinition[]): AsyncGenerator<StreamEvent> {
      turn++;
      offered.push((tools ?? []).map((t) => t.name));
      const toolUse = {
        type: 'tool_use',
        id: `c${turn}`,
        name: 'run_command',
        input: { command: `pytest -k t${turn}` },
      };
      yield { type: 'tool_use', toolUse } as StreamEvent;
      yield { type: 'stop', stopReason: 'tool_use' };
    },
    getSystemPrompt: () => '',
    getRouter: () => null,
    getModel: () => 'mock-model',
  } as unknown as SideCarClient;
  let ran = 0;
  const shell = {
    definition: shellDef,
    requiresApproval: false,
    executor: async () => {
      ran++;
      return '(exit code: 1)';
    },
  };
  const texts: string[] = [];
  let stoppedOnTurn = 0;
  const callbacks: AgentCallbacks = {
    onText: (t) => {
      texts.push(t);
      if (t.includes('Agent stopped') && !stoppedOnTurn) stoppedOnTurn = turn;
    },
    onToolCall: () => {},
    onToolResult: () => {},
    onDone: () => {},
  };
  await runAgentLoop(client, [{ role: 'user', content: 'fix the bug' }], callbacks, new AbortController().signal, {
    extraTools: [shell] as never,
    approvalMode: 'autonomous',
    maxIterations: 60,
    config: { ...getConfig(), completionGateEnabled: false, adaptiveScaffoldingEnabled: false },
  });
  return { stoppedOnTurn, ran, offered, text: texts.join('') };
}

describe('a spent budget is enforced with cycle detection off (#510)', () => {
  it('withdraws run_command after 3 refusals and stops when the model keeps calling it', async () => {
    const budget = baseToolBudget('run_command');
    const r = await runCommandForever(true);
    expect(r.ran).toBe(budget);
    expect(r.text).toContain('Agent stopped: run_command is out of budget and was called again after 4 refusals');
    // Offered until its 3rd refusal, then not.
    expect(r.offered[budget + 2]).toContain('run_command');
    expect(r.offered[budget + 3]).not.toContain('run_command');
    // budget runs, 4 refusals, one nudged turn (no edit was made), then the
    // stop. The loop makes one more model request after it stops, so this
    // checks the turn of the stop, not the number of requests.
    expect(r.stoppedOnTurn).toBe(budget + 4 + 2);
  });

  it('ends the same way with cycle detection on', async () => {
    const r = await runCommandForever(false);
    expect(r.text).toContain('Agent stopped: run_command is out of budget');
  });
});
