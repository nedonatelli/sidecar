import type { AgentEvalCase } from './agentTypes.js';

// ---------------------------------------------------------------------------
// Large-file edit cases — the regime the rest of the suite cannot see.
//
// WHY THIS FAMILY EXISTS
//
// `agentCases.ts` carries a standing rule: "Keep the workspace fixture under
// ~20 lines of content." That rule is right for pinning tool choice and
// argument shape, and it is why 35 commits to `src/agent/tools/fs.ts` in eight
// weeks all shipped green. It is also why none of them moved the number that
// matters.
//
// Measured on the SWE-bench canary slice (187 trajectories, gemma4:e4b):
//
//   edit_file error rate, llm-eval suite (<=20-line fixtures) ...... 14%
//   edit_file error rate, SWE-bench (399-2091 line files) .......... 60%
//   trajectories that never landed a single successful edit ........ 62%
//
// Same model, same tool, same week. The gap is file size and context
// occupancy, and the error rate climbs monotonically with the latter:
// 38% at 8-16k tokens, 55% at 16-24k, 65% at 24-32k, 69% past 32k.
//
// The failure modes, by share of the 152 observed edit errors:
//
//   1. search === replace ................................... 46%
//      The model puts the same string in both fields. `editFile` compares
//      raw (fs.ts, `if (search === replace)`) — there is no normalization
//      bug; the model genuinely sends identical text. It happens when the
//      model must DERIVE the replacement rather than copy it from the
//      prompt, and worst on insertions, where the tool description
//      instructs it to repeat the anchor inside `replace`.
//
//   2. search string not found .............................. ~20%
//      The model reconstructs the anchor from memory instead of copying it,
//      and the whitespace does not survive. Python indentation is syntax,
//      so this is where it bites hardest.
//
//   3. search appears N times ............................... ~10%
//      A short anchor that was unique in a 20-line fixture repeats twenty
//      times in a real module.
//
// WHAT MAKES A CASE BELONG HERE
//
// The existing `dogfood-large-file-edit` is a ~600-line file and does NOT
// belong to this family — it is a guard-latency case. Every one of its
// anchors is globally unique, and its prompt hands the model the exact
// search and replace strings ("returns value * 47 instead of value + 47").
// None of the three failure modes above can occur in it.
//
// A case here must:
//   - use a file of at least ~400 lines with real nesting depth,
//   - state the change as INTENT, never as literal search/replace text,
//   - place the target deep in the file, behind a repeated anchor,
//   - assert the neighbours survived, so a whole-file rewrite fails.
//
// `largeFileEditCases.test.ts` pins these properties deterministically, so a
// well-meaning simplification cannot quietly turn one back into a 20-line case.
// ---------------------------------------------------------------------------

const CLASS_COUNT = 20;

/**
 * A validator module shaped like the Django code the agent actually fails on:
 * repeated class bodies, four indentation levels, and a bounds check whose
 * text is byte-identical in all twenty classes.
 *
 * The ONLY disambiguator for the target line is the per-class docstring three
 * lines above it. That is deliberate: an anchor that is unique on its own line
 * makes the case trivial, and one with no disambiguator at all makes it
 * unwinnable. Requiring surrounding context is exactly what `edit_file`'s
 * description asks for and what small models stop doing once a file is large.
 *
 * @param boundsOperatorByClass Overrides the `>` in a class's bounds check.
 *   Used to build the expected post-edit file without duplicating the fixture.
 */
function buildValidatorModule(boundsOperatorByClass: Record<number, string> = {}): string {
  const header =
    '"""Field validation pipeline for the record importer."""\n' +
    '\n' +
    'from .errors import ValidationError\n' +
    '\n' +
    '\n' +
    'class Rule:\n' +
    '    """A single named constraint applied to a field value."""\n' +
    '\n' +
    '    def __init__(self, name, bound):\n' +
    '        self.name = name\n' +
    '        self.bound = bound\n' +
    '\n' +
    '    def matches(self, value):\n' +
    '        return value <= self.bound\n';

  const classes = Array.from({ length: CLASS_COUNT }, (_, i) => {
    const op = boundsOperatorByClass[i] ?? '>';
    return (
      `\n\nclass FieldValidator${i}:\n` +
      `    """Validates the \`field${i}\` column."""\n` +
      '\n' +
      `    maximum = ${100 + i}\n` +
      '\n' +
      '    def __init__(self, rules=None):\n' +
      '        self.rules = rules or []\n' +
      '\n' +
      '    def coerce(self, value, strict=False):\n' +
      '        if value is None:\n' +
      '            return None\n' +
      '        for rule in self.rules:\n' +
      '            if not rule.matches(value):\n' +
      '                if strict:\n' +
      '                    raise ValidationError(rule.name)\n' +
      '                return None\n' +
      '        return value\n' +
      '\n' +
      '    def is_within_bounds(self, value):\n' +
      `        """Bounds check for field${i}."""\n` +
      '        if value is None:\n' +
      '            return False\n' +
      `        if value ${op} self.maximum:\n` +
      '            return False\n' +
      '        return True\n'
    );
  }).join('');

  return `${header}${classes}`;
}

