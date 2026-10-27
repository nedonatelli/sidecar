import type { ToolDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Text-format tool calls for Ollama models without native tool calling (#250).
//
// When Ollama reports a model has no `tools` capability, the request can't
// carry a tool catalog, and the model could only chat. With
// `sidecar.ollama.textToolFallback` on, the backend instead describes a small
// core tool set in the system prompt, asks for calls as JSON in `<tool_call>`
// tags, and renders earlier calls and results as plain text the model can read
// without a tool role. The loop's history keeps its canonical tool_use /
// tool_result blocks (ADR-002); this rendering exists only in the request.
// The replies go through the loop's existing text-form parser, so validation
// and approvals are the same path native calls take.
// ---------------------------------------------------------------------------

/**
 * How each core tool is described to a text-format model: argument names
 * (`?` marks optional) and one line of purpose. Hand-written rather than
 * generated from the schemas: the full descriptions are the reason the
 * catalog is large, and a model reading prose needs only this much. The
 * argument names are pinned against the real schemas by a test.
 */
const CORE_TOOLS: ReadonlyArray<{ name: string; args: string; summary: string; example: Record<string, unknown> }> = [
  { name: 'read_file', args: 'path, start_line?, end_line?', summary: 'read a file', example: { path: 'src/app.ts' } },
  {
    name: 'edit_file',
    args: 'path, search, replace, replace_all?',
    summary: 'replace the exact text `search` with `replace` in a file',
    example: { path: 'src/app.ts', search: 'a', replace: 'b' },
  },
  {
    name: 'write_file',
    args: 'path, content',
    summary: 'create a file, or overwrite all of it',
    example: { path: 'notes.md', content: 'x' },
  },
  {
    name: 'grep',
    args: 'pattern, path?',
    summary: 'search file contents for text or a regex',
    example: { pattern: 'TODO' },
  },
  {
    name: 'run_command',
    args: 'command, timeout?',
    summary: 'run a shell command (timeout in seconds)',
    example: { command: 'npm test' },
  },
];

/** The tool names a text-format model is offered, in prompt order. */
export const TEXT_FALLBACK_TOOL_NAMES: readonly string[] = CORE_TOOLS.map((t) => t.name);

/** The argument list shown for a core tool, for the schema pin test. */
export function textFallbackArgs(name: string): string[] {
  const entry = CORE_TOOLS.find((t) => t.name === name);
  return entry ? entry.args.split(',').map((a) => a.trim().replace(/\?$/, '')) : [];
}

/**
 * The core tools present in `tools`, in prompt order. A catalog the mode has
 * narrowed (plan mode offers only `ask_user`) narrows this too: a tool the turn
 * does not offer is never described.
 */
export function textFallbackTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return TEXT_FALLBACK_TOOL_NAMES.flatMap((n) => {
    const t = byName.get(n);
    return t ? [t] : [];
  });
}

/** One call in the format the fallback asks for; also how history renders past calls. */
export function renderTextToolCall(name: string, input: Record<string, unknown>): string {
  return `<tool_call>${JSON.stringify({ name, arguments: input })}</tool_call>`;
}

/**
 * A tool result as user text. Successful results already arrive wrapped in
 * `<tool_output tool="…">` by the executor, which also defuses a closing tag
 * inside them; those pass through as-is. SideCar's own error strings are not
 * wrapped there, so they are wrapped here, marked as errors, to say which tool
 * they answer.
 */
export function renderTextToolResult(toolName: string, content: string, isError?: boolean): string {
  if (content.startsWith('<tool_output')) return content;
  const safe = content.replace(/<\/tool_output/g, '</ tool_output');
  return `<tool_output tool="${toolName}"${isError ? ' error="true"' : ''}>\n${safe}\n</tool_output>`;
}

/**
 * The system-prompt block for a text-format model: the call format with one
 * example, and the offered tools. Kept compact because it is paid on every
 * request; its size is pinned by a test. Empty when no core tool is offered.
 */
export function buildTextToolPrompt(tools: readonly ToolDefinition[]): string {
  const offered = new Set(tools.map((t) => t.name));
  const entries = CORE_TOOLS.filter((t) => offered.has(t.name));
  if (entries.length === 0) return '';
  const example = renderTextToolCall(entries[0].name, entries[0].example);
  return [
    '## Calling tools',
    'You have no native tool calling. To use a tool, write a JSON object in <tool_call> tags, outside any code block:',
    example,
    '- One <tool_call> per call; several in one reply are fine. Then stop: results come back in the next message as <tool_output tool="..."> blocks.',
    '- Arguments are JSON: quote strings, leave numbers and true/false unquoted, write newlines in code as \\n.',
    '- Only a call you mean to make runs: a <tool_call> inside a code block or quoted in a sentence is ignored.',
    '',
    'Tools (? = optional):',
    ...entries.map((t) => `- ${t.name}(${t.args}): ${t.summary}`),
  ].join('\n');
}
