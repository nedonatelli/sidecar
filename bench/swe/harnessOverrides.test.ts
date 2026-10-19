import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolDefinition } from '../../src/ollama/types.js';
import { loadHarnessOverrides, applyToSystemPrompt, applyToToolDefinitions } from './harnessOverrides.js';

const tool = (name: string, description: string): ToolDefinition => ({
  name,
  description,
  input_schema: { type: 'object', properties: {} },
});

let files: string[] = [];
const write = (content: unknown) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-')), 'cand.json');
  fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
  files.push(path.dirname(f));
  return f;
};
afterEach(() => {
  for (const d of files) fs.rmSync(d, { recursive: true, force: true });
  files = [];
});

describe('harness overrides', () => {
  it('loads a candidate and records a content hash that changes with the content', () => {
    const a = loadHarnessOverrides(write({ name: 'cand-a', systemPromptAppend: 'x' }));
    const b = loadHarnessOverrides(write({ name: 'cand-a', systemPromptAppend: 'y' }));
    expect(a.overrides.name).toBe('cand-a');
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('rejects a candidate without a name or with an empty find', () => {
    expect(() => loadHarnessOverrides(write({ systemPromptAppend: 'x' }))).toThrow(/name/);
    expect(() => loadHarnessOverrides(write({ name: 'c', systemPromptReplace: [{ find: '', replace: 'x' }] }))).toThrow(
      /find/,
    );
  });

  it('appends to and replaces exact text in the system prompt', () => {
    const out = applyToSystemPrompt('Rule 1. Be brief.\nRule 2. Test.', {
      name: 'c',
      systemPromptReplace: [{ find: 'Rule 2. Test.', replace: 'Rule 2. Run the module tests.' }],
      systemPromptAppend: 'Rule 3. Check regressions.',
    });
    expect(out).toBe('Rule 1. Be brief.\nRule 2. Run the module tests.\n\nRule 3. Check regressions.\n');
  });

  it('throws when a find is missing or ambiguous instead of silently running the base prompt', () => {
    expect(() =>
      applyToSystemPrompt('abc', { name: 'c', systemPromptReplace: [{ find: 'zzz', replace: '' }] }),
    ).toThrow(/0 times/);
    expect(() => applyToSystemPrompt('aa', { name: 'c', systemPromptReplace: [{ find: 'a', replace: '' }] })).toThrow(
      /2 times/,
    );
  });

  it('keeps $ sequences in a replacement literal', () => {
    expect(applyToSystemPrompt('X', { name: 'c', systemPromptReplace: [{ find: 'X', replace: 'cost $& $1' }] })).toBe(
      'cost $& $1',
    );
  });

  it('appends to or replaces a tool description, leaving other tools untouched', () => {
    const defs = [tool('run_command', 'Run a shell command.'), tool('grep', 'Search.')];
    const out = applyToToolDefinitions(defs, {
      name: 'c',
      toolDescriptions: {
        run_command: { append: 'Run the module tests before finishing.' },
        grep: { replace: 'Find text.' },
      },
    });
    expect(out[0].description).toBe('Run a shell command. Run the module tests before finishing.');
    expect(out[1].description).toBe('Find text.');
    expect(defs[0].description).toBe('Run a shell command.');
  });

  it('throws on a tool the catalog does not offer', () => {
    expect(() =>
      applyToToolDefinitions([tool('grep', 'g')], { name: 'c', toolDescriptions: { run_tests: { append: 'x' } } }),
    ).toThrow(/not in the catalog/);
  });
});