/** The pristine fixture, shared by every case in this family. */
export const VALIDATOR_MODULE = buildValidatorModule();

/** Target for the boundary case: deep in the file, far from both ends. */
const BOUNDARY_TARGET = 13;

/** The same module with ONLY FieldValidator13's bounds operator widened. */
const VALIDATOR_MODULE_BOUNDARY_FIXED = buildValidatorModule({ [BOUNDARY_TARGET]: '>=' });

/**
 * Sibling modules, so "which file?" is a real question rather than a formality.
 * Only `validators.py` carries a bounds check; the decoys are plausible places
 * to look, not noise.
 */
const DECOY_FILES: Record<string, string> = {
  'src/errors.py': 'class ValidationError(Exception):\n    """Raised when a field fails validation."""\n',
  'src/importer.py':
    'from .validators import FieldValidator13\n\n\n' +
    'def import_row(row):\n    """Import one record, validating each field."""\n' +
    '    return {k: v for k, v in row.items() if v is not None}\n',
  'src/limits.py': '"""Static limits referenced by the importer."""\n\nMAX_ROWS = 10_000\nMAX_FIELD_BYTES = 4096\n',
  'README.md': '# Record importer\n\nValidates and imports rows.\n',
};

export const UNDERSPECIFIED_CASES: AgentEvalCase[] = [
  {
    id: 'large-file-no-path',
    description: 'Same edit, but the file is not named — the model must locate it first',
    tags: ['edit', 'scale', 'python', 'retrieval', 'regression'],
    workspace: { 'src/validators.py': VALIDATOR_MODULE, ...DECOY_FILES },
    // Measured 2026-08-19: removing the path took gemma4:e4b from 3/3 to 0/3,
    // with and without reasoning, while removing the CLASS name cost nothing
    // (3/3, and the fastest run of the ladder). Location is load-bearing in a
    // way the other specificity is not — this case is what a retrieval layer,
    // or a system prompt that teaches search, has to earn its place against.
    userMessage:
      'The validator for field13 is too permissive: a value exactly equal to its maximum should be ' +
      'out of bounds. Fix only that validator; the others must keep their behavior.',
    maxIterations: 16,
    expect: {
      files: {
        equal: [{ path: 'src/validators.py', content: VALIDATOR_MODULE_BOUNDARY_FIXED }],
        notModified: ['src/errors.py', 'src/importer.py', 'src/limits.py'],
      },
    },
  },

  {
    id: 'large-file-vague-semantics',
    description: 'The target is named but the required behavior is not — can it infer the fix?',
    tags: ['edit', 'scale', 'python', 'specification', 'regression'],
    workspace: { 'src/validators.py': VALIDATOR_MODULE },
    // The one failure reasoning does NOT rescue: 0/3 even with 44,827 chars of
    // thinking, while the same prompt WITH the semantics spelled out is 3/3.
    // "by one" is the whole difficulty — it must infer that > should become >=.
    userMessage:
      "In src/validators.py, FieldValidator13's bounds check is too permissive by one. " +
      'Fix FieldValidator13 only. Every other validator must keep its current behavior.',
    maxIterations: 16,
    expect: {
      files: { equal: [{ path: 'src/validators.py', content: VALIDATOR_MODULE_BOUNDARY_FIXED }] },
    },
  },

  {
    id: 'large-file-already-correct',
    description: 'The code already does what is asked — the correct action is to change nothing',
    tags: ['edit', 'scale', 'python', 'restraint', 'regression'],
    // The fixture is ALREADY fixed, and the request describes the behavior it
    // already has. Every other case rewards acting; this is the only one that
    // rewards stopping — and both of the worst failures seen on 2026-08-19 were
    // models that could not stop: one re-edited a file it had already fixed
    // until it hit the iteration cap, another reported an edit it never made.
    workspace: { 'src/validators.py': VALIDATOR_MODULE_BOUNDARY_FIXED },
    userMessage:
      'In src/validators.py, FieldValidator13 should treat a value exactly equal to its maximum as ' +
      'out of bounds. Make sure that is the case. Change nothing else.',
    maxIterations: 12,
    expect: {
      // Byte-identical: any edit at all is a failure, including a "harmless" one.
      files: { equal: [{ path: 'src/validators.py', content: VALIDATOR_MODULE_BOUNDARY_FIXED }] },
    },
  },
];

