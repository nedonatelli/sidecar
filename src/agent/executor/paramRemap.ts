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
};

export interface ParamRemapOutcome {
  /** Input with any synonym keys moved onto their canonical names. */
  input: Record<string, unknown>;
  /** One disclosure line per remap; empty when nothing fired. */
  notes: string[];
}

export function remapParamSynonyms(input: unknown, schema: ToolInputSchema | undefined): ParamRemapOutcome {
  const obj = input as Record<string, unknown>;
  if (
    !schema ||
    schema.type !== 'object' ||
    !obj ||
    typeof obj !== 'object' ||
    Array.isArray(obj) ||
    !schema.required?.length
  ) {
    return { input: obj, notes: [] };
  }

  const declared = schema.properties ?? {};
  let out: Record<string, unknown> | null = null;
  const notes: string[] = [];

  for (const key of schema.required) {
    if (obj[key] !== undefined && obj[key] !== null) continue;
    for (const syn of SYNONYMS[key] ?? []) {
      if (syn in declared) continue;
      const value = obj[syn];
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
