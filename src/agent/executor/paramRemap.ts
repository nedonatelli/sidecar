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
  /**
   * Conversions worth logging but not telling the model about. A model writing
   * XML-form calls can't express a typed `true` or `5`, so a note on every such
   * call would cost tokens and teach it nothing.
   */
  logOnly?: string[];
}

/**
 * A string carrying a value of the type the schema declares, as XML-form calls
 * deliver every value (`<parameter=dry_run>true</parameter>` arrives as "true").
 * Returns `undefined` when the string isn't unambiguously that type, so
 * validation and the tool still see the original.
 */
function scalarFromString(value: string, declared: string): boolean | number | undefined {
  const t = value.trim();
  if (declared === 'boolean') {
    const lower = t.toLowerCase();
    return lower === 'true' ? true : lower === 'false' ? false : undefined;
  }
  if (t === '') return undefined;
  const n = Number(t);
  if (!Number.isFinite(n)) return undefined;
  return declared === 'integer' && !Number.isInteger(n) ? undefined : n;
}

/**
 * Coerce wrong-but-unambiguous TYPES for declared params: a string handed to
 * an array-of-strings parameter becomes a one-element array (after trying a
 * JSON array-literal parse for models that stringify: '["a","b"]'). Live
 * recurrence (llama3.2, 3× in one dogfood session): ask_user(options="Yes")
 * bounced on 'must be an array, got string' until the run cycle-bailed —
 * the intent was never ambiguous.
 */
/**
 * String params holding multi-line text, where an array of strings has one
 * meaning -- one line per element. Models send edit_file's search/replace as
 * line arrays (ministral-3: 5 calls in a week of eval runs, each bounced with
 * "must be a string, got array"). Other string params (a path, a command) are
 * left to the validator: joining those would only hide a malformed call.
 */
const MULTILINE_TEXT_PARAMS = new Set(['search', 'replace', 'within', 'content']);

/**
 * The text a model's tokenizer uses for a carriage return it read, echoed back
 * as seven literal characters (#155, ML-02). gemma4:e4b reads a CRLF file and
 * writes `<0x0D>` wherever it saw `\r`: a search carrying it never matches
 * (0 of 1,221 such multi-line searches wrote, on the SWE canary), and in
 * `replace` it is written into the file. Only the shape that IS a carriage
 * return is removed -- the token right before a line break or at the very end;
 * the line-ending tiers then match and write the file's own line endings. A
 * file that mentions `<0x0D>` mid-line keeps it.
 */
const ECHOED_CR = /<0x0D>(?=\r?\n|$)/g;

/** Remove echoed carriage-return tokens from the multi-line text params, disclosing each. */
export function stripEchoedCarriageReturns(input: unknown): ParamRemapOutcome {
  const obj = input as Record<string, unknown>;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { input: obj, notes: [] };
  let out: Record<string, unknown> | null = null;
  const notes: string[] = [];
  for (const key of MULTILINE_TEXT_PARAMS) {
    const value = obj[key];
    if (typeof value !== 'string' || !value.includes('<0x0D>')) continue;
    const cleaned = value.replace(ECHOED_CR, '');
    if (cleaned === value) continue;
    out ??= { ...obj };
    out[key] = cleaned;
    notes.push(
      `'${key}' contained the literal text <0x0D> at line ends — that is how a carriage return reads to you; it ` +
        `was removed (line endings are matched and written in the file's own style, so leave them out)`,
    );
  }
  return { input: out ?? obj, notes };
}

