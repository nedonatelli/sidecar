// Deterministic guard for the "example replay" tool call: given a user turn
// with no actionable signal ("hi"), small models latch onto the concrete
// `Example: \`tool(...)\`` embedded in a tool description and emit it
// verbatim (observed live: ask_user replayed the auth-flow example from its
// own description, surfacing a fabricated question to the user). The
// examples exist on purpose — ec772f7 standardized every description on
// "when to use + when not + example" because small models need the format
// demonstration — so instead of removing them, bounce any call whose
// arguments exactly match the example in that tool's own description and
// tell the model the arguments were illustrative. Runs in the dispatcher
// after schema validation and before the review/approval gates so the user
// is never prompted to approve a parroted call.
//
// Deliberately conservative: fires only on a FULL exact match (same keys,
// same values) against a successfully parsed example with at least one
// argument. Zero-arg examples (`check_pr_ci()`) and unparseable placeholders
// (`constraints=<JSON string>`) are never guarded. A persistent replayer is
// backstopped by cycle detection like any other repeated call.

const EXAMPLE_RE = /Example: `([A-Za-z_][\w.]*)\(([\s\S]*?)\)`/;

const PARSE_FAIL = Symbol('parse-fail');

/**
 * Parse the pseudo-call argument syntax used by description examples
 * (`key="value", flag=true, items=["a", "b"]`) into a plain object.
 * Returns null when there is nothing guardable: no example, an empty
 * argument list, or any token the scanner does not recognize.
 */
export function extractExampleArgs(description: string | undefined): Record<string, unknown> | null {
  const match = description?.match(EXAMPLE_RE);
  if (!match) return null;
  // Whole-object form: `render_viz({ type: "chart", ... })` — the object
  // literal IS the input. Its keys may be unquoted, so strip the outer
  // braces and hand the body to the same key/value scanner.
  let src = match[2];
  const trimmed = src.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    src = trimmed.slice(1, -1);
  }

  let i = 0;

  const skipWs = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };

  const parseString = (quote: string): string | typeof PARSE_FAIL => {
    i++; // opening quote
    let out = '';
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        i++;
        return out;
      }
      out += ch;
      i++;
    }
    return PARSE_FAIL; // unterminated
  };

  const parseValue = (): unknown | typeof PARSE_FAIL => {
    skipWs();
    const ch = src[i];
    if (ch === '"' || ch === "'") return parseString(ch);
    if (ch === '[') {
      i++;
      const arr: unknown[] = [];
      skipWs();
      if (src[i] === ']') {
        i++;
        return arr;
      }
      while (i < src.length) {
        const v = parseValue();
        if (v === PARSE_FAIL) return PARSE_FAIL;
        arr.push(v);
        skipWs();
        if (src[i] === ',') {
          i++;
          continue;
        }
        if (src[i] === ']') {
          i++;
          return arr;
        }
        return PARSE_FAIL;
      }
      return PARSE_FAIL;
    }
    if (ch === '{') {
      // Object literals in examples are JSON-shaped; balanced-scan then parse.
      const start = i;
      let depth = 0;
      let inString: string | null = null;
      for (; i < src.length; i++) {
        const c = src[i];
        if (inString) {
          if (c === '\\') i++;
          else if (c === inString) inString = null;
          continue;
        }
        if (c === '"' || c === "'") inString = c;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
          i++;
          try {
            return JSON.parse(src.slice(start, i));
          } catch {
            return PARSE_FAIL;
          }
        }
      }
      return PARSE_FAIL;
    }
    const literal = /^(true|false|null|-?\d+(?:\.\d+)?)/.exec(src.slice(i));
    if (literal) {
      i += literal[0].length;
      if (literal[0] === 'true') return true;
      if (literal[0] === 'false') return false;
      if (literal[0] === 'null') return null;
      return Number(literal[0]);
    }
    return PARSE_FAIL; // <JSON string> placeholders and anything else
  };

  const out: Record<string, unknown> = {};
  while (true) {
    skipWs();
    if (i >= src.length) break;
    const idStart = i;
    while (i < src.length && /\w/.test(src[i])) i++;
    const key = src.slice(idStart, i);
    if (!key) return null;
    skipWs();
    // Both separator styles appear in the catalog: `key="v"` and `key: "v"`.
    if (src[i] !== '=' && src[i] !== ':') return null;
    i++;
    const value = parseValue();
    if (value === PARSE_FAIL) return null;
    out[key] = value;
    skipWs();
    if (i < src.length) {
      if (src[i] !== ',') return null;
      i++;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** JSON.stringify with recursively sorted object keys, for order-insensitive comparison. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

// Per-tool memo of the canonical example-args string (null = tool has no
// guardable example). Keyed by tool name but revalidated against the
// description so MCP tools whose descriptions change on reconnect re-extract.
const exampleCache = new Map<string, { description: string; canonical: string | null }>();

/** True when `input` is a verbatim replay of the example embedded in `description`. */
export function isExampleReplay(toolName: string, input: unknown, description: string | undefined): boolean {
  if (!description || !input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (Object.keys(input as Record<string, unknown>).length === 0) return false;

  let cached = exampleCache.get(toolName);
  if (!cached || cached.description !== description) {
    const args = extractExampleArgs(description);
    cached = { description, canonical: args ? stableStringify(args) : null };
    exampleCache.set(toolName, cached);
  }
  if (cached.canonical === null) return false;
  return stableStringify(input) === cached.canonical;
}

/** Corrective tool-result text for a bounced replay. */
export function buildExampleReplayError(toolName: string): string {
  return (
    `Error: this ${toolName} call copies the example from the tool's own description verbatim — ` +
    `those arguments are illustrative, not real. Derive the arguments from the actual task and conversation. ` +
    `If the conversation gives you nothing to act on, reply to the user in plain text instead of calling a tool.`
  );
}
