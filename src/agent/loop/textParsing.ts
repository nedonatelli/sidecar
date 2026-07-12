import type { ChatMessage, ToolDefinition, ToolUseContentBlock } from '../../ollama/types.js';
import { resolveToolNameAlias } from '../executor/toolNameAlias.js';

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
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
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
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
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
export function parseTextToolCallsCleaned(
  text: string,
  tools: ToolDefinition[],
): { calls: ToolUseContentBlock[]; cleanedText: string } {
  const spans: Array<[number, number]> = [];
  const calls = parseTextToolCallsInternal(text, tools, spans);
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

export function parseTextToolCalls(text: string, tools: ToolDefinition[]): ToolUseContentBlock[] {
  return parseTextToolCallsInternal(text, tools);
}

function parseTextToolCallsInternal(
  text: string,
  tools: ToolDefinition[],
  spans?: Array<[number, number]>,
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
    // Seed starts from line-anchored `{`, then follow concatenated objects:
    // models emit back-to-back calls with no separator (`…}}{"name":…`) and
    // the second object never sits at a line start (observed live: llama3.2
    // emitted run_command + create_file fused; only the first was found).
    const starts: number[] = [];
    const lineStart = /(?:^|\n)\{/g;
    let lsMatch;
    while ((lsMatch = lineStart.exec(text)) !== null) {
      starts.push(lsMatch.index + lsMatch[0].length - 1);
    }
    const seen = new Set<number>();
    while (starts.length > 0) {
      const start = starts.shift()!;
      if (seen.has(start)) continue;
      seen.add(start);
      let depth = 0;
      let end = -1;
      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) continue;
      // Another object fused directly onto this one — scan it too.
      if (text[end + 1] === '{') starts.push(end + 1);
      const candidate = text.slice(start, end + 1);
      // Must contain "name" key to avoid grabbing every JSON blob.
      if (!candidate.includes('"name"')) continue;
      try {
        const parsed = JSON.parse(candidate);
        const name = parsed.name;
        const args = parsed.arguments || parsed.args || parsed.parameters || parsed.input || {};
        if (name && typeof name === 'string' && isDispatchableName(name, toolNames)) {
          firstType = 'bare';
          const input = typeof args === 'string' ? JSON.parse(args) : args;
          spans?.push([start, end + 1]);
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

  return results;
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
