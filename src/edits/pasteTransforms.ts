/**
 * Built-in paste transform table for Adaptive Paste (v0.72 Chunk 4).
 *
 * Each entry describes a "foreign" content type that can be pasted into a
 * file and a suggested transformation to make it fit. Detection is pure
 * regex/heuristic — no LLM needed until the user confirms.
 *
 * Pure module: no VS Code imports so it stays unit-testable in isolation.
 */

export interface PasteTransform {
  /** Stable identifier used in commands and telemetry */
  id: string;
  /** Short human-readable label shown in the QuickPick */
  name: string;
  /** One-line explanation shown as QuickPick description */
  description: string;
  /**
   * Returns true when `text` looks like this transform's source format.
   * Runs synchronously — no I/O, no LLM.
   */
  detect(text: string): boolean;
  /**
   * When set, only offer the transform when the target file's languageId
   * is in this list. Undefined means "offer in any language".
   */
  targetLanguages?: string[];
  /**
   * System-level instruction appended to the standard adaptive-paste prompt.
   * The engine will prepend: "Transform the following pasted content so it
   * fits naturally into a <lang> file. Output only the transformed code."
   */
  transformInstruction: string;
}

// ---------------------------------------------------------------------------
// Detection helpers (pure functions)
// ---------------------------------------------------------------------------

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

const SQL_KEYWORDS =
  /^\s*(select|insert\s+into|update|delete\s+from|create\s+table|alter\s+table|drop\s+table|with\s+\w)/i;
const SQL_BODY = /\b(from|where|join|group\s+by|order\s+by|having|limit|values|set\b)\b/i;

function looksLikeSql(text: string): boolean {
  return SQL_KEYWORDS.test(text) && SQL_BODY.test(text);
}

const CURL_RE = /^\s*curl\s+/i;

function looksLikeCurl(text: string): boolean {
  return CURL_RE.test(text);
}

const CSS_RULE = /[\w-]+\s*:\s*[^;{]+;/;
const CSS_BLOCK = /[.#\w][\w\s,:.#-]*\s*\{[\s\S]*?\}/;

function looksLikeCss(text: string): boolean {
  const t = text.trim();
  return (CSS_RULE.test(t) && CSS_BLOCK.test(t)) || (t.includes('{') && CSS_RULE.test(t));
}

const PYTHON_RE = /^\s*(def |class |import |from \w+ import|print\(|@\w+)/m;

function looksLikePython(text: string): boolean {
  return PYTHON_RE.test(text) && !text.includes('=>') && !text.includes('function ');
}

const SHELL_SHEBANG = /^#!/;
const SHELL_COMMANDS = /^\s*\$\s+\S|^\s*(apt|brew|npm|pip|yarn|cargo|make)\s/m;

function looksLikeShell(text: string): boolean {
  return SHELL_SHEBANG.test(text.trimStart()) || SHELL_COMMANDS.test(text);
}

function looksLikeEnvFile(text: string): boolean {
  const lines = text.trim().split('\n');
  const envLines = lines.filter((l) => /^[\w_]+=/.test(l.trim()) && !l.trim().startsWith('#'));
  return envLines.length >= 2 && envLines.length / lines.length > 0.5;
}

// ---------------------------------------------------------------------------
// Built-in transform catalog
// ---------------------------------------------------------------------------

export const BUILTIN_TRANSFORMS: PasteTransform[] = [
  {
    id: 'json-to-ts-type',
    name: 'JSON → TypeScript type',
    description: 'Convert a JSON object/array literal into a TypeScript interface or type alias',
    detect: looksLikeJson,
    targetLanguages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    transformInstruction:
      'Convert the JSON value into an idiomatic TypeScript interface (for objects) or type alias (for primitives/arrays). ' +
      'Use readonly arrays where appropriate. Nest interfaces inline. Export the root type.',
  },
  {
    id: 'sql-to-orm',
    name: 'SQL → ORM query',
    description: 'Rewrite a raw SQL query as an ORM call (Prisma / TypeORM / Knex — infer from imports)',
    detect: looksLikeSql,
    targetLanguages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    transformInstruction:
      'Rewrite the SQL query as a fluent ORM call that matches the ORM already used in the file ' +
      '(prefer Prisma, then TypeORM, then Knex, then raw sql tag). ' +
      'Keep the same semantics; add type annotations where obvious.',
  },
  {
    id: 'curl-to-fetch',
    name: 'curl → fetch()',
    description: 'Convert a curl command into a fetch() call with headers and body',
    detect: looksLikeCurl,
    targetLanguages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    transformInstruction:
      'Convert the curl command to an async fetch() call. Preserve all headers, query params, and the request body. ' +
      'Return the JSON response with `await response.json()`. Use TypeScript syntax.',
  },
  {
    id: 'css-to-tailwind',
    name: 'CSS → Tailwind classes',
    description: 'Convert CSS rules into Tailwind utility class strings',
    detect: looksLikeCss,
    targetLanguages: ['typescriptreact', 'javascriptreact', 'html'],
    transformInstruction:
      'Convert the CSS rules into the equivalent Tailwind CSS utility class string (e.g. "flex items-center gap-4"). ' +
      'Output only the class string, no JSX wrapper.',
  },
  {
    id: 'python-to-ts',
    name: 'Python → TypeScript',
    description: 'Translate a Python snippet into idiomatic TypeScript',
    detect: looksLikePython,
    targetLanguages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    transformInstruction:
      'Translate the Python snippet into idiomatic TypeScript. ' +
      'Use `const`/`let`, arrow functions, and TypeScript types. Preserve all logic.',
  },
  {
    id: 'shell-to-execa',
    name: 'Shell → child_process / execa',
    description: 'Wrap shell commands in a Node.js child_process.exec or execa call',
    detect: looksLikeShell,
    targetLanguages: ['typescript', 'javascript'],
    transformInstruction:
      'Wrap each shell command in an `execa` call (preferred) or `child_process.exec` promise. ' +
      'Capture stdout and handle errors. Add necessary imports.',
  },
  {
    id: 'env-to-zod',
    name: '.env → Zod schema',
    description: 'Convert .env variable assignments into a typed Zod schema for environment validation',
    detect: looksLikeEnvFile,
    targetLanguages: ['typescript', 'javascript'],
    transformInstruction:
      'Convert the .env key=value pairs into a Zod schema: `const Env = z.object({ ... })`. ' +
      'Use z.string() for most values, z.coerce.number() for numeric-looking ones, z.enum() when there are limited options. ' +
      'Add `export type Env = z.infer<typeof Env>;`.',
  },
];

/**
 * Returns the subset of transforms whose `detect` function matches `text`
 * and whose `targetLanguages` (if set) include `languageId`.
 */
export function detectTransforms(text: string, languageId: string): PasteTransform[] {
  return BUILTIN_TRANSFORMS.filter(
    (t) => t.detect(text) && (!t.targetLanguages || t.targetLanguages.includes(languageId)),
  );
}
