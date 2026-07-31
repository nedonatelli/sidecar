import type { ToolDefinition } from '../../src/ollama/types.js';

// ---------------------------------------------------------------------------
// Tool-surface cases — BFCL's method pointed at SideCar's OWN tools.
//
// Why this exists. Two defects this month were not model failures but API
// failures, and both took a day of agent-loop sweeps to find:
//
//   • edit_file advertised `insert_after` as the PAYLOAD while its name reads
//     as a POSITION, and declared no field for the payload at all — so a model
//     taking the plain-English reading could not express the intent. gemma4
//     produced ten pathological events under it and zero once the payload had
//     a home.
//   • get_diagnostics returned "No diagnostics" for 30 of 33 real calls because
//     it read a cache nothing had populated, and told the model that empty
//     result was authoritative.
//
// Neither needed an agent loop to find. One model call against the REAL
// advertised schema would have shown it in seconds. That is what this measures.
//
// The scoring separates two things that the agent loop conflates:
//   RAW        — what the model actually emitted.
//   REPAIRED   — what it became after paramRemap / coerceParamTypes.
// A case that is raw-bad but repaired-good means the SCAFFOLD is load-bearing
// for that model; that number is the honest measure of how much repair earns.
//
// Schemas are read from TOOL_REGISTRY, never copied here — a case must break
// when the advertised surface changes, which is the entire point.
// ---------------------------------------------------------------------------

export interface ToolSurfaceCase {
  id: string;
  /** Tool the task should provoke. */
  tool: string;
  /** Extra tools to advertise alongside it, so the model has to CHOOSE. */
  alsoOffer?: string[];
  /** The user turn. Should make exactly one tool the obviously right move. */
  task: string;
  /** Files the model is told exist, rendered into the system prompt. */
  workspace?: Record<string, string>;
  /**
   * Does the (repaired) input express the intent? Return a reason when it does
   * not. Runs only if the call passed real schema validation.
   */
  expresses: (input: Record<string, unknown>) => string | null;
}

const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

export const TOOL_SURFACE_CASES: ToolSurfaceCase[] = [
  // --- edit_file: the surface that produced this month's worst defect --------
  {
    id: 'edit-add-function',
    tool: 'edit_file',
    task:
      'calculator.py contains exactly:\n\ndef add(a, b):\n    return a + b\n\n' +
      'Add a new function multiply(a, b) that returns a * b, after add. Use the edit_file tool.',
    workspace: { 'calculator.py': 'def add(a, b):\n    return a + b\n' },
    expresses: (i) => {
      if (i.path !== 'calculator.py') return `path=${JSON.stringify(i.path)}, expected "calculator.py"`;
      if (!nonEmpty(i.search)) return 'search missing — cannot locate the edit';
      if (!nonEmpty(i.replace)) return 'replace missing — nothing to write';
      // The trap insert_* existed for: a `replace` that drops the anchor MEANS
      // delete it. Adding code requires the anchor to survive.
      const r = String(i.replace);
      if (!r.includes('multiply')) return 'replace does not contain the new function';
      if (
        !String(i.search)
          .split('\n')
          .every((l) => r.includes(l.trim()) || l.trim() === '')
      )
        return 'replace drops the search anchor — this edit would DELETE it, not add alongside';
      return null;
    },
  },
  {
    id: 'edit-rename-symbol',
    tool: 'edit_file',
    task:
      'The file at path `utils.ts` (workspace root, not in a subdirectory) contains exactly:\n\n' +
      'export function greet(name: string) {\n  return `Hi ${name}`;\n}\n\n' +
      'Rename greet to welcome. Use the edit_file tool with path exactly "utils.ts".',
    workspace: { 'utils.ts': 'export function greet(name: string) {\n  return `Hi ${name}`;\n}\n' },
    expresses: (i) => {
      // Accept a plausible directory prefix: the task names the file, and
      // penalising `src/utils.ts` would measure prompt precision, not the tool
      // surface. Only a DIFFERENT file is a failure.
      if (!String(i.path ?? '').endsWith('utils.ts')) return `path=${JSON.stringify(i.path)}, expected utils.ts`;
      if (!nonEmpty(i.search) || !String(i.search).includes('greet')) return 'search does not target greet';
      if (!nonEmpty(i.replace) || !String(i.replace).includes('welcome')) return 'replace does not introduce welcome';
      return null;
    },
  },

  // --- ask_user: 9 of 18 historical calls double-encoded `options` ----------
  {
    id: 'ask-ambiguous-caching',
    tool: 'ask_user',
    task: 'Add caching. (You do not know whether in-memory or Redis is wanted, and it materially changes the code.)',
    expresses: (i) => {
      if (!nonEmpty(i.question)) return 'question missing';
      if (i.options === undefined) return null; // options is legitimately optional
      if (!Array.isArray(i.options)) return `options is ${typeof i.options}, not an array`;
      if (!i.options.every((o) => typeof o === 'string')) return 'options contains non-strings';
      return null;
    },
  },

  // --- read_file: 11 ENOENT + 5 missing-path historically ------------------
  {
    id: 'read-named-file',
    tool: 'read_file',
    task: 'What does src/config/settings.ts contain? Read it.',
    workspace: { 'src/config/settings.ts': '// settings\n' },
    expresses: (i) =>
      i.path === 'src/config/settings.ts'
        ? null
        : `path=${JSON.stringify(i.path)}, expected the file named in the task`,
  },

  // --- choosing between tools: grep vs read_file ---------------------------
  {
    id: 'search-not-read',
    tool: 'grep',
    alsoOffer: ['read_file', 'search_files'],
    task: 'Which files mention TODO? Search the whole workspace.',
    expresses: (i) => (nonEmpty(i.pattern) ? null : 'pattern missing'),
  },

  // --- write_file: whole-file creation, not an edit ------------------------
  {
    id: 'write-new-file',
    tool: 'write_file',
    alsoOffer: ['edit_file'],
    task: 'Create a new file hello.py containing a main() that prints "hi". The file does not exist yet.',
    expresses: (i) => {
      if (i.path !== 'hello.py') return `path=${JSON.stringify(i.path)}`;
      if (!nonEmpty(i.content)) return 'content missing — nothing would be written';
      return null;
    },
  },

  // --- run_tests: a dedicated tool that models often route through shell ---
  {
    id: 'run-tests-not-shell',
    tool: 'run_tests',
    alsoOffer: ['run_command'],
    task: 'Run the test suite for src/util.test.ts and tell me if it passes.',
    expresses: () => null, // any shape is fine; the signal is WHICH tool was picked
  },
];

/** Pick the advertised subset for a case, from the real registry. */
export function schemasFor(c: ToolSurfaceCase, all: ToolDefinition[]): ToolDefinition[] {
  const want = new Set([c.tool, ...(c.alsoOffer ?? [])]);
  const picked = all.filter((d) => want.has(d.name));
  const missing = [...want].filter((n) => !picked.some((d) => d.name === n));
  if (missing.length) throw new Error(`toolSurface case "${c.id}" names unknown tools: ${missing.join(', ')}`);
  return picked;
}
