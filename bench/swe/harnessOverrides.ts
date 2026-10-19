import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { ToolDefinition } from '../../src/ollama/types.js';

/**
 * A candidate harness edit for a refinement experiment: changes to the text
 * the model sees -- the system prompt and tool descriptions -- with the model,
 * the loop and every gate untouched. Loaded from the JSON file named by
 * SIDECAR_SWE_HARNESS_OVERRIDES, so a candidate is data, versioned and hashed,
 * not a code change. Harness-only: the product never reads it.
 *
 * {
 *   "name": "regression-check-v1",
 *   "systemPromptAppend": "...",
 *   "systemPromptReplace": [{ "find": "exact text", "replace": "new text" }],
 *   "toolDescriptions": { "run_command": { "append": "..." } }
 * }
 */
export interface HarnessOverrides {
  name: string;
  systemPromptAppend?: string;
  systemPromptReplace?: { find: string; replace: string }[];
  toolDescriptions?: Record<string, { append?: string; replace?: string }>;
}

export interface LoadedOverrides {
  overrides: HarnessOverrides;
  /** sha256 of the file, so a run records exactly which candidate it used. */
  sha256: string;
  path: string;
}

/** Parse and validate an overrides file; throws on anything malformed so a typo can't silently run the base harness. */
export function loadHarnessOverrides(file: string): LoadedOverrides {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as HarnessOverrides;
  if (!parsed || typeof parsed.name !== 'string' || !parsed.name.trim()) {
    throw new Error(`harness overrides ${file}: "name" is required`);
  }
  for (const r of parsed.systemPromptReplace ?? []) {
    if (typeof r.find !== 'string' || !r.find || typeof r.replace !== 'string') {
      throw new Error(
        `harness overrides ${file}: every systemPromptReplace entry needs non-empty "find" and a "replace"`,
      );
    }
  }
  return { overrides: parsed, sha256: createHash('sha256').update(raw).digest('hex'), path: file };
}

/**
 * The system prompt with the candidate applied. A `find` that does not occur
 * exactly once throws: the base prompt changed under the candidate, and a
 * silent no-op would measure the base harness under the candidate's name.
 */
export function applyToSystemPrompt(prompt: string, o: HarnessOverrides): string {
  let out = prompt;
  for (const { find, replace } of o.systemPromptReplace ?? []) {
    const count = out.split(find).length - 1;
    if (count !== 1) {
      throw new Error(`harness override "${o.name}": systemPromptReplace find occurs ${count} times, expected 1`);
    }
    out = out.replace(find, () => replace);
  }
  if (o.systemPromptAppend) out = `${out.trimEnd()}\n\n${o.systemPromptAppend.trim()}\n`;
  return out;
}

/** Tool definitions with the candidate's description changes; an unknown tool name throws for the same reason. */
export function applyToToolDefinitions(defs: ToolDefinition[], o: HarnessOverrides): ToolDefinition[] {
  const changes = o.toolDescriptions ?? {};
  for (const name of Object.keys(changes)) {
    if (!defs.some((d) => d.name === name)) {
      throw new Error(`harness override "${o.name}": tool "${name}" is not in the catalog`);
    }
  }
  return defs.map((d) => {
    const c = changes[d.name];
    if (!c) return d;
    const base = c.replace ?? d.description;
    return { ...d, description: c.append ? `${base.trimEnd()} ${c.append.trim()}` : base };
  });
}
