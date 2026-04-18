import * as path from 'path';

// ---------------------------------------------------------------------------
// Facet loader (v0.66 chunk 3.1).
//
// A facet is a typed sub-agent specialist declared in a markdown file with
// YAML-ish frontmatter:
//
//   ---
//   id: signal-processing
//   displayName: Signal Processing
//   preferredModel: claude-sonnet-4
//   toolAllowlist: ["read_file", "write_file", "grep", "run_tests"]
//   skillBundle: ["signal-processing", "numerical-methods"]
//   dependsOn: []
//   rpcSchema: {"publishMathBlock": {"params": {"symbol": "string"}}}
//   ---
//   (full system prompt body follows)
//
// We don't ship a real YAML parser — same tradeoff as [`skillLoader.ts`](../skillLoader.ts).
// Scalar values (id / displayName / preferredModel) parse as plain strings;
// values that start with `[` or `{` parse as JSON so arrays and objects are
// structurally safe. Any other shape is rejected at load time with a
// typed `FacetValidationError`.
//
// This module is pure — no filesystem I/O, no workspace API, no workspace-
// index. Callers read the raw text and hand it over for parsing. The
// registry layer (chunk 3.2) handles file discovery and cross-facet
// validation (cycle detection, duplicate id check).
// ---------------------------------------------------------------------------

/** One declaration in a facet's rpcSchema — method name → input param shape. */
export interface RpcMethodSchema {
  /** Free-form parameter descriptor. Shape is model-facing; runtime does
   *  not enforce it structurally (the facet prompt explains the contract
   *  and the receiving facet validates at call time). */
  readonly params?: Record<string, unknown>;
  /** Optional return-shape hint for documentation. */
  readonly returns?: unknown;
}

export interface FacetDefinition {
  /** Filesystem-safe identifier. Must be unique within the registry. */
  readonly id: string;
  /** Human-readable label for the Expert Panel. */
  readonly displayName: string;
  /** Full system prompt the facet runs under — everything after frontmatter. */
  readonly systemPrompt: string;
  /**
   * Tools the facet is allowed to invoke. Empty array = no tools (strictly
   * a thinker). Undefined = inherit the orchestrator's default allowlist
   * (the facet system prompt still constrains behavior, but no explicit
   * filter is applied at dispatch).
   */
  readonly toolAllowlist?: readonly string[];
  /** Preferred model for this facet's runs. Empty string = use the
   *  orchestrator's active model. */
  readonly preferredModel?: string;
  /** Skill IDs (from `SkillLoader`) to merge into the facet's system prompt. */
  readonly skillBundle?: readonly string[];
  /** RPC methods this facet exposes to peers. Each entry produces a
   *  typed `rpc.<facetId>.<method>` tool at dispatch time (chunk 3.4). */
  readonly rpcSchema?: Readonly<Record<string, RpcMethodSchema>>;
  /**
   * Other facet IDs this facet depends on. The registry (chunk 3.2)
   * runs cycle detection: A → B → A is rejected at load time so the
   * Expert Panel can never enqueue a deadlocked dispatch.
   */
  readonly dependsOn?: readonly string[];
  /** Where the facet was loaded from (provenance + source-lookup). */
  readonly source: 'builtin' | 'project' | 'user';
  /** Absolute filesystem path; empty string for built-in facets. */
  readonly filePath: string;
}

export class FacetValidationError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'missing-frontmatter'
      | 'missing-id'
      | 'invalid-id'
      | 'missing-display-name'
      | 'empty-system-prompt'
      | 'invalid-field-shape'
      | 'invalid-json'
      | 'duplicate-id'
      | 'self-dependency'
      | 'cycle',
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'FacetValidationError';
  }
}

/**
 * Parse one facet markdown file into a typed `FacetDefinition`. Throws
 * `FacetValidationError` on every structural problem so callers can
 * report the specific reason back to the user.
 *
 * Does NOT run cross-facet checks (duplicate IDs, dependency cycles) —
 * those live in `FacetRegistry.validateAll` (chunk 3.2) because they
 * require every facet already loaded.
 */
