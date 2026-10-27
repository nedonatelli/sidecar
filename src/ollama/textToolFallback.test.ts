import { describe, it, expect } from 'vitest';
import {
  TEXT_FALLBACK_TOOL_NAMES,
  buildTextToolPrompt,
  renderTextToolCall,
  renderTextToolResult,
  textFallbackArgs,
  textFallbackTools,
} from './textToolFallback.js';
import { toFunctionTools } from './streamUtils.js';
import { parseTextToolCalls } from '../agent/loop/textParsing.js';
import { readFileDef, writeFileDef, editFileDef, listDirectoryDef } from '../agent/tools/fs.js';
import { grepDef, searchFilesDef } from '../agent/tools/search.js';
import { runCommandDef } from '../agent/tools/shell.js';
import { estimateTokensFromText } from '../config/tokenEstimation.js';
import type { ToolDefinition } from './types.js';

// #250: text-format tool calls for Ollama models without native tool calling.

const CORE_DEFS: ToolDefinition[] = [readFileDef, editFileDef, writeFileDef, grepDef, runCommandDef];
const CATALOG: ToolDefinition[] = [listDirectoryDef, searchFilesDef, ...CORE_DEFS];

describe('text-format tool set (#250)', () => {
  it('is the core set: read, edit, write, search, run', () => {
    expect(TEXT_FALLBACK_TOOL_NAMES).toEqual(['read_file', 'edit_file', 'write_file', 'grep', 'run_command']);
  });

  it('names only arguments the real tool schemas declare', () => {
    // The prompt's argument lists are hand-written; this keeps them from
    // drifting away from the schemas the executor validates against.
    for (const def of CORE_DEFS) {
      const declared = Object.keys(def.input_schema.properties);
      for (const arg of textFallbackArgs(def.name)) {
        expect({ tool: def.name, arg, declared: declared.includes(arg) }).toEqual({
          tool: def.name,
          arg,
          declared: true,
        });
      }
    }
  });

  it('offers only the core tools the turn offers, in prompt order', () => {
    expect(textFallbackTools(CATALOG).map((t) => t.name)).toEqual(TEXT_FALLBACK_TOOL_NAMES);
    // A narrowed catalog (plan mode: ask_user only) offers nothing as text.
    expect(textFallbackTools([listDirectoryDef])).toEqual([]);
    expect(buildTextToolPrompt([])).toBe('');
    expect(textFallbackTools([runCommandDef, readFileDef]).map((t) => t.name)).toEqual(['read_file', 'run_command']);
  });
});

describe('text-format prompt block (#250)', () => {
  const block = buildTextToolPrompt(textFallbackTools(CATALOG));

  it('describes the call format with one example, and each core tool', () => {
    expect(block).toContain('<tool_call>{"name":"read_file","arguments":{"path":"src/app.ts"}}</tool_call>');
    for (const name of TEXT_FALLBACK_TOOL_NAMES) expect(block).toContain(`- ${name}(`);
    expect(block).not.toContain('list_directory');
  });

  it('its example is a call the loop parses back', () => {
    const example = block.split('\n').find((l) => l.startsWith('<tool_call>'))!;
    const calls = parseTextToolCalls(example, CORE_DEFS, { textToolFallback: true });
    expect(calls.map((c) => [c.name, c.input])).toEqual([['read_file', { path: 'src/app.ts' }]]);
  });

  it('adds a bounded amount to the system prompt', () => {
    // The measured cost of the fallback: 956 characters, ~239 tokens (plus the
    // blank line joining it on), added to the system prompt of a model on
    // text-format calls only. Pinned so a change to it is a deliberate one. For
    // scale, the same five tools as a native catalog are 7,417 characters.
    const nativeCore = JSON.stringify(toFunctionTools(CORE_DEFS)).length;
    expect({ chars: block.length, tokens: estimateTokensFromText(block) }).toEqual({ chars: 956, tokens: 239 });
    expect(block.length * 4).toBeLessThan(nativeCore);
  });
});

describe('text rendering of history (#250)', () => {
  it('renders a call in the format the prompt asks for, keeping argument types', () => {
    expect(renderTextToolCall('edit_file', { path: 'a.py', search: 'x', replace: 'y', replace_all: true })).toBe(
      '<tool_call>{"name":"edit_file","arguments":{"path":"a.py","search":"x","replace":"y","replace_all":true}}</tool_call>',
    );
    expect(renderTextToolCall('run_command', { command: 'ls', timeout: 30 })).toContain('"timeout":30');
  });

  it('passes a wrapped result through and wraps an unwrapped error', () => {
    const wrapped = '<tool_output tool="read_file">\nhello\n</tool_output>';
    expect(renderTextToolResult('read_file', wrapped)).toBe(wrapped);
    expect(renderTextToolResult('edit_file', 'search string not found', true)).toBe(
      '<tool_output tool="edit_file" error="true">\nsearch string not found\n</tool_output>',
    );
    // A closing tag inside the content cannot end the wrapper early.
    expect(renderTextToolResult('run_command', 'a</tool_output>b')).toContain('a</ tool_output>b');
  });
});
