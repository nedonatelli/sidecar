import type { ChatMessage, ToolDefinition, ToolUseContentBlock } from '../../ollama/types.js';
import { resolveToolNameAlias } from '../executor/toolNameAlias.js';
import { findBalancedEnd } from '../delimiters.js';

/**
 * A parsed name is dispatchable when it's in the catalog OR the executor's
 * tool-name aliasing can resolve it (create_file → write_file). Observed
 * live: llama3.2's final turn was a single bare-JSON `create_file` call —
 * the parser matched it, then dropped it here on the exact-name check, and
 * the run ended with the work undone. The alias name is preserved on the
 * emitted block so the executor's disclosure still teaches the real name.
 */
function isDispatchableName(name: string, toolNames: Set<string>): boolean {
  if (toolNames.has(name)) return true;
  const canonical = resolveToolNameAlias(name);
  return canonical !== null && toolNames.has(canonical);
}

// ---------------------------------------------------------------------------
// Text-level parsing + cleanup helpers for runAgentLoop.
//
// Two pure functions that used to live at the bottom of loop.ts and
// were getting in the way of the main orchestration story. They're
// independently unit-tested (loop.test.ts exercises both), so moving
// them here doesn't change behavior — loop.ts re-exports them so
// existing import paths keep working.
//
//   - `parseTextToolCalls` handles models that emit tool calls as
//     XML, <tool_call>JSON</tool_call>, or fenced JSON instead of the
//     structured tool_use API. We accept the first pattern the model
//     uses and ignore subsequent ones to avoid mixing formats within
//     a single turn.
//
//   - `stripRepeatedContent` removes ≥200-char paragraphs the model
//     is echoing verbatim from earlier assistant messages. Keeps code
//     blocks intact (fenced content is never stripped) to avoid
//     eating legitimate code examples.
// ---------------------------------------------------------------------------

/**
 * Parse tool calls from model text output when the model doesn't use
 * structured tool_use blocks. Handles common formats:
 *   - `<function=name><parameter=key>value</parameter></function>`
 *   - `<tool_call>{"name":"...","arguments":{...}}</tool_call>`
 *   - ```` ```json\n{"name":"...","arguments":{...}}\n``` ````
 *   - bare JSON object on its own line: `{"name":"...","parameters":{...}}`
 *
 * Only the first pattern found in the text is honored — mixing
 * patterns within a single turn usually indicates a confused model,
 * and mixing them in our parser would double-dispatch the same call.
 */
/** Salvage a known tool name from a malformed tool-call blob, or null. */
function salvageToolName(raw: string, toolNames: Set<string>): string | null {
  const m = raw.match(/"(?:name|function)"\s*:\s*"(\w+)"/);
  return m && isDispatchableName(m[1], toolNames) ? m[1] : null;
}

