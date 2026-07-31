import { describe, it, expect } from 'vitest';
import { GUARD_PROBE_CASES } from './guardProbeCases.js';
import { runAgentCase, pickAgentBackend } from './agentHarness.js';
import { scanTrajectory, renderGuardReport, type GuardCandidate } from './guardCandidateScan.js';
import { writeHeader } from './evalReporter.js';

// ---------------------------------------------------------------------------
// Guard-candidate probe runner.
//
// Companion to agent.eval.ts with an inverted purpose: agent.eval.ts
// gates regressions, this file gathers evidence. It runs the
// provocation cases and tallies guard-candidate signatures from the
// trajectories; a case never fails on candidates (the whole point is
// to count them), only on infra errors. The verdict is the printed
// tally — repeated firings justify building the corresponding
// executor guard, a silent sweep justifies not building it.
//
// Run:  npm run eval:guardprobe
//
// Comprehensive sweep — two axes, models × config arms. Guard-relevant
// behavior shifts with the scaffolds active (a critic reprompt or plan
// re-injection changes what the model emits next), so sweep the arms
// that alter the tool-calling surface, not just the models:
//
//   for m in qwen2.5-coder:7b llama3.2 gemma4:e4b ministral-3 qwen3.5; do
//     for cfg in '{}' '{"criticEnabled":true}' '{"completionGateEnabled":true}' \
//                '{"planExternalizedEnabled":true}'; do
//       SIDECAR_EVAL_MODEL=$m SIDECAR_EVAL_CONFIG_OVERRIDES=$cfg npm run eval:guardprobe
//     done
//   done
//
// SIDECAR_EVAL_CONFIG_OVERRIDES is merged over every case's config by the
// harness (works for all eval files, not just this one). The npm script
// sets SIDECAR_EVAL_TRAJECTORY_DIR so every run appends full trajectories —
// stamped with model AND config arm — to
// .sidecar/logs/eval-trajectories/trajectories.jsonl for offline jq analysis.
// ---------------------------------------------------------------------------

// Deterministic predicate self-checks — no model, no backend. These run on
// every probe invocation so a broken detector can't quietly report a clean
// sweep. The false-positive cases matter most: a detector that fires on
// legitimate calls would tally fake evidence for building a guard.
describe('guard-candidate scanner self-check', () => {
  const call = (name: string, input: Record<string, unknown>) =>
    ({ type: 'tool_call', name, input, id: 't1' }) as const;

  it('detects each signature', () => {
    const kinds = scanTrajectory('self', [
      call('read_file', { path: 'path/to/file.ts' }),
      call('grep', { pattern: '<query>' }),
      call('write_file', { arguments: { path: 'a.md', content: 'x' } }),
      call('createFile', { path: 'a.md', content: 'x' }),
      { type: 'tool_result', name: 'summon_daemon', result: 'Unknown tool: summon_daemon', isError: true, id: 't2' },
    ]).map((c) => c.kind);
    expect(kinds).toContain('placeholder-arg');
    expect(kinds).toContain('wrapper-key');
    expect(kinds).toContain('foreign-name-format');
    expect(kinds).toContain('unknown-tool');
  });

  it('detects a verbatim replay of a real catalog example', () => {
    const found = scanTrajectory('self', [
      call('ask_user', {
        question: 'Which auth flow should the callback use?',
        options: ['OAuth code exchange', 'Implicit (deprecated)', 'Password grant'],
        allow_custom: true,
      }),
    ]);
    expect(found.map((c) => c.kind)).toContain('example-replay');
  });

  it('stays silent on legitimate calls', () => {
    expect(
      scanTrajectory('self', [
        call('read_file', { path: 'src/agent/loop.ts' }),
        call('edit_file', { path: 'index.html', search: '<div>', replace: '<section>' }),
        call('write_file', { path: 'docs/paths.md', content: 'Use path/to notation in examples.' }),
        call('ask_user', { question: 'Migrate the config schema too?' }),
        call('grep', { pattern: 'TODO', path: 'src' }),
      ]),
    ).toEqual([]);
  });
});

const backend = pickAgentBackend();

// Same single-case fast path as agent.eval.ts:
//   SIDECAR_EVAL_CASE=probe-no-signal-hi npm run eval:guardprobe
const CASE_FILTER = process.env.SIDECAR_EVAL_CASE?.split(',').map((s) => s.trim());

describe.skipIf(!backend)('llm-eval :: guard-candidate probe', () => {
  const candidates: GuardCandidate[] = [];
  let casesRun = 0;
  writeHeader('llm-eval :: guard-candidate probe');

  for (const evalCase of GUARD_PROBE_CASES) {
    if (CASE_FILTER && !CASE_FILTER.some((f) => evalCase.id.includes(f))) continue;
    it(`${evalCase.id} — ${evalCase.description}`, async () => {
      const result = await runAgentCase(evalCase, backend!);
      casesRun++;
      const found = scanTrajectory(evalCase.id, result.trajectory);
      candidates.push(...found);
      if (found.length > 0) {
        // Surface hits inline so a watcher sees them without waiting for the summary.
        console.log(`[guard-probe] ${evalCase.id}: ${found.map((c) => `${c.kind}(${c.tool})`).join(', ')}`);
      }
    });
  }

  it('summary', () => {
    const arm = process.env.SIDECAR_EVAL_CONFIG_OVERRIDES;
    const label = backend!.defaultModel() + (arm ? ` [config: ${arm}]` : ' [config: defaults]');
    console.log('\n\n' + renderGuardReport(candidates, casesRun, label));
  });
});

if (!backend) {
  console.warn(
    '\n[eval:guardprobe] No backend available — set SIDECAR_EVAL_BACKEND and its API key, ' +
      'or start a local Ollama daemon, then re-run.\n',
  );
}