export function coerceParamTypes(input: unknown, schema: ToolInputSchema | undefined): ParamRemapOutcome {
  const obj = input as Record<string, unknown>;
  if (!schema || schema.type !== 'object' || !obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { input: obj, notes: [] };
  }
  let out: Record<string, unknown> | null = null;
  const notes: string[] = [];
  const logOnly: string[] = [];
  for (const [key, rawSpec] of Object.entries(schema.properties ?? {})) {
    const declared = (rawSpec as { type?: string }).type;
    const value = obj[key];
    // #249: XML-form calls deliver every value as a string. Tools read these
    // loosely: "false" is truthy (`if (input.background)` backgrounded the
    // command, `if (input.rebase)` rebased) and `=== true` misses "true"
    // (`dry_run` ran the migration instead of previewing it).
    if ((declared === 'boolean' || declared === 'number' || declared === 'integer') && typeof value === 'string') {
      const scalar = scalarFromString(value, declared);
      if (scalar !== undefined) {
        out ??= { ...obj };
        out[key] = scalar;
        logOnly.push(`parameter '${key}' expects a ${declared}: the string "${value}" was read as ${scalar}`);
      }
      continue;
    }
    if (
      declared === 'string' &&
      MULTILINE_TEXT_PARAMS.has(key) &&
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((v) => typeof v === 'string')
    ) {
      out ??= { ...obj };
      out[key] = value.join('\n');
      notes.push(
        `parameter '${key}' expects a string — the array of ${value.length} lines was joined with line breaks`,
      );
      continue;
    }
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
  return { input: out ?? obj, notes, ...(logOnly.length ? { logOnly } : {}) };
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

  // The V2-insert carve-out that used to live here is gone with the insert
  // fields themselves. It existed to stop `new_text` being remapped to
  // `replace` when it was a canonical V2 payload; now that edit_file advertises
  // only path/search/replace, that remap is exactly the recovery we want — a
  // model still emitting insert_after + new_text from habit gets its payload
  // routed to `replace`, where the missing-`search` inference can act on it,
  // instead of dead-ending on a field the schema no longer declares.

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

/** Quote marks models leave around or after a path: backtick, straight and curly quotes, guillemets. */
const PATH_QUOTES = '`\'"«»“”‘’';
/**
 * A path, a run of quote marks, then whatever followed the closing quote.
 * The path itself holds no quote, whitespace or comma, so prose never matches.
 */
const QUOTED_PATH = new RegExp(String.raw`^[${PATH_QUOTES}]*([^${PATH_QUOTES}\s,]+)[${PATH_QUOTES}]+\s*(.*)$`, 's');
const LINE_ARG = /^\s*(start_line|end_line)\s*[:=]\s*(\d+)\s*$/;

/**
 * Recover the call a model meant when it wrote its other arguments into
 * `path` (#509). gemma4:31b, Lite-300: 25 calls in four shapes, all refused as
 * "invalid characters in file path":
 *
 *   reproduce_issue.py`                                  (write_file, 9)
 *   django/forms/widgets.py`,start_line:793
 *   tests/migrations/test_commands.py`,start_line:607,end_line:620
 *   django/core/serializers/__init__.py`, start_line=159, end_line=200
 *
 * The path is cut at its closing quote. Anything after it must be ONLY
 * `start_line` / `end_line` assignments to parameters the tool declares; any
 * other trailing text leaves the input untouched for the validator to refuse,
 * so a guess is never made. A line parameter the call already set is kept.
 */
export function repairPathArgument(input: unknown, schema: ToolInputSchema | undefined): ParamRemapOutcome {
  const obj = input as Record<string, unknown>;
  if (!schema || schema.type !== 'object' || !obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { input: obj, notes: [] };
  }
  const declared = schema.properties ?? {};
  const raw = obj.path;
  if (!('path' in declared) || typeof raw !== 'string') return { input: obj, notes: [] };
  const m = QUOTED_PATH.exec(raw.trim());
  if (!m) return { input: obj, notes: [] };
  const [, clean, rest] = m;

  const lines: Record<string, number> = {};
  const tail = rest.replace(/^,/, '').trim();
  if (tail) {
    for (const part of tail.split(',')) {
      const arg = LINE_ARG.exec(part);
      if (!arg || !(arg[1] in declared)) return { input: obj, notes: [] };
      lines[arg[1]] = Number(arg[2]);
    }
  }

  const out: Record<string, unknown> = { ...obj, path: clean };
  const moved: string[] = [];
  for (const [key, value] of Object.entries(lines)) {
    if (out[key] !== undefined && out[key] !== null) continue;
    out[key] = value;
    moved.push(`${key}=${value}`);
  }
  const notes = [
    moved.length
      ? `'path' also carried ${moved.join(', ')} — read as path "${clean}" with ${moved.join(', ')}; pass line numbers as their own parameters, not inside 'path'`
      : `'path' ended in a quote mark — read as "${clean}"; send the bare path`,
  ];
  return { input: out, notes };
}
