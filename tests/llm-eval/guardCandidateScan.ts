import type { TrajectoryEvent } from './agentTypes.js';
import { isExampleReplay } from '../../src/agent/executor/exampleReplayGuard.js';
import { TOOL_REGISTRY } from '../../src/agent/tools.js';

// ---------------------------------------------------------------------------
// Guard-candidate scanner.
//
// Walks a recorded trajectory for the tool-call pathologies we are
// CONSIDERING guarding in the executor but have not yet observed in the
// wild (audit.jsonl mining across 1,403 dogfood calls found zero of
// them). Detection here is telemetry, not enforcement: a candidate
// firing in an eval sweep is the evidence bar a new guard must meet
// before it gets built (the paramRemap precedent — "llama3.2 sent
// `file` on 6/6 write_file calls"), and a sweep with zero firings is
// the evidence to NOT build it.
//
// Each detector mirrors the exact predicate its would-be guard would
// use, so a firing count here translates directly into a
// true-positive count for the guard.
// ---------------------------------------------------------------------------

export type GuardCandidateKind =
  | 'placeholder-arg' // schema-valid template value: "...", "path/to/x", "<query>"
  | 'wrapper-key' // real args nested under {"arguments": {...}} / {"input": {...}}
  | 'foreign-name-format' // camelCase / PascalCase / hyphenated tool name
  | 'unknown-tool' // call bounced with "Unknown tool" (alias + salvage both missed)
  | 'example-replay'; // input verbatim-matches the tool description's example

export interface GuardCandidate {
  kind: GuardCandidateKind;
  caseId: string;
  tool: string;
  /** Human-readable evidence: the offending key/value or name. */
  detail: string;
}

const WRAPPER_KEYS = new Set(['arguments', 'input', 'params', 'parameters', 'properties', 'args']);

// Angle-bracket values that read as placeholders only when the token names
// the parameter itself or a generic slot word — `edit_file(search="<div>")`
// is a legitimate HTML search and must not fire.
const GENERIC_PLACEHOLDER_WORDS = new Set([
  'path',
  'file',
  'file path',
  'filepath',
  'filename',
  'file name',
  'query',
  'your query',
  'search query',
  'content',
  'your content',
  'command',
  'url',
  'value',
  'text',
  'string',
  'name',
  'question',
  'pattern',
  'code',
  'directory',
  'dir',
]);

/** True when a top-level string argument is a template value, not real data. */
export function isPlaceholderValue(key: string, value: string): boolean {
  const v = value.trim();
  if (v === '...' || v === '…') return true;
  // Path-shaped value (no spaces) containing the canonical tutorial path.
  if (!v.includes(' ') && /(^|\/)path\/to\//.test(v)) return true;
  const angle = /^<([\w][\w /-]{0,40})>$/.exec(v);
  if (angle) {
    const inner = angle[1].toLowerCase().replace(/[_-]/g, ' ').trim();
    const keyNorm = key.toLowerCase().replace(/[_-]/g, ' ').trim();
    return inner === keyNorm || GENERIC_PLACEHOLDER_WORDS.has(inner);
  }
  return false;
}

/** True when the input is one wrapper key with the real args nested inside. */
export function isWrapperShaped(input: Record<string, unknown>): boolean {
  const keys = Object.keys(input);
  if (keys.length !== 1 || !WRAPPER_KEYS.has(keys[0])) return false;
  const inner = input[keys[0]];
  return inner !== null && typeof inner === 'object' && !Array.isArray(inner);
}

/** True when a tool name uses a foreign format (camelCase, PascalCase, kebab-case). */
export function isForeignNameFormat(name: string): boolean {
  return /[A-Z]/.test(name) || name.includes('-');
}

const DESCRIPTION_BY_TOOL = new Map(TOOL_REGISTRY.map((t) => [t.definition.name, t.definition.description]));

/** Scan one case's trajectory for every guard-candidate signature. */
export function scanTrajectory(caseId: string, trajectory: TrajectoryEvent[]): GuardCandidate[] {
  const candidates: GuardCandidate[] = [];

  for (const event of trajectory) {
    if (event.type === 'tool_result') {
      if (/Unknown tool/.test(event.result)) {
        candidates.push({ kind: 'unknown-tool', caseId, tool: event.name, detail: `bounced: ${event.name}` });
      }
      continue;
    }
    if (event.type !== 'tool_call') continue;

    if (isForeignNameFormat(event.name)) {
      candidates.push({ kind: 'foreign-name-format', caseId, tool: event.name, detail: event.name });
    }

    if (isWrapperShaped(event.input)) {
      candidates.push({
        kind: 'wrapper-key',
        caseId,
        tool: event.name,
        detail: `{"${Object.keys(event.input)[0]}": {...}}`,
      });
    }

    for (const [key, value] of Object.entries(event.input)) {
      if (typeof value === 'string' && isPlaceholderValue(key, value)) {
        candidates.push({
          kind: 'placeholder-arg',
          caseId,
          tool: event.name,
          detail: `${key}=${JSON.stringify(value)}`,
        });
      }
    }

    if (isExampleReplay(event.name, event.input, DESCRIPTION_BY_TOOL.get(event.name))) {
      candidates.push({
        kind: 'example-replay',
        caseId,
        tool: event.name,
        detail: JSON.stringify(event.input).slice(0, 120),
      });
    }
  }

  return candidates;
}

/** Markdown tally for the probe run's report. */
export function renderGuardReport(candidates: GuardCandidate[], casesRun: number, model: string): string {
  const lines = [`## Guard-candidate probe — ${model} (${casesRun} cases)`, ''];
  if (candidates.length === 0) {
    lines.push('No guard-candidate signatures observed. On this evidence the corresponding');
    lines.push('guards remain unjustified — re-run across the standard model sweep before deciding.');
    return lines.join('\n');
  }
  const byKind = new Map<GuardCandidateKind, GuardCandidate[]>();
  for (const c of candidates) {
    byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c]);
  }
  lines.push('| kind | count | samples |');
  lines.push('|------|-------|---------|');
  for (const [kind, hits] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const samples = hits
      .slice(0, 3)
      .map((h) => `${h.caseId}: ${h.tool} ${h.detail}`)
      .join('; ');
    lines.push(`| ${kind} | ${hits.length} | ${samples} |`);
  }
  lines.push('');
  lines.push('A kind with repeated firings and no false positives has met the bar for a real guard.');
  return lines.join('\n');
}