export const LARGE_FILE_EDIT_CASES: AgentEvalCase[] = [
  {
    id: 'large-file-derived-boundary-edit',
    description: 'Change one operator deep in a 500-line Python module, behind an anchor repeated 20 times',
    tags: ['edit', 'scale', 'python', 'regression'],
    workspace: { 'src/validators.py': VALIDATOR_MODULE },
    // Stated as behavior, never as text. The model has to derive BOTH fields:
    // find the line, copy it byte-exactly into `search`, and write a different
    // string into `replace`. A prompt that names the replacement (as
    // `dogfood-large-file-edit` does) removes the search===replace failure mode
    // entirely, which is why that case has never caught this.
    userMessage:
      'In src/validators.py, FieldValidator13 is too permissive: a value exactly equal to its ' +
      'maximum should be treated as out of bounds, but is_within_bounds currently accepts it. ' +
      'Fix FieldValidator13 only. Every other validator must keep its current behavior.',
    maxIterations: 14,
    expect: {
      files: {
        // Exact equality is the whole point. Nineteen sibling classes carry a
        // byte-identical bounds check, so `replace_all`, a mis-anchored edit, or
        // a whole-file rewrite all land here as a diff — none of which a
        // substring assertion would catch.
        equal: [{ path: 'src/validators.py', content: VALIDATOR_MODULE_BOUNDARY_FIXED }],
      },
      // Rewriting 500 lines to change one character is the pathology the
      // circular-rewrite guard already warns about live ("rewriting an edited
      // file (use edit_file)"). This family exists to measure edit_file, so a
      // run that routes around it has not demonstrated the thing under test.
      toolsNotCalled: ['write_file'],
      toolsCalled: ['edit_file'],
      trajectoryOrder: [{ before: 'read_file', after: 'edit_file' }],
    },
  },

  {
    id: 'large-file-anchored-insertion',
    description: 'Insert a guard clause mid-method in a 500-line module — the anchor must survive',
    // Targets FieldValidator7, not the boundary case's FieldValidator13, so the
    // two cases cannot share an answer if one is run straight after the other.
    tags: ['edit', 'scale', 'python', 'insertion', 'regression'],
    workspace: { 'src/validators.py': VALIDATOR_MODULE },
    // Insertions are where search===replace peaks: `edit_file` has one
    // operation, so adding a line means putting an anchor in `search` and
    // REPEATING it inside `replace` alongside the new code. A model that
    // repeats the anchor and forgets to add the new line has sent identical
    // fields; one that drops the anchor deletes it. Both are observed live.
    userMessage:
      'In src/validators.py, FieldValidator7.is_within_bounds must also reject negative values — ' +
      'a value below zero is out of bounds. Add that check immediately after the existing None ' +
      'check, and change nothing else in the file.',
    maxIterations: 14,
    expect: {
      files: {
        matchesRegex: [
          {
            path: 'src/validators.py',
            patterns: [
              // The new guard sits between the None check and the bounds check,
              // at the right depth, with the anchor lines intact on both sides.
              // Bounded so the match cannot wander into a neighbouring class.
              new RegExp(
                String.raw`class FieldValidator7:[\s\S]{0,600}?` +
                  String.raw`def is_within_bounds\(self, value\):\n` +
                  String.raw`\s{8}"""Bounds check for field7\."""\n` +
                  String.raw`\s{8}if value is None:\n` +
                  String.raw`\s{12}return False\n` +
                  String.raw`\s{8}if value < 0:\n` +
                  String.raw`\s{12}return False\n` +
                  String.raw`\s{8}if value > self\.maximum:\n` +
                  String.raw`\s{12}return False\n` +
                  String.raw`\s{8}return True`,
              ),
            ],
          },
        ],
        notContain: [
          {
            path: 'src/validators.py',
            // Anchor-dropped-from-replace deletes the line it was anchored to;
            // these are the two shapes that leaves behind.
            substrings: [
              'def is_within_bounds(self, value):\n        if value < 0:',
              '"""Bounds check for field7."""\n        if value < 0:',
            ],
          },
        ],
      },
      toolsNotCalled: ['write_file'],
      toolsCalled: ['edit_file'],
    },
  },

  {
    id: 'large-file-edit-under-compression',
    description: 'Same surgical edit, but with a token budget low enough to compress the read away',
    tags: ['edit', 'scale', 'python', 'compression', 'regression'],
    workspace: { 'src/validators.py': VALIDATOR_MODULE },
    // The measured error rate nearly doubles from 38% (8-16k) to 69% (32k+).
    // The mechanism worth pinning: `edit_file` demands a byte-exact copy of
    // text the model read N turns ago, and compression is free to evict the
    // read_file output holding it. Every other case in the suite runs with
    // enough headroom that this never happens. Same target as the boundary
    // case, so a pass/fail split between the two isolates context pressure as
    // the variable.
    maxTokens: 9000,
    userMessage:
      'In src/validators.py, FieldValidator13 is too permissive: a value exactly equal to its ' +
      'maximum should be treated as out of bounds, but is_within_bounds currently accepts it. ' +
      'Fix FieldValidator13 only. Every other validator must keep its current behavior.',
    maxIterations: 18,
    expect: {
      files: {
        equal: [{ path: 'src/validators.py', content: VALIDATOR_MODULE_BOUNDARY_FIXED }],
      },
      toolsCalled: ['edit_file'],
    },
  },
];
