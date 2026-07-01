// ---------------------------------------------------------------------------
// Phase 1 — schema-constrained tool-call decoding.
//
// The strategy: to make a MALFORMED call unsamplable (not just repairable), we
// constrain generation to a JSON schema and let the local runtime's
// grammar-constrained decoder enforce it at the token level. Ollama's `format`
// field takes a JSON schema and does exactly this.
//
// The schema is a UNION over the provided functions: the model may emit zero or
// more calls, each of which must be one of the offered functions with valid,
// non-hallucinated arguments. An empty array is allowed so the irrelevance case
// (emit no call) stays expressible. This is the §2.1 guarantee — grammars make
// invalid unsamplable — applied at the action boundary only (A2: we constrain
// the call, never the reasoning).
// ---------------------------------------------------------------------------

import type { BfclFunctionSchema } from './types.js';
import { normalizeSchema } from './backend.js';

/** JSON schema for a single call to one named function. */
function callSchemaFor(fn: BfclFunctionSchema): Record<string, unknown> {
  const args = normalizeSchema(fn.parameters) as Record<string, unknown>;
  // Forbid top-level hallucinated params — mirrors the AST checker's rule and is
  // enforceable by the grammar rather than caught after the fact.
  const argsConstrained = { ...args, additionalProperties: false };
  return {
    type: 'object',
    properties: {
      name: { type: 'string', enum: [fn.name] },
      arguments: argsConstrained,
    },
    required: ['name', 'arguments'],
    additionalProperties: false,
  };
}

/**
 * Build the constrained output schema: `{ tool_calls: [ <oneOf the functions> ] }`.
 * A top-level object (not a bare array) because structured-output backends are
 * most reliable with an object root. An empty `tool_calls` array is valid.
 */
export function buildToolCallSchema(functions: BfclFunctionSchema[]): Record<string, unknown> {
  const items = functions.length === 1 ? callSchemaFor(functions[0]) : { oneOf: functions.map(callSchemaFor) };
  return {
    type: 'object',
    properties: {
      tool_calls: { type: 'array', items },
    },
    required: ['tool_calls'],
    additionalProperties: false,
  };
}

/** System prompt for the constrained path — instructs the JSON-object shape. */
export const CONSTRAINED_SYSTEM_PROMPT =
  'You call functions to satisfy the request. Respond ONLY with a JSON object of the form ' +
  '{"tool_calls": [{"name": "<function>", "arguments": { ... }}]}. Include one object per ' +
  'function call needed. If none of the functions apply, return {"tool_calls": []}.';

interface ConstrainedShape {
  tool_calls?: Array<{ name?: string; arguments?: Record<string, unknown> }>;
}

/** Parse the constrained JSON content into the normalized call list. */
export function parseConstrainedContent(content: string): Array<{ name: string; args: Record<string, unknown> }> {
  let data: ConstrainedShape;
  try {
    data = JSON.parse(content) as ConstrainedShape;
  } catch {
    return [];
  }
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const c of data.tool_calls ?? []) {
    if (c && typeof c.name === 'string') out.push({ name: c.name, args: c.arguments ?? {} });
  }
  return out;
}
