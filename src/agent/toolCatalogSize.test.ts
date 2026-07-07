import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY, getToolDefinitionsForTier } from './tools.js';
import { toFunctionTools } from '../ollama/streamUtils.js';
import { charsToTokens } from '../config/tokenEstimation.js';

// Fixed-cost ratchets for the tool catalog.
//
// Every request ships a tool catalog in the `tools` array — a fixed per-turn cost
// paid BEFORE the system prompt, context, or conversation, and it rides in a
// separate array (NOT counted against LOCAL_MAX_SYSTEM_CHARS; the two costs
// stack). Two distinct sizes matter, and conflating them overstates the cost:
//
//   1. SHIPPED (what the model receives each turn) — `getToolDefinitionsForTier
//      ('full')`, the loop default. Config-gates disabled tools AND stubs the
//      ~30 extended built-ins to a one-line "call describe_tool for the schema"
//      form. This is the real per-request overhead and the one to keep small.
//
//   2. RAW REGISTRY (every tool's full schema) — never sent whole; it is what
//      `describe_tool(name)` serves on demand and the upper bound a single tool's
//      bloat can reach. Worth ratcheting so a runaway schema (giant enum,
//      prose-heavy description) trips CI, but it is NOT the per-turn cost.
//
// When a ceiling is legitimately exceeded, bump it with intent — don't raise it
// reflexively.

const SHIPPED_CEILING_CHARS = 42_000; // stubbed full tier ~35K + headroom
const RAW_CEILING_CHARS = 88_000; // raw registry ~75.5K + ~15% headroom

const wireChars = (defs: unknown[]): number => JSON.stringify(toFunctionTools(defs as never)).length;

describe('tool-catalog fixed-cost ratchet', () => {
  it('SHIPPED catalog (stubbed full tier) stays under the per-request ceiling', () => {
    // This is what actually hits the model every turn.
    const chars = wireChars(getToolDefinitionsForTier('full'));
    expect(chars, `shipped tool catalog is ${chars} chars (~${charsToTokens(chars)} tok)`).toBeLessThan(
      SHIPPED_CEILING_CHARS,
    );
  });

  it('stubbing keeps the shipped catalog well under the raw registry', () => {
    // Guards the stubbing mechanism itself — if it silently stopped stubbing,
    // the shipped size would balloon toward the raw size and this would trip.
    const shipped = wireChars(getToolDefinitionsForTier('full'));
    const raw = wireChars(TOOL_REGISTRY.map((t) => t.definition));
    expect(shipped).toBeLessThan(raw * 0.6);
  });

  it('raw registry stays under its ceiling (describe_tool on-demand budget)', () => {
    const chars = wireChars(TOOL_REGISTRY.map((t) => t.definition));
    expect(chars).toBeLessThan(RAW_CEILING_CHARS);
  });

  it('no single tool schema is pathologically large', () => {
    // A single tool over ~2.5K wire chars is almost always an unbounded enum or
    // an over-written description — catch it at the source, not in aggregate.
    const oversized = TOOL_REGISTRY.map((t) => ({
      name: t.definition.name,
      chars: wireChars([t.definition]),
    })).filter((t) => t.chars > 2_500);
    expect(oversized, `oversized tool schemas: ${JSON.stringify(oversized)}`).toEqual([]);
  });
});