/** Split a comma-separated argument list at top level, respecting quotes and brackets. Exported for tests. */
export function splitTopLevelArgs(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null; // '"', "'", or the triple forms '"""' / "'''"
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (quote.length === 3) {
        if (s.startsWith(quote, i)) {
          cur += quote;
          i += 2;
          quote = null;
          continue;
        }
        cur += c;
        continue;
      }
      cur += c;
      if (c === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      // Python triple-quoted string — observed live: qwen emits
      // write_file(content='''def add…''') inside a python fence.
      const triple = c.repeat(3);
      if (s.startsWith(triple, i)) {
        quote = triple;
        cur += triple;
        i += 2;
        continue;
      }
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Coerce a raw Python-kwarg value token to a JS value (string/number/bool/null). Exported for tests. */
export function coerceArgValue(raw: string): unknown {
  const t = raw.trim();
  // Python triple-quoted literals carry their content raw (real newlines).
  // Checked before the double-quote branch, which would otherwise swallow """…""".
  if (t.length >= 6 && ((t.startsWith("'''") && t.endsWith("'''")) || (t.startsWith('"""') && t.endsWith('"""')))) {
    return t.slice(3, -3);
  }
  if (t.startsWith('"') && t.endsWith('"')) {
    // A double-quoted literal is usually a valid JSON string carrying \n / \"
    // escapes the model MEANS as newlines and quotes — write_file content
    // emitted as `content="def add(a, b):\n  return a + b"` must land on disk
    // with real newlines, not literal backslash-n. Fall back to a bare slice
    // when the literal isn't valid JSON (e.g. contains real newlines, which
    // are already what the model intended).
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1);
  }
  if (t === 'true' || t === 'True') return true;
  if (t === 'false' || t === 'False') return false;
  if (t === 'null' || t === 'None') return null;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
  return t; // bareword — treat as a string
}

/**
 * Salvage a tool call whose NAME captured the whole call expression — e.g.
 * name=`read_file(path="src/x.ts")` with empty args. Some model runtimes
 * (notably Ollama's native qwen3.5 tool parser) occasionally fail to split the
 * function name from its arguments, and models sometimes echo the prompt's
 * `read_file(path="…")` example syntax as a literal text call. Both leave the
 * base name unresolvable ("Unknown tool") when the real intent was clear.
 *
 * Returns the base name plus arguments parsed from the parentheses — Python-style
 * kwargs (`path="x", start_line=5`) or an embedded JSON object (`{"path":"x"}`).
 * Positional-only args can't be mapped without the schema, so they yield an empty
 * input (the base name still resolves, and the tool surfaces a clear missing-arg
 * error instead of an opaque "Unknown tool"). Returns null when `rawName` is not
 * a `name(...)` call expression — real tool names are plain identifiers, so this
 * never fires on a legitimate call.
 */
export function parseMangledToolName(rawName: string): { name: string; input: Record<string, unknown> } | null {
  const m = rawName.match(/^\s*([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*$/);
  if (!m) return null;
  const name = m[1];
  const argStr = m[2].trim();
  if (argStr === '') return { name, input: {} };

  // Embedded JSON object: read_file({"path":"x"})
  if (argStr.startsWith('{')) {
    try {
      const parsed = JSON.parse(argStr);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { name, input: parsed as Record<string, unknown> };
      }
    } catch {
      // fall through to kwargs parsing
    }
  }

  const input: Record<string, unknown> = {};
  for (const part of splitTopLevelArgs(argStr)) {
    const kv = part.match(/^\s*([A-Za-z_]\w*)\s*=\s*([\s\S]+?)\s*$/);
    if (kv) input[kv[1]] = coerceArgValue(kv[2]);
  }
  return { name, input };
}

/**
 * Detect degenerate model output — token salad that must never stand as a
 * final answer (observed live: llama3.2 emitted a stream of
 * `<|reserved_special_token_1043|>…` at iteration 2 and the run accepted it
 * as done). Two conservative signatures, checked outside code fences:
 *
 *   1. ≥3 special-token literals (`<|…|>`) — real prose essentially never
 *      contains reserved-token markers.
 *   2. The same 8–64 char chunk repeated ≥10 times consecutively — a
 *      sampler loop, not an answer.
 *
 * Input is capped at 20KB before the repetition scan so a pathological
 * backreference can't stall the loop thread.
 */
export function isDegenerateText(text: string): boolean {
  const stripped = text.replace(/```[\s\S]*?```/g, '').slice(0, 20_000);
  const specialTokens = stripped.match(/<\|[^|<>]{1,60}\|>/g);
  if (specialTokens && specialTokens.length >= 3) return true;
  return /([^\s]{8,64}?)\1{9,}/.test(stripped);
}

/**
 * Span-aware variant: returns the parsed calls PLUS the text with every
 * accepted call's source span excised. The raw JSON/XML of a dispatched
 * text-form call must not remain in the assistant text — live it rendered
 * as stray JSON next to the real tool cards, and in RESTORED history
 * (text-only rehydration) the JSON stubs were most of what the user saw
 * ("outputs don't seem to be stored" — they were, drowned in call syntax).
 */
export interface TextParseOpts {
  /** Also recognize call-expression syntax emitted as prose — `write_file(path="x", content="…")`.
   *  Part of the code-as-text recovery package (`recovery.codeAsText`), default-on since v0.120. */
  callExpressions?: boolean;
}

export function parseTextToolCallsCleaned(
  text: string,
  tools: ToolDefinition[],
  opts?: TextParseOpts,
): { calls: ToolUseContentBlock[]; cleanedText: string } {
  const spans: Array<[number, number]> = [];
  const calls = parseTextToolCallsInternal(text, tools, spans, opts);
  if (spans.length === 0) return { calls, cleanedText: text };
  spans.sort((a, b) => a[0] - b[0]);
  let cleaned = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start < cursor) continue; // overlapping span already excised
    cleaned += text.slice(cursor, start);
    cursor = end;
  }
  cleaned += text.slice(cursor);
  return { calls, cleanedText: cleaned.replace(/\n{3,}/g, '\n\n').trim() };
}

