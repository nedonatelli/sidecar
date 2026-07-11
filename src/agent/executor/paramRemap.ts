// Deterministic recovery for the "right intent, wrong parameter name" tool
// call: small models emit write_file({file: "x", content: ...}) with the
// correct path and content under a synonym key, then repeat the same wrong
// key even after a schema-carrying validation error (observed live: llama3.2
// sent `file` on 6/6 write_file calls across a run). Instead of bouncing the
// call, remap an unrecognized synonym onto the missing required key and
// disclose the interpretation in the result so the model can learn the real
// name. Runs in the dispatcher before schema validation.
//
// Deliberately conservative: a remap fires only when the canonical key is
// REQUIRED and absent, the synonym key is present and non-null, and the
// synonym key is not itself a declared property of the tool (so a legitimate
// parameter can never be stolen).

interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
}

/** Canonical key → wrong-but-unambiguous names models emit for it. */
const SYNONYMS: Record<string, readonly string[]> = {
  path: ['file', 'filename', 'file_path', 'filepath', 'file_name'],
  content: ['text', 'contents', 'body', 'file_content', 'new_content'],
  command: ['cmd', 'shell_command', 'script'],
  // Claude-style edit tools use old_string/new_string; models trained on
  // those emit them against edit_file's search/replace.
  search: ['old_string', 'old_text', 'find'],
  replace: ['new_string', 'new_text', 'replacement'],
  query: ['q', 'search_query'],
  pattern: ['regex', 'glob'],
  // ask_user: llama3.2 emits {'q': ...}; the executor's question fallback
  // then silently substitutes a generic prompt and the model loops re-asking.
  question: ['q', 'prompt', 'message'],
};

export interface ParamRemapOutcome {
  /** Input with any synonym keys moved onto their canonical names. */
  input: Record<string, unknown>;
  /** One disclosure line per remap; empty when nothing fired. */
  notes: string[];
}

/**
 * Coerce wrong-but-unambiguous TYPES for declared params: a string handed to
 * an array-of-strings parameter becomes a one-element array (after trying a
 * JSON array-literal parse for models that stringify: '["a","b"]'). Live
 * recurrence (llama3.2, 3× in one dogfood session): ask_user(options="Yes")
 * bounced on 'must be an array, got string' until the run cycle-bailed —
 * the intent was never ambiguous.
 */
export function coerceParamTypes(input: unknown, schema: ToolInputSchema | undefined): ParamRemapOutcome {
  const obj = input as Record<string, unknown>;
  if (!schema || schema.type !== 'object' || !obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { input: obj, notes: [] };
  }
  let out: Record<string, unknown> | null = null;
  const notes: string[] = [];
  for (const [key, rawSpec] of Object.entries(schema.properties ?? {})) {
    const declared = (rawSpec as { type?: string }).type;
    const value = obj[key];
    if (declared !== 'array' || typeof value !== 'string') continue;
    let coerced: unknown[] = [value];
    const trimmed = value.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) coerced = parsed;
      } catch {
        // not a JSON literal — keep the single-element wrap
      }
    }
    out ??= { ...obj };
    out[key] = coerced;
    notes.push(
      `parameter '${key}' expects an array — the string value was interpreted as ${coerced.length === 1 ? 'a one-element array' : 'a JSON array'}`,
    );
  }
  return { input: out ?? obj, notes };
}

export function remapParamSynonyms(input: unknown, schema: ToolInputSchema | undefined): ParamRemapOutcome {
  const obj = input as Record<string, unknown>;
  if (!schema || schema.type !== 'object' || !obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { input: obj, notes: [] };
  }

  const declared = schema.properties ?? {};
  // Required keys first (they'd fail validation outright), then remaining
  // declared-but-absent optional keys — a synonym key is never a declared
  // property, so it carries dead data wherever it sits; moving it onto a
  // declared absent key can only help (observed: ask_user({'q': ...}) fell
  // through to the generic-question fallback because 'question' is optional).
  const required = schema.required ?? [];
  const candidates = [...required, ...Object.keys(declared).filter((k) => !required.includes(k))];
  let out: Record<string, unknown> | null = null;
  const notes: string[] = [];

  for (const key of candidates) {
    if (obj[key] !== undefined && obj[key] !== null) continue;
    for (const syn of SYNONYMS[key] ?? []) {
      if (syn in declared) continue;
      const value = (out ?? obj)[syn];
      if (value === undefined || value === null) continue;
      out ??= { ...obj };
      out[key] = value;
      delete out[syn];
      notes.push(`parameter '${syn}' is not valid for this tool — interpreted as '${key}'; use '${key}' next time`);
      break;
    }
  }

  return { input: out ?? obj, notes };
}
