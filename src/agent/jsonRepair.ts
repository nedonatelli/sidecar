/**
 * Heuristic JSON repair for malformed tool-call arguments (Phase 1, A5).
 *
 * Weak local models emit the dominant share of malformed JSON: trailing commas,
 * unquoted keys, Python literals (`True`/`None`), single quotes, smart quotes,
 * code-fence wrappers, and truncation. This recovers the common cases without an
 * LLM round-trip. It is the universal (no-logit-access) repair tier; the
 * grammar-constrained regeneration in `toolCallRepair.ts` is the stronger tier
 * that runs when this can't recover the value.
 *
 * Pure and conservative: returns a parsed object only when a candidate parses to
 * a non-null object, else null. Never throws.
 */

/** Parse `s`; return it only if it's a non-null object (not an array/scalar). */
function parseObject(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The first brace-balanced `{...}` substring, or null. */
function extractFirstObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return raw.slice(start, i + 1);
  }
  // Unbalanced (truncated) — return from the first brace to the end.
  return raw.slice(start);
}

/**
 * Escape raw control characters (literal newline / tab / CR, and any other
 * <0x20) that appear INSIDE string values. Small models writing multi-line code
 * via `write_file`/`edit_file` routinely emit a real newline byte inside the
 * `content` string instead of the `\n` escape — `JSON.parse` rejects it with
 * "Bad control character in string literal". This is the dominant malformation
 * for coding tool calls, and fixing it here recovers the call with no LLM tier.
 * Outside strings, whitespace is left untouched (it's insignificant to JSON).
 */
function escapeControlCharsInStrings(s: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) {
        out += c;
        esc = false;
        continue;
      }
      if (c === '\\') {
        out += c;
        esc = true;
        continue;
      }
      if (c === '"') {
        out += c;
        inStr = false;
        continue;
      }
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        out +=
          c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') inStr = true;
    out += c;
  }
  return out;
}

/** Append closers for any unclosed `{`/`[` (truncated output). */
function balanceBrackets(s: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const c of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += '"';
  while (stack.length) out += stack.pop();
  return out;
}

/**
 * Attempt to recover a JSON object from malformed text. Returns the parsed
 * object or null. Applies progressively more aggressive fixes, parsing after
 * each, so a value that's already valid after a light touch wins.
 */
export function tryJsonRepair(raw: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null;

  const base = extractFirstObject(raw) ?? raw.trim();
  const candidates: string[] = [base];

  // Strip a stray code fence.
  let s = base
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  candidates.push(s);

  // Python/JS literals + smart quotes → JSON. NaN/Infinity aren't valid JSON —
  // small models emit them for numeric args; null is the safe recovery.
  s = s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
    .replace(/\bNaN\b/g, 'null')
    .replace(/-?\bInfinity\b/g, 'null');
  candidates.push(s);

  // Drop trailing commas before a closer.
  const noTrailing = s.replace(/,(\s*[}\]])/g, '$1');
  candidates.push(noTrailing);

  // Quote bare keys: `{ key: ` / `, key: ` → `"key":`.
  const quotedKeys = noTrailing.replace(/([{,]\s*)([A-Za-z_]\w*)(\s*:)/g, '$1"$2"$3');
  candidates.push(quotedKeys);

  // Single-quoted strings/keys → double (after key-quoting so we don't fight it).
  candidates.push(quotedKeys.replace(/'/g, '"'));

  // Balance unclosed brackets / strings (truncation).
  candidates.push(balanceBrackets(quotedKeys));
  candidates.push(balanceBrackets(quotedKeys.replace(/'/g, '"')));

  // Escape raw control chars inside strings (literal newlines in multi-line
  // content) — the dominant coding-tool-call failure. Layered on the strongest
  // candidates: double-quoted, and the original-quoting variant (for models that
  // correctly used double quotes but embedded raw newlines).
  const dq = quotedKeys.replace(/'/g, '"');
  candidates.push(escapeControlCharsInStrings(quotedKeys));
  candidates.push(escapeControlCharsInStrings(dq));
  candidates.push(balanceBrackets(escapeControlCharsInStrings(dq)));

  for (const c of candidates) {
    const obj = parseObject(c);
    if (obj) return obj;
  }
  return null;
}