export function parseFacetFile(filePath: string, raw: string, source: FacetDefinition['source']): FacetDefinition {
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!fmMatch) {
    throw new FacetValidationError(
      `Facet at ${filePath} has no frontmatter — add a \`---\` block at the top`,
      'missing-frontmatter',
      { filePath },
    );
  }
  const [, frontmatterRaw, bodyRaw] = fmMatch;
  const body = bodyRaw.trim();
  if (!body) {
    throw new FacetValidationError(
      `Facet at ${filePath} has empty body — the post-frontmatter section is the system prompt`,
      'empty-system-prompt',
      { filePath },
    );
  }

  const fields = parseFrontmatter(frontmatterRaw, filePath);

  const rawId = fields.id;
  if (typeof rawId !== 'string' || rawId.trim().length === 0) {
    throw new FacetValidationError(`Facet at ${filePath} missing required \`id\` field`, 'missing-id', { filePath });
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(rawId)) {
    throw new FacetValidationError(
      `Facet id "${rawId}" at ${filePath} must match /^[a-z0-9][a-z0-9_-]*$/ — lowercase alphanumerics, dashes, underscores`,
      'invalid-id',
      { filePath, id: rawId },
    );
  }

  const displayName = typeof fields.displayName === 'string' ? fields.displayName.trim() : '';
  if (!displayName) {
    throw new FacetValidationError(
      `Facet ${rawId} at ${filePath} missing required \`displayName\` field`,
      'missing-display-name',
      { filePath, id: rawId },
    );
  }

  const toolAllowlist = coerceStringArray(fields.toolAllowlist, 'toolAllowlist', filePath);
  const skillBundle = coerceStringArray(fields.skillBundle, 'skillBundle', filePath);
  const dependsOn = coerceStringArray(fields.dependsOn, 'dependsOn', filePath);
  const rpcSchema = coerceRpcSchema(fields.rpcSchema, filePath);

  const preferredModel = typeof fields.preferredModel === 'string' ? fields.preferredModel.trim() : undefined;

  if (dependsOn?.includes(rawId)) {
    throw new FacetValidationError(`Facet ${rawId} at ${filePath} lists itself in dependsOn`, 'self-dependency', {
      filePath,
      id: rawId,
    });
  }

  return {
    id: rawId,
    displayName,
    systemPrompt: body,
    toolAllowlist,
    preferredModel: preferredModel && preferredModel.length > 0 ? preferredModel : undefined,
    skillBundle,
    rpcSchema,
    dependsOn,
    source,
    filePath,
  };
}

// ---------------------------------------------------------------------------
// Parsers (private)
// ---------------------------------------------------------------------------

/**
 * Key/value parser for the frontmatter block. Mirrors skillLoader's
 * scalar logic but extends it: values whose first non-space char is `[`
 * or `{` parse as JSON so structured fields (`toolAllowlist`, `rpcSchema`)
 * can be declared inline.
 */
function parseFrontmatter(raw: string, filePath: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const kvMatch = trimmed.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kvMatch) continue;
    const [, key, valueRaw] = kvMatch;
    const value = valueRaw.trim();
    if (!value) {
      out[key] = '';
      continue;
    }
    if (value.startsWith('[') || value.startsWith('{')) {
      try {
        out[key] = JSON.parse(value);
      } catch (err) {
        throw new FacetValidationError(
          `Facet ${filePath}: field \`${key}\` has invalid JSON — ${err instanceof Error ? err.message : String(err)}`,
          'invalid-json',
          { filePath, field: key, value },
        );
      }
      continue;
    }
    // Strip quotes on simple scalars.
    out[key] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

function coerceStringArray(value: unknown, fieldName: string, filePath: string): readonly string[] | undefined {
  if (value === undefined || value === '') return undefined;
  if (!Array.isArray(value)) {
    throw new FacetValidationError(
      `Facet ${filePath}: field \`${fieldName}\` must be a JSON array of strings (got ${typeof value})`,
      'invalid-field-shape',
      { filePath, field: fieldName },
    );
  }
  if (value.some((v) => typeof v !== 'string')) {
    throw new FacetValidationError(
      `Facet ${filePath}: every entry in \`${fieldName}\` must be a string`,
      'invalid-field-shape',
      { filePath, field: fieldName },
    );
  }
  return value as string[];
}

function coerceRpcSchema(value: unknown, filePath: string): Readonly<Record<string, RpcMethodSchema>> | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FacetValidationError(
      `Facet ${filePath}: field \`rpcSchema\` must be a JSON object mapping method names to schemas`,
      'invalid-field-shape',
      { filePath, field: 'rpcSchema' },
    );
  }
  const out: Record<string, RpcMethodSchema> = {};
  for (const [methodName, rawSchema] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawSchema !== 'object' || rawSchema === null || Array.isArray(rawSchema)) {
      throw new FacetValidationError(
        `Facet ${filePath}: rpcSchema.${methodName} must be an object`,
        'invalid-field-shape',
        { filePath, field: `rpcSchema.${methodName}` },
      );
    }
    const entry = rawSchema as { params?: unknown; returns?: unknown };
    const methodSchema: RpcMethodSchema = {
      params: entry.params && typeof entry.params === 'object' ? (entry.params as Record<string, unknown>) : undefined,
      returns: entry.returns,
    };
    out[methodName] = methodSchema;
  }
  return out;
}

/**
 * Built-in facet catalog (v0.66 chunk 3.1). Ships with SideCar so users
 * get a useful default registry even without writing any `.sidecar/
 * facets/*.md` files of their own. Each built-in is a plain object here
 * (not loaded from disk) — `source: 'builtin'` makes their provenance
 * clear in the Expert Panel.
 *
 * Keeping these in code (rather than markdown files shipped with the
 * extension) eliminates file-read I/O at activation time, keeps them
 * versioned alongside the parser, and avoids the "built-in went missing
 * after a bad `.vsix` unpack" footgun that bit the skill loader once.
 */
