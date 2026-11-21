import { describe, it, expect } from 'vitest';
import { resolveIterationTools, resolveTextCallTools } from './streamTurn.js';
import { stubLoopState } from './testHelpers.js';
import type { ToolDefinition } from '../../ollama/types.js';

// #510: a tool withdrawn for its spent budget is left out of the catalog the
// model is sent, and so out of what dispatch counts as offered. A text-form
// call to it is still parsed, so it is refused and counted like a native one.
const tool = (name: string): ToolDefinition =>
  ({ name, description: name, input_schema: { type: 'object', properties: {} } }) as ToolDefinition;
const names = (ts: ToolDefinition[]) => ts.map((t) => t.name);
const tools = ['read_file', 'run_command', 'grep', 'ask_user'].map(tool);

describe('withdrawn tools and the per-iteration catalog (#510)', () => {
  it('offers every tool while none is withdrawn', () => {
    const state = stubLoopState({ tools });
    expect(names(resolveIterationTools(state))).toEqual(['read_file', 'run_command', 'grep', 'ask_user']);
    expect(names(resolveTextCallTools(state))).toEqual(['read_file', 'run_command', 'grep', 'ask_user']);
  });

  it('leaves a withdrawn tool out of the catalog, and keeps it for text-form parsing', () => {
    const state = stubLoopState({ tools, withdrawnTools: new Set(['run_command']) });
    expect(names(resolveIterationTools(state))).toEqual(['read_file', 'grep', 'ask_user']);
    expect(names(resolveTextCallTools(state))).toEqual(['read_file', 'grep', 'ask_user', 'run_command']);
  });

  it('does not widen plan mode: a withdrawn tool is not parsed from text there', () => {
    const state = stubLoopState({ tools, approvalMode: 'plan', withdrawnTools: new Set(['run_command']) });
    expect(names(resolveIterationTools(state))).toEqual(['ask_user']);
    expect(names(resolveTextCallTools(state))).toEqual(['ask_user']);
  });

  it('withdraws ask_user in plan mode too', () => {
    const state = stubLoopState({ tools, approvalMode: 'plan', withdrawnTools: new Set(['ask_user']) });
    expect(resolveIterationTools(state)).toEqual([]);
  });
});
