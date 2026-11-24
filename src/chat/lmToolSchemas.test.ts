import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { TOOL_REGISTRY } from '../agent/tools.js';
import { EXPOSED_TOOLS, lmInputSchema, relativizePathArgs } from './lmTools.js';

// #495: the languageModelTools entries in package.json declared no
// inputSchema, so Copilot and other callers guessed the argument names. They
// are generated from the registry; this test keeps them from drifting.
//
// To regenerate after changing a registry schema:
//   SIDECAR_SYNC_LM_SCHEMAS=1 npx vitest run src/chat/lmToolSchemas.test.ts

interface LmToolEntry {
  name: string;
  inputSchema?: unknown;
  toolReferenceName?: string;
  canBeReferencedInPrompt?: boolean;
  tags?: string[];
}

const PKG_PATH = path.join(__dirname, '..', '..', 'package.json');

/** What package.json should declare for an exposed tool, on top of its name, displayName and modelDescription. */
function expectedFields(toolName: string): Omit<LmToolEntry, 'name'> {
  const def = TOOL_REGISTRY.find((t) => t.definition.name === toolName)!.definition;
  return {
    toolReferenceName: `sidecar_${toolName}`,
    canBeReferencedInPrompt: true,
    tags: ['sidecar'],
    inputSchema: lmInputSchema(def),
  };
}

if (process.env.SIDECAR_SYNC_LM_SCHEMAS === '1') {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const tools = pkg.contributes.languageModelTools as LmToolEntry[];
  pkg.contributes.languageModelTools = tools.map((t) => {
    const toolName = t.name.replace(/^sidecar_/, '');
    return EXPOSED_TOOLS.includes(toolName) ? { ...t, ...expectedFields(toolName) } : t;
  });
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
}

describe('languageModelTools in package.json (#495)', () => {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const entries = pkg.contributes.languageModelTools as LmToolEntry[];

  it.each(EXPOSED_TOOLS)('sidecar_%s declares the registry schema and can be referenced', (toolName) => {
    const entry = entries.find((t) => t.name === `sidecar_${toolName}`);
    expect(entry, `package.json has no sidecar_${toolName}`).toBeDefined();
    const want = expectedFields(toolName);
    expect(entry!.inputSchema).toEqual(want.inputSchema);
    expect(entry!.toolReferenceName).toBe(want.toolReferenceName);
    expect(entry!.canBeReferencedInPrompt).toBe(true);
    expect(entry!.tags).toEqual(want.tags);
  });

  it('path arguments say an absolute path inside the workspace works', () => {
    const schema = expectedFields('read_file').inputSchema as { properties: Record<string, { description: string }> };
    expect(schema.properties.path.description).toBe(
      'Relative file path from the project root. An absolute path inside the workspace also works.',
    );
  });
});

describe('relativizePathArgs (#495)', () => {
  const root = path.resolve('/work/proj');

  it('makes an absolute path inside the workspace relative, with forward slashes', () => {
    expect(relativizePathArgs({ path: path.join(root, 'src', 'a.ts'), mode: 'full' }, root)).toEqual({
      path: 'src/a.ts',
      mode: 'full',
    });
    expect(relativizePathArgs({ file: path.join(root, 'tests', 'test_a.py') }, root)).toEqual({
      file: 'tests/test_a.py',
    });
  });

  it('turns the workspace root itself into "."', () => {
    expect(relativizePathArgs({ path: root }, root)).toEqual({ path: '.' });
  });

  it('leaves a path outside the workspace for the tool to refuse', () => {
    const outside = path.resolve(root, '..', 'other', 'b.ts');
    expect(relativizePathArgs({ path: outside }, root)).toEqual({ path: outside });
  });

  it('leaves relative paths, other arguments and odd inputs alone', () => {
    const args = { path: 'src/a.ts', command: path.join(root, 'x.sh') };
    expect(relativizePathArgs(args, root)).toBe(args);
    expect(relativizePathArgs(undefined, root)).toEqual({});
    expect(relativizePathArgs({ path: path.join(root, 'a') }, '')).toEqual({ path: path.join(root, 'a') });
  });
});