export function builtInFacets(): FacetDefinition[] {
  return [
    {
      id: 'general-coder',
      displayName: 'General Coder',
      systemPrompt:
        "You are a general-purpose coding specialist. Implement the user's task by editing files, " +
        'running tests, and coordinating with peer facets when the task crosses domain boundaries. ' +
        'Prefer small, focused commits and verify each edit with run_tests or get_diagnostics.',
      toolAllowlist: [
        'read_file',
        'write_file',
        'edit_file',
        'search_files',
        'grep',
        'list_directory',
        'get_diagnostics',
        'run_tests',
        'run_command',
        'find_references',
      ],
      skillBundle: [],
      dependsOn: [],
      source: 'builtin',
      filePath: '',
    },
    {
      id: 'latex-writer',
      displayName: 'LaTeX Writer',
      systemPrompt:
        'You are a technical-writing specialist responsible for the LaTeX paper / report side of the workspace. ' +
        'Edit .tex / .bib files, keep math blocks and cite-keys consistent, and publish equations via the RPC ' +
        'surface so sibling facets can lock their code to your equations.',
      toolAllowlist: ['read_file', 'write_file', 'edit_file', 'grep', 'list_directory'],
      skillBundle: ['technical-paper'],
      dependsOn: [],
      source: 'builtin',
      filePath: '',
    },
    {
      id: 'signal-processing',
      displayName: 'Signal Processing',
      systemPrompt:
        'You are a signal-processing / DSP specialist. Implement FFT, filter-design, wavelet, and transform ' +
        'code with explicit attention to numerical stability and edge conditions (DC bin, Nyquist, windowing). ' +
        'Publish every load-bearing equation via rpc.latex_writer.publishMathBlock so the paper stays in lock-step.',
      toolAllowlist: [
        'read_file',
        'write_file',
        'edit_file',
        'grep',
        'get_diagnostics',
        'run_tests',
        'find_references',
      ],
      skillBundle: ['signal-processing', 'numerical-methods'],
      dependsOn: [],
      source: 'builtin',
      filePath: '',
    },
    {
      id: 'frontend',
      displayName: 'Frontend',
      systemPrompt:
        'You are a frontend specialist. Favor component extraction, accessible markup (ARIA + semantic HTML), ' +
        'and matching the existing styling system before inventing new abstractions.',
      toolAllowlist: ['read_file', 'write_file', 'edit_file', 'search_files', 'grep', 'get_diagnostics', 'run_tests'],
      skillBundle: ['react'],
      dependsOn: [],
      source: 'builtin',
      filePath: '',
    },
    {
      id: 'test-author',
      displayName: 'Test Author',
      systemPrompt:
        'You are a test-authoring specialist. Write tests that cover behavior + edge cases + regression ' +
        'invariants, not just happy paths. Prefer the existing test framework + file layout conventions in ' +
        'the target workspace. Surface untested branches via get_diagnostics and coverage probes.',
      toolAllowlist: [
        'read_file',
        'write_file',
        'edit_file',
        'grep',
        'get_diagnostics',
        'run_tests',
        'find_references',
      ],
      skillBundle: [],
      dependsOn: [],
      source: 'builtin',
      filePath: '',
    },
    {
      id: 'technical-writer',
      displayName: 'Technical Writer',
      systemPrompt:
        'You are a documentation specialist. Keep README / JSDoc / changelog entries in sync with the code ' +
        'currently on the branch. Favor concrete examples + file-path references over abstract prose.',
      toolAllowlist: ['read_file', 'write_file', 'edit_file', 'grep', 'list_directory', 'find_references'],
      skillBundle: ['technical-paper'],
      dependsOn: [],
      source: 'builtin',
      filePath: '',
    },
    {
      id: 'security-reviewer',
      displayName: 'Security Reviewer',
      systemPrompt:
        'You are a read-only security reviewer. Audit diffs and nearby code for injection, auth gaps, secret ' +
        'exposure, unsafe deserialization, and supply-chain risk. Report findings with file:line references ' +
        'and remediation suggestions — do NOT edit files yourself.',
      toolAllowlist: ['read_file', 'grep', 'search_files', 'find_references', 'list_directory', 'git_diff'],
      skillBundle: ['cybersecurity-architecture'],
      dependsOn: [],
      source: 'builtin',
      filePath: '',
    },
    {
      id: 'data-engineer',
      displayName: 'Data Engineer',
      systemPrompt:
        'You are a data-engineering specialist. Design ETL / streaming pipelines, schema migrations, and ' +
        'query optimizations that respect existing data contracts. Validate every schema change against ' +
        'downstream consumers before proposing it.',
      toolAllowlist: ['read_file', 'write_file', 'edit_file', 'grep', 'run_tests', 'run_command'],
      skillBundle: [],
      dependsOn: [],
      source: 'builtin',
      filePath: '',
    },
  ];
}

/** Short helper for callers that want a per-id map. */
export function indexFacets(facets: readonly FacetDefinition[]): Map<string, FacetDefinition> {
  const map = new Map<string, FacetDefinition>();
  for (const f of facets) map.set(f.id, f);
  return map;
}

/** Extract the file-basename slug from a facet-definition path, for UI. */
export function facetSlugFromPath(filePath: string): string {
  return path.basename(filePath, '.md');
}
