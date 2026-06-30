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

  // Python/JS literals + smart quotes → JSON.
  s = s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null');
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

  for (const c of candidates) {
    const obj = parseObject(c);
    if (obj) return obj;
  }
  return null;
}