export function parseTextToolCalls(text: string, tools: ToolDefinition[], opts?: TextParseOpts): ToolUseContentBlock[] {
  return parseTextToolCallsInternal(text, tools, undefined, opts);
}

function parseTextToolCallsInternal(
  text: string,
  tools: ToolDefinition[],
  spans?: Array<[number, number]>,
  opts?: TextParseOpts,
): ToolUseContentBlock[] {
  const toolNames = new Set(tools.map((t) => t.name));
  const results: ToolUseContentBlock[] = [];
  let idCounter = 0;

  // Single combined regex matches the first three patterns in one pass.
  // Groups: (1) function=name, (2) function body,
  //         (3) tool_call body, (4) json code fence body.
  // Bare JSON (pattern 4) is extracted separately with brace-depth
  // tracking because the lazy [\s\S]*?\} regex terminates at the first
  // closing brace, chopping off nested argument objects.
  const combined =
    /<function=(\w+)>([\s\S]*?)<\/function>|<tool_call>\s*([\s\S]*?)\s*<\/tool_call>|```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/g;

  // Track which pattern type matched first (for priority: fn > tool_call > json > bare)
  let firstType: 'fn' | 'tc' | 'json' | 'bare' | null = null;
  let match;

  while ((match = combined.exec(text)) !== null) {
    // Pattern 1: <function=name><parameter=key>value</parameter></function>
    if (match[1] !== undefined) {
      if (firstType === null) firstType = 'fn';
      if (firstType !== 'fn') continue;
      const name = match[1];
      if (!isDispatchableName(name, toolNames)) continue;
      const body = match[2];
      const input: Record<string, unknown> = {};
      const paramPattern = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;
      let pm;
      while ((pm = paramPattern.exec(body)) !== null) {
        input[pm[1]] = pm[2].trim();
      }
      spans?.push([match.index, match.index + match[0].length]);
      results.push({ type: 'tool_use', id: `text_tc_${idCounter++}`, name, input });
    }
    // Pattern 2: <tool_call>JSON</tool_call>
    else if (match[3] !== undefined) {
      if (firstType === null) firstType = 'tc';
      if (firstType !== 'tc') continue;
      try {
        const parsed = JSON.parse(match[3]);
        const name = parsed.name || parsed.tool || parsed.function?.name;
        const args = parsed.arguments || parsed.args || parsed.function?.arguments || parsed.parameters || {};
        if (name && isDispatchableName(name, toolNames)) {
          const input = typeof args === 'string' ? JSON.parse(args) : args;
          spans?.push([match.index, match.index + match[0].length]);
          results.push({ type: 'tool_use', id: `text_tc_${idCounter++}`, name, input });
        }
      } catch {
        // Malformed JSON: don't silently drop — emit a marker so the
        // constrained-repair layer can recover it (A5).
        const name = salvageToolName(match[3], toolNames);
        if (name) {
          results.push({
            type: 'tool_use',
            id: `text_tc_${idCounter++}`,
            name,
            input: {},
            _malformedInputRaw: match[3],
          });
        }
      }
    }
    // Pattern 3: ```json\n{...}\n```
    else if (match[4] !== undefined) {
      if (firstType === null) firstType = 'json';
      if (firstType !== 'json') continue;
      try {
        const parsed = JSON.parse(match[4]);
        const name = parsed.name || parsed.tool || parsed.function;
        const args = parsed.arguments || parsed.args || parsed.parameters || parsed.input || {};
        if (name && typeof name === 'string' && isDispatchableName(name, toolNames)) {
          const input = typeof args === 'string' ? JSON.parse(args) : args;
          spans?.push([match.index, match.index + match[0].length]);
          results.push({ type: 'tool_use', id: `text_tc_${idCounter++}`, name, input });
        }
      } catch {
        const name = salvageToolName(match[4], toolNames);
        if (name) {
          results.push({
            type: 'tool_use',
            id: `text_tc_${idCounter++}`,
            name,
            input: {},
            _malformedInputRaw: match[4],
          });
        }
      }
    }
  }

  // Pattern 4: bare JSON object on its own line — {"name":"...","parameters":{...}}
  // Some Ollama models emit tool calls this way without any wrapper tags or fences.
  // Handled separately with brace-depth tracking so nested argument objects
  // (e.g. {"name":"x","arguments":{"key":"val"}}) are extracted correctly —
  // a lazy regex terminates at the first } and chops off the inner object.
  if (firstType === null) {
    // Seed from EVERY `{` that opens a quoted key — not just line-anchored ones.
    //
    // The old seed was `/(?:^|\n)\{/`: an object had to start a line. Live
    // v0.119 dogfood, qwen2.5-coder:7b emitted a perfectly valid call glued to
    // the closing fence of the previous one:
    //
    //     ```{"name": "edit_file", "arguments": {"path":"src/greeter.ts", …}}
    //
    // That `{` sits mid-line, so the scanner never found it. salvageToolName
    // then recovered the NAME from the raw text and the repair layer produced
    // `edit_file({})` — empty arguments. The model's edit was correct and
    // complete; SideCar threw the arguments away, bounced it on schema
    // validation, and the model eventually apologized and gave up on a task it
    // had actually solved. A brace-followed-by-a-quoted-key is the right seed:
    // the `"name"` requirement and dispatchable-name check below reject the
    // false positives (nested argument objects don't carry a tool name).
    const starts: number[] = [];
    const objectStart = /\{(?=\s*")/g;
    let lsMatch;
    while ((lsMatch = objectStart.exec(text)) !== null) {
      starts.push(lsMatch.index);
    }
    const seen = new Set<number>();
    // End index (exclusive) of the last object we consumed. Seeds inside it are
    // that object's own nested argument objects, never separate tool calls —
    // skipping them keeps the broader seed from double-parsing a single call.
    let consumedUntil = -1;
    while (starts.length > 0) {
      const start = starts.shift()!;
      if (seen.has(start) || start < consumedUntil) continue;
      seen.add(start);
      // Shared string-aware scanner (agent/delimiters.ts): a naive depth count
      // ran off on braces inside argument VALUES — the commonest call there is,
      // a code edit — discarding the arguments and dispatching edit_file({}).
      const end = findBalancedEnd(text, start, { dialect: 'json' });
      if (end === -1) {
        // Truncated emission — the object never closes (observed live:
        // llama3.2 emitted an OpenAI-function-shaped call missing its final
        // brace). Don't silently drop it: salvage the tool name and emit the
        // malformed-input marker so constrained repair gets a shot.
        const truncated = text.slice(start);
        if (truncated.includes('"name"')) {
          const name = salvageToolName(truncated, toolNames);
          if (name) {
            firstType = 'bare';
            results.push({
              type: 'tool_use',
              id: `text_tc_${idCounter++}`,
              name,
              input: {},
              _malformedInputRaw: truncated,
            });
            // The object never closed, so everything after it is part of THIS
            // truncated call — including any nested object that happens to be
            // well-formed. Consume to the end so it isn't parsed as a second call.
            consumedUntil = text.length;
          }
        }
        continue;
      }
      // Another object fused directly onto this one — scan it too.
      if (text[end + 1] === '{') starts.push(end + 1);
      const candidate = text.slice(start, end + 1);
      // Must contain "name" key to avoid grabbing every JSON blob.
      if (!candidate.includes('"name"')) continue;
      try {
        const parsed = JSON.parse(candidate);
        // OpenAI function-call shape nests both fields one level down:
        // {"type":"function","function":{"name":"…","parameters":{…}}}
        const name = parsed.name || parsed.function?.name;
        const args =
          parsed.arguments ||
          parsed.args ||
          parsed.parameters ||
          parsed.input ||
          parsed.function?.arguments ||
          parsed.function?.parameters ||
          {};
        if (name && typeof name === 'string' && isDispatchableName(name, toolNames)) {
          firstType = 'bare';
          const input = typeof args === 'string' ? JSON.parse(args) : args;
          spans?.push([start, end + 1]);
          consumedUntil = end + 1;
          results.push({ type: 'tool_use', id: `text_tc_${idCounter++}`, name, input });
        }
      } catch {
        const name = salvageToolName(candidate, toolNames);
        if (name) {
          firstType = 'bare';
          results.push({
            type: 'tool_use',
            id: `text_tc_${idCounter++}`,
            name,
            input: {},
            _malformedInputRaw: candidate,
          });
        }
      }
    }
  }

  // Pattern 5 (opt-in, lowest priority): call-expression syntax as prose —
  // `write_file(path="calculator.py", content="def add…")`. This is EXACTLY the
  // shape the code-as-text reprompt elicits from qwen2.5-coder:7b (observed
  // live on the calculator session: told "emit the tool call", it printed the
  // complete, correct call in backticks — and the turn was discarded as text).
  // Only fires when every other pattern found nothing: it is a rescue for an
  // otherwise text-only turn, same family as paramRemap / toolNameAlias.
  if (firstType === null && results.length === 0 && opts?.callExpressions) {
    for (const call of parseCallExpressions(text, toolNames)) {
      spans?.push(call.span);
      results.push({ type: 'tool_use', id: `text_tc_${idCounter++}`, name: call.name, input: call.input });
    }
  }

  return results;
}

/** Fence languages that denote source code, where call syntax is ordinary code
 *  (`calculator.divide(10, 2)`) rather than an intended tool call. Kwarg-form +
 *  known-name checks already reject most of it; skipping these fences removes
 *  the rest. sh/json/unlabelled fences stay scannable — models put calls there. */
const SOURCE_FENCE_LANGS = new Set([
  'javascript',
  'js',
  'jsx',
  'typescript',
  'ts',
  'tsx',
  'python',
  'py',
  'go',
  'rust',
  'rs',
  'java',
  'c',
  'cpp',
  'c++',
  'csharp',
  'cs',
  'ruby',
  'rb',
  'php',
  'swift',
  'kotlin',
  'scala',
]);

/** Max call expressions accepted from one turn — a plan of a few steps is
 *  intent; dozens of matches is a document, not a call list. */
const MAX_CALL_EXPRESSIONS = 5;

/** End index of the `)` closing the paren opened at `openParen`, honoring
 *  quoted strings (double/single, backslash escapes). -1 when unterminated. */
function findCallParenEnd(text: string, openParen: number): number {
  let depth = 0;
  let quote: string | null = null; // single char, or a 3-char triple-quote token
  const limit = Math.min(text.length, openParen + 50_000);
  for (let i = openParen; i < limit; i++) {
    const c = text[i];
    if (quote) {
      if (quote.length === 3) {
        if (text.startsWith(quote, i)) {
          i += 2;
          quote = null;
        }
        continue;
      }
      if (c === '\\')
        i++; // skip the escaped char
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = c.repeat(3);
      if (text.startsWith(triple, i)) {
        quote = triple;
        i += 2;
      } else {
        quote = c;
      }
    } else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extract tool calls written as call expressions in prose. Requirements that
 * keep prose mentions from dispatching: the name must be a dispatchable tool,
 * not attribute access (`x.read_file(…)` is code, not a call), every argument
 * must be kwarg-form (`key=value` — positional calls are code or hand-waving),
 * at least one kwarg must be present, and source-language fences are skipped
 * entirely. Duplicate name+args pairs collapse to one call (models often print
 * the call once as narration and once as "let's proceed").
 */
export function parseCallExpressions(
  text: string,
  toolNames: Set<string>,
): Array<{ name: string; input: Record<string, unknown>; span: [number, number] }> {
  // Spans of source-language fenced blocks — candidates inside are skipped,
  // UNLESS the fence body itself begins with a known tool call: models that
  // think in Python put the call inside a ```python fence (observed live:
  // ```python\nwrite_file(path="calculator.py", content='''…''')```). Real
  // source files do not open with a tool-call expression, so a fence whose
  // first statement is one is a call carrier, not code to protect.
  const excluded: Array<[number, number]> = [];
  const fence = /```([\w+#]*)\s*\n([\s\S]*?)(?:```|$)/g;
  let fm: RegExpExecArray | null;
  while ((fm = fence.exec(text)) !== null) {
    if (!SOURCE_FENCE_LANGS.has(fm[1].toLowerCase())) continue;
    const opener = /^\s*([A-Za-z_]\w*)\s*\(/.exec(fm[2]);
    if (opener && isDispatchableName(opener[1], toolNames)) continue;
    excluded.push([fm.index, fm.index + fm[0].length]);
  }
  const inExcluded = (i: number) => excluded.some(([s, e]) => i >= s && i < e);

  const out: Array<{ name: string; input: Record<string, unknown>; span: [number, number] }> = [];
  const seen = new Set<string>();
  const candidate = /\b([A-Za-z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = candidate.exec(text)) !== null && out.length < MAX_CALL_EXPRESSIONS) {
    const name = m[1];
    const nameStart = m.index;
    if (inExcluded(nameStart)) continue;
    if (nameStart > 0 && (text[nameStart - 1] === '.' || /\w/.test(text[nameStart - 1]))) continue; // attribute access
    if (!isDispatchableName(name, toolNames)) continue;
    const openParen = m.index + m[0].length - 1;
    const closeParen = findCallParenEnd(text, openParen);
    if (closeParen === -1) continue;
    const inner = text.slice(openParen + 1, closeParen);
    // Every top-level argument must be kwarg-form; bail on positional/empty.
    const parts = splitTopLevelArgs(inner);
    if (parts.length === 0 || !parts.every((p) => /^\s*[A-Za-z_]\w*\s*=/.test(p))) continue;
    const parsed = parseMangledToolName(text.slice(nameStart, closeParen + 1));
    if (!parsed || Object.keys(parsed.input).length === 0) continue;
    // Placeholder echo: a model answering the code-as-text reprompt sometimes
    // copies its call template verbatim, placeholder included — observed live:
    // write_file(content="<the COMPLETE file — everything already in it PLUS
    // your new code>"). An angle-bracketed value is a template slot, not an
    // argument; dispatching it wrote garbage that only the syntax guard caught.
    const hasPlaceholderArg = Object.values(parsed.input).some(
      (v) => typeof v === 'string' && /^<[^<>]*>$/.test(v.trim()),
    );
    if (hasPlaceholderArg) continue;
    const key = `${parsed.name}:${JSON.stringify(parsed.input)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Strip wrapping backticks along with the call so no stray ` survives.
    let s: number = nameStart;
    let e: number = closeParen + 1;
    if (text[s - 1] === '`' && text[e] === '`') {
      s--;
      e++;
    }
    out.push({ name: parsed.name, input: parsed.input, span: [s, e] });
    candidate.lastIndex = closeParen + 1;
  }
  return out;
}

/** Fence language ↔ file extension sanity map for the fence-write synthesizer. */
const LANG_TO_EXTS: Record<string, string[]> = {
  python: ['py'],
  py: ['py'],
  javascript: ['js', 'mjs', 'cjs', 'jsx'],
  js: ['js', 'mjs', 'cjs', 'jsx'],
  typescript: ['ts', 'tsx'],
  ts: ['ts', 'tsx'],
  go: ['go'],
  rust: ['rs'],
  rs: ['rs'],
  ruby: ['rb'],
  rb: ['rb'],
  java: ['java'],
};

/** Workspace-file references (same shape as actionReprompt's FILE_PATH_RE, global). */
const FILE_REF_RE = /\b[\w./-]*\w+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cpp|c|rb|sh|yaml|yml|json|toml)\b/g;

/** Real-code heuristic shared with unappliedEdit: a keyword/operator plus ≥2 lines. */
const FENCE_CODE_STRUCTURE = /\b(function|const|let|var|def|class|return|import|export|if|for|while)\b|=>|[;{}]/;

/**
 * Synthesize the write_file call a code-as-text turn described but never made.
 *
 * The campaign corpus (30 qwen pairs, 2026-07-21): 20/27 on-arm failures die
 * on a turn whose text contains the COMPLETE, CORRECT target file in a
 * ```python fence plus "now let's write this to the file" — and zero tool
 * calls. Reprompting converts that shape ~10% of the time; using the fence
 * directly converts it deterministically. Fires only when the intent is
 * unambiguous:
 *   - the user's message names exactly ONE workspace file, and
 *   - the turn has an edit-shaped source fence (largest one wins), and
 *   - the fence language agrees with the file's extension (when both known).
 * The synthesized write still passes every write_file guard (syntax gate,
 * verify-before-rewrite, enforce-edit locks), so a partial snippet that would
 * corrupt the file is refused there, not written blind.
 */
export function synthesizeFenceWrite(
  text: string,
  userText: string,
  toolNames: Set<string>,
): { name: 'write_file'; input: { path: string; content: string } } | null {
  if (!toolNames.has('write_file')) return null;
  const refs = [...new Set(userText.match(FILE_REF_RE) ?? [])];
  if (refs.length !== 1) return null; // zero or ambiguous targets — do not guess
  const path = refs[0];
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();

  let best: { lang: string; body: string } | null = null;
  const fence = /```([\w+#]*)\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const lang = m[1].toLowerCase();
    const body = m[2];
    if (!SOURCE_FENCE_LANGS.has(lang)) continue;
    const lines = body.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length < 2 || !FENCE_CODE_STRUCTURE.test(body)) continue; // not edit-shaped
    if (/^\s*[A-Za-z_]\w*\s*\(/.test(body)) continue; // call carrier — pattern 5's job
    const exts = LANG_TO_EXTS[lang];
    if (exts && !exts.includes(ext)) continue; // fence/target language mismatch
    if (contentImportsTarget(body, path)) continue; // a consumer of the target is not the target
    if (!contentFitsTestTarget(body, path)) continue; // module code is not a test file
    if (!best || body.length > best.body.length) best = { lang, body };
  }
  if (!best) return null;
  return { name: 'write_file', input: { path, content: best.body.replace(/\s+$/, '') + '\n' } };
}

/**
 * True when `body` imports the module `path` names — `from calculator import…`
 * / `import calculator` / `require('./calculator')` for calculator.py. Content
 * that CONSUMES the target file cannot BE the target file. Observed live
 * (probe r1, 2026-07-21): asked to extend calculator.py, the model printed the
 * unittest file it planned to write NEXT, and the synthesizer wrote test code
 * over the calculator module — a clean parse, a clean extension match, and a
 * clobbered file. This is the check that stops it.
 */
/**
 * When the target is a test file (`test_X.*` / `X.test.*` / `X_test.*`), the
 * fence must LOOK like tests — a test definition, an assertion, or a reference
 * to the module under test. The mirror of contentImportsTarget: observed live
 * (campaign 3, ministral r1-on), asked to write test_calculator.py the model
 * printed the CALCULATOR MODULE in its fence and the synthesizer wrote module
 * code into the test file. Non-test targets always pass this check.
 */
function contentFitsTestTarget(body: string, targetPath: string): boolean {
  const base = (targetPath.split('/').pop() ?? targetPath).toLowerCase();
  const m = /^test[_-](.+)\.\w+$|^(.+?)[._-]tests?\.\w+$/.exec(base);
  if (!m) return true; // not a test file — no constraint
  const subject = (m[1] ?? m[2] ?? '').replace(/\.\w+$/, '');
  if (/\b(?:def\s+test|it\(|test\(|describe\(|assert|unittest|TestCase|expect\()/i.test(body)) return true;
  return subject.length > 0 && body.toLowerCase().includes(subject);
}

function contentImportsTarget(body: string, targetPath: string): boolean {
  const base = targetPath.split('/').pop() ?? targetPath;
  const mod = base.slice(0, base.lastIndexOf('.') === -1 ? undefined : base.lastIndexOf('.'));
  if (!mod) return false;
  const esc = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^\\s*(?:from\\s+${esc}\\b|import\\s+${esc}\\b)|require\\(['"]\\.?/?${esc}['"]\\)|from\\s+['"]\\.?/?${esc}(?:\\.js)?['"]`,
    'm',
  ).test(body);
}

/**
 * Strip blocks of text that the model is repeating verbatim from
 * earlier assistant messages in the conversation. Prevents the
 * model from echoing stale content (commit summaries, status
 * updates) that got stuck in conversation history.
 *
 * Only strips blocks of 200+ characters to avoid false positives on
 * short boilerplate. Skips content inside code blocks (``` fences)
 * so legitimate code examples never get eaten.
 */
export function stripRepeatedContent(text: string, messages: ChatMessage[]): string {
  const seenParagraphs = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const texts: string[] = [];
    if (typeof msg.content === 'string') {
      texts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          texts.push(block.text);
        }
      }
    }
    for (const t of texts) {
      for (const paragraph of t.split(/\n\n+/)) {
        const trimmed = paragraph.trim();
        if (trimmed.length >= 200) {
          seenParagraphs.add(trimmed);
        }
      }
    }
  }

  if (seenParagraphs.size === 0) return text;

  // Split the new text into paragraphs, preserving code blocks intact.
  const parts: string[] = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  let lastEnd = 0;
  let cbMatch;
  while ((cbMatch = codeBlockRegex.exec(text)) !== null) {
    if (cbMatch.index > lastEnd) {
      parts.push(text.slice(lastEnd, cbMatch.index));
    }
    parts.push('\0CB\0' + cbMatch[0]);
    lastEnd = cbMatch.index + cbMatch[0].length;
  }
  if (lastEnd < text.length) {
    parts.push(text.slice(lastEnd));
  }

  const filtered: string[] = [];
  for (const part of parts) {
    if (part.startsWith('\0CB\0')) {
      filtered.push(part.slice(4));
      continue;
    }
    const paragraphs = part.split(/\n\n+/);
    const kept = paragraphs.filter((p) => !seenParagraphs.has(p.trim()));
    filtered.push(kept.join('\n\n'));
  }

  return filtered
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
