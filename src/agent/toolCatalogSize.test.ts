import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY } from './tools.js';
import { toFunctionTools } from '../ollama/streamUtils.js';
import { charsToTokens } from '../config/tokenEstimation.js';
import { LOCAL_MAX_SYSTEM_CHARS } from '../config/constants.js';

// Fixed-cost ratchet for the tool catalog.
//
// Every request ships the full tool catalog in the `tools` array — a fixed
// per-turn cost paid BEFORE the system prompt, context, or conversation. It
// rides in a separate array, so it is NOT counted against LOCAL_MAX_SYSTEM_CHARS;
// the two costs stack. On a small local model with a 32K window this catalog
// alone is a large fraction of the budget, which is why v0.117 pursues
// relevance-gated tool loading.
//
// This test pins the current size so a newly-added tool with a runaway schema
// (a giant enum, a prose-heavy description, a deeply nested input_schema) trips
// CI instead of silently eating the local-model context window. When the catalog
// legitimately grows, bump CEILING_CHARS with intent — don't raise it reflexively.

const CEILING_CHARS = 88_000; // current ~75.5K + ~15% headroom

describe('tool-catalog fixed-cost ratchet', () => {
  it('serialized catalog stays under the per-request ceiling', () => {
    const defs = TOOL_REGISTRY.map((t) => t.definition);
    const chars = JSON.stringify(toFunctionTools(defs as never)).length;
    expect(chars).toBeLessThan(CEILING_CHARS);
  });

  it('no single tool schema is pathologically large', () => {
    // A single tool over ~2.5K wire chars is almost always an unbounded enum or
    // an over-written description — catch it at the source, not in aggregate.
    const oversized = TOOL_REGISTRY.map((t) => ({
      name: t.definition.name,
      chars: JSON.stringify(toFunctionTools([t.definition] as never)).length,
    })).filter((t) => t.chars > 2_500);
    expect(oversized, `oversized tool schemas: ${JSON.stringify(oversized)}`).toEqual([]);
  });

  it('reports catalog cost relative to the local system-char cap', () => {
    // Not a gate — documents the stacked fixed cost so the number lives in-repo.
    const defs = TOOL_REGISTRY.map((t) => t.definition);
    const chars = JSON.stringify(toFunctionTools(defs as never)).length;
    const tokens = charsToTokens(chars);
    expect(tokens).toBeGreaterThan(0);
    // Catalog + system prompt are additive fixed costs; the catalog alone
    // already exceeds the system-prompt char cap for local models.
    expect(chars).toBeGreaterThan(LOCAL_MAX_SYSTEM_CHARS * 0.5);
  });
});
