import type { ChatMessage, ToolDefinition, ToolUseContentBlock } from '../../ollama/types.js';

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
export function parseTextToolCalls(text: string, tools: ToolDefinition[]): ToolUseContentBlock[] {
  const toolNames = new Set(tools.map((t) => t.name));
  const results: ToolUseContentBlock[] = [];
  let idCounter = 0;

  // Single combined regex matches all four patterns in one pass.
  // Groups: (1) function=name, (2) function body,
  //         (3) tool_call body, (4) json code fence body,
  //         (5) bare JSON object on its own line
  const combined =
    /<function=(\w+)>([\s\S]*?)<\/function>|<tool_call>\s*([\s\S]*?)\s*<\/tool_call>|```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```|(?:^|\n)(\{"name"\s*:[\s\S]*?\})\s*(?=\n|$)/g;

  // Track which pattern type matched first (for priority: fn > tool_call > json > bare)
  let firstType: 'fn' | 'tc' | 'json' | 'bare' | null = null;
  let match;

  while ((match = combined.exec(text)) !== null) {
    // Pattern 1: <function=name><parameter=key>value</parameter></function>
    if (match[1] !== undefined) {
      if (firstType === null) firstType = 'fn';
      if (firstType !== 'fn') continue;
      const name = match[1];
      if (!toolNames.has(name)) continue;
      const body = match[2];
      const input: Record<string, unknown> = {};
      const paramPattern = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;
      let pm;
      while ((pm = paramPattern.exec(body)) !== null) {
        input[pm[1]] = pm[2].trim();
      }
      results.push({ type: 'tool_use', id: `text_tc_${idCounter++}`, name, input });
    }
    // Pattern 2: <tool_call>JSON</tool_call>
    else if (match[3] !== undefined) {
      if (firstType === null) firstType = 'tc';
      if (firstType !== 'tc') continue;
      try {
        const parsed = JSON.parse(match[3]);
        const name = parsed.name || parsed.function?.name;
        const args = parsed.arguments || parsed.function?.arguments || parsed.parameters || {};
        if (name && toolNames.has(name)) {
          const input = typeof args === 'string' ? JSON.parse(args) : args;
          results.push({ type: 'tool_use', id: `text_tc_${idCounter++}`, name, input });
        }
      } catch {
        /* skip malformed */
      }
    }
    // Pattern 3: ```json\n{...}\n```
    else if (match[4] !== undefined) {
      if (firstType === null) firstType = 'json';
      if (firstType !== 'json') continue;
      try {
        const parsed = JSON.parse(match[4]);
        const name = parsed.name || parsed.tool || parsed.function;
        const args = parsed.arguments || parsed.parameters || parsed.input || {};
        if (name && typeof name === 'string' && toolNames.has(name)) {
          const input = typeof args === 'string' ? JSON.parse(args) : args;
          results.push({ type: 'tool_use', id: `text_tc_${idCounter++}`, name, input });
        }
      } catch {
        /* skip malformed */
      }
    }
    // Pattern 4: bare JSON object on its own line — {"name":"...","parameters":{...}}
    // Some Ollama models emit tool calls this way without any wrapper tags or fences.
    // Only match when the object's "name" is a known tool to avoid false positives on
    // legitimate JSON in the response.
    else if (match[5] !== undefined) {
      if (firstType === null) firstType = 'bare';
      if (firstType !== 'bare') continue;
      try {
        const parsed = JSON.parse(match[5]);
        const name = parsed.name;
        const args = parsed.arguments || parsed.parameters || parsed.input || {};
        if (name && typeof name === 'string' && toolNames.has(name)) {
          const input = typeof args === 'string' ? JSON.parse(args) : args;
          results.push({ type: 'tool_use', id: `text_tc_${idCounter++}`, name, input });
        }
      } catch {
        /* skip malformed */
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
