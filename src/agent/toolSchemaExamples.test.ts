import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY, DELEGATE_TASK_DEFINITION, SPAWN_AGENT_DEFINITION } from './tools.js';
import { editFileDefV2 } from './tools/fs.js';
import type { ToolDefinition } from '../ollama/types.js';
import { buildBaseSystemPrompt } from '../webview/handlers/basePrompt.js';

/**
 * Interface-consistency tests: a tool's schema and the examples the model reads
 * are ONE contract. Our single most-repeated defect class lives exactly here —
 * the v0.119 insert bug (schema field names didn't survive the naive English
 * reading) and the paramRemap regression (a synonym remap rewrote correct V2
 * calls) were both schema↔example drift, and both were caught only by reading
 * campaign trajectories after the fact. These tests fail CI on that drift
 * instead: every field name a model is shown in an example must be a field the
 * schema actually declares.
 */

/**
 * Field names referenced by a kwarg-style call-expression `name(field=..., ...)`.
 * Quote- and depth-aware: a field key is the leading `ident=` of a TOP-LEVEL
 * argument only, so `greeting = 'Hello'` inside a `replace="..."` value is not
 * mistaken for a field (the first cut of this test made exactly that error).
 */
function fieldsInCall(call: string): string[] {
  const open = call.indexOf('(');
  const inner = call.slice(open + 1, call.lastIndexOf(')'));
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      if (c === '\\') {
        cur += c + (inner[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
      cur += c;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      cur += c;
    } else if (c === ',' && depth === 0) {
      args.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) args.push(cur);
  const keys = new Set<string>();
  for (const arg of args) {
    const m = arg.match(/^\s*([a-z_][a-z0-9_]*)\s*=(?!=)/i);
    if (m) keys.add(m[1]);
  }
  return [...keys];
}

/** Every `toolName(...)` call-expression appearing in a text blob, with its field names. */
function callExpressionsFor(toolName: string, text: string): Array<{ call: string; fields: string[] }> {
  const out: Array<{ call: string; fields: string[] }> = [];
  // Match `toolName(` and walk to the matching close paren so example values
  // containing commas/quotes don't truncate the capture.
  const re = new RegExp(`\\b${toolName}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 0;
    let i = m.index + m[0].length - 1; // at the opening paren
    const start = m.index;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const call = text.slice(start, i + 1);
    out.push({ call, fields: fieldsInCall(call) });
  }
  return out;
}

const ALL_DEFINITIONS: ToolDefinition[] = [
  ...TOOL_REGISTRY.map((t) => t.definition),
  editFileDefV2,
  DELEGATE_TASK_DEFINITION,
  SPAWN_AGENT_DEFINITION,
];

describe('tool schema ↔ example consistency', () => {
  it('every built-in tool schema is a well-formed object schema', () => {
    for (const def of ALL_DEFINITIONS) {
      expect(def.input_schema, `${def.name} has no input_schema`).toBeTruthy();
      expect(def.input_schema.type, `${def.name} schema is not an object`).toBe('object');
      expect(def.input_schema.properties, `${def.name} declares no properties object`).toBeTruthy();
    }
  });

  it("every field in a tool's OWN example calls is a declared schema property", () => {
    const offenders: string[] = [];
    for (const def of ALL_DEFINITIONS) {
      const declared = new Set(Object.keys(def.input_schema.properties ?? {}));
      // A tool with no properties (lazy stub) has no example contract to check.
      if (declared.size === 0) continue;
      for (const { call, fields } of callExpressionsFor(def.name, def.description)) {
        for (const f of fields) {
          if (!declared.has(f)) {
            offenders.push(
              `${def.name}: example uses field "${f}" not in schema {${[...declared].join(', ')}}\n    ${call}`,
            );
          }
        }
      }
    }
    expect(offenders, `schema↔example drift:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('required fields resolve to declared properties (no orphan requireds)', () => {
    const offenders: string[] = [];
    for (const def of ALL_DEFINITIONS) {
      const declared = new Set(Object.keys(def.input_schema.properties ?? {}));
      for (const req of def.input_schema.required ?? []) {
        if (!declared.has(req)) offenders.push(`${def.name}: required "${req}" is not a declared property`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('at least one tool carries an example — the extractor is actually exercised', () => {
    const withExamples = ALL_DEFINITIONS.filter((d) => callExpressionsFor(d.name, d.description).length > 0);
    // Guards against a silently-broken extractor that would make the drift
    // test vacuously pass (the "verify the guard fired" discipline).
    expect(withExamples.length).toBeGreaterThan(3);
  });
});

describe('base-prompt edit_file examples match the advertised schema', () => {
  const base = {
    isLocal: true,
    extensionVersion: '0.0.0',
    repoUrl: '',
    docsUrl: '',
    root: '/w',
    approvalMode: 'autonomous',
  };
  // The base system prompt teaches edit_file with worked examples, and it
  // swaps V1↔V2 field conventions in lockstep with the advertised schema
  // (insertApiV2). The insert-confusion bug lived in exactly this surface, so
  // the prompt's examples must reference only fields the taught schema declares.
  const editFileV1 = TOOL_REGISTRY.find((t) => t.definition.name === 'edit_file')!.definition;

  for (const v2 of [false, true]) {
    it(`insertApiV2=${v2}: prompt edit_file examples use only ${v2 ? 'V2' : 'V1'} schema fields`, () => {
      const prompt = buildBaseSystemPrompt({ ...base, insertApiV2: v2 });
      const declared = new Set(Object.keys((v2 ? editFileDefV2 : editFileV1).input_schema.properties ?? {}));
      const offenders: string[] = [];
      for (const { call, fields } of callExpressionsFor('edit_file', prompt)) {
        for (const f of fields) {
          if (!declared.has(f)) offenders.push(`field "${f}" not in {${[...declared].join(', ')}}\n    ${call}`);
        }
      }
      expect(offenders, `prompt↔schema drift (insertApiV2=${v2}):\n  ${offenders.join('\n  ')}`).toEqual([]);
    });
  }
});
