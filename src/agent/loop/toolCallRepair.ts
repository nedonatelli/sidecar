/**
 * Constrained-decoding repair of malformed tool calls (Phase 1: A1 + A2 + A5).
 *
 * When a tool call comes back with malformed arguments (`_malformedInputRaw`),
 * recover it at the action boundary instead of erroring out:
 *   1. heuristic JSON repair (no LLM) — fixes the common small-model mistakes;
 *   2. grammar-constrained regeneration — a `format`-constrained completion with
 *      the tool's own JSON schema as the grammar, so the output is guaranteed to
 *      match (Ollama enforces it; other backends ignore the schema and the result
 *      is treated as a plain reprompt, then heuristic-repaired).
 *
 * Engages ONLY on an already-malformed call, so reasoning and the happy path are
 * untouched (A2). When neither tier recovers the value, `_malformedInputRaw` is
 * left in place and the executor surfaces its targeted error as before.
 */

import type { ToolUseContentBlock, ChatMessage } from '../../ollama/types.js';
import type { SideCarClient } from '../../ollama/client.js';
import { tryJsonRepair } from '../jsonRepair.js';

export interface ToolCallRepairDeps {
  client: SideCarClient;
  /** Model to regenerate with (defaults to the client's current model). */
  model?: string;
  signal?: AbortSignal;
  /** The tool's JSON input schema, used as the decoding grammar. */
  schemaFor: (toolName: string) => Record<string, unknown> | undefined;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

const REPAIR_SYSTEM =
  'You repair malformed tool-call arguments. Output ONLY a single JSON object that matches the provided schema — ' +
  'no prose, no markdown, no code fence, no explanation.';

function parseObject(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function applyRepair(tu: ToolUseContentBlock, input: Record<string, unknown>): void {
  tu.input = input;
  delete tu._malformedInputRaw;
}

/**
 * Repair every malformed tool use in `toolUses` in place. Returns the number
 * recovered. Never throws except on abort.
 */
export async function repairMalformedToolUses(
  toolUses: readonly ToolUseContentBlock[],
  deps: ToolCallRepairDeps,
): Promise<number> {
  let repaired = 0;
  for (const tu of toolUses) {
    const raw = tu._malformedInputRaw;
    if (raw === undefined) continue;

    // Tier 1 — heuristic repair (no model round-trip).
    const heuristic = tryJsonRepair(raw);
    if (heuristic) {
      applyRepair(tu, heuristic);
      deps.logger?.info?.(`Repaired malformed args for \`${tu.name}\` (heuristic JSON repair)`);
      repaired++;
      continue;
    }

    // Tier 2 — grammar-constrained regeneration against the tool's schema.
    const schema = deps.schemaFor(tu.name);
    if (!schema) continue;
    try {
      const user =
        `Tool: ${tu.name}\n` +
        `JSON schema for its arguments:\n${JSON.stringify(schema)}\n\n` +
        `The model produced these malformed arguments:\n${raw}\n\n` +
        `Return the corrected arguments as a single JSON object matching the schema.`;
      const messages: ChatMessage[] = [{ role: 'user', content: user }];
      const out = await deps.client.completeWithOverrides(
        REPAIR_SYSTEM,
        messages,
        deps.model,
        512,
        deps.signal,
        schema,
      );
      const fixed = parseObject(out) ?? tryJsonRepair(out);
      if (fixed) {
        applyRepair(tu, fixed);
        deps.logger?.info?.(`Repaired malformed args for \`${tu.name}\` (schema-constrained regeneration)`);
        repaired++;
      } else {
        deps.logger?.warn?.(`Constrained repair for \`${tu.name}\` produced no parseable object`);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      deps.logger?.warn?.(
        `Constrained repair for \`${tu.name}\` failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return repaired;
}
