// Agent-eval regression baseline.
//
// The per-case scorers (agentScorers.ts) check each case against its authored
// expectations, but nothing tracked, per MODEL, WHICH cases a given model is
// known to pass — so a model silently regressing (e.g. 8/9 → 6/9, or a bug that
// drops a whole category) was only ever caught by eyeballing a run. This gates
// that: it records a committed baseline of per-case pass/fail + cost metrics per
// model, then FAILS if a case that used to pass now fails.
//
// Two modes (mirrors embeddingParity.eval.ts):
//   - Record (`SIDECAR_RECORD_AGENT_BASELINE=1`): overwrite the baseline for the
//     active model with the current run.
//   - Verify (default): run the baselined cases; fail on any confirmed
//     regression. Missing baseline → skip with a record hint.
//
// Stochasticity: agent runs are non-deterministic, so a regression candidate
// (baseline-pass → now-fail) is RE-RUN once and only counts if it fails again —
// a single flaky flip is reported, not failed. `apiUnavailable` cases (hung
// connection / rate-limit, not a behavioural change) are excluded either way.
//
// Model is selected via SIDECAR_EVAL_BACKEND / SIDECAR_EVAL_MODEL (same as the
// other evals); SIDECAR_EVAL_TAGS / SIDECAR_EVAL_CASE scope which cases record.

import { describe, it } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import {
  runAgentCase,
  pickAgentBackend,
  DEFAULT_CASE_TIMEOUT_MS,
  runConfigForProvenance,
  isWrappedInfraFailure,
} from './agentHarness.js';
import type { AgentEvalCase } from './agentTypes.js';
import { compareProvenance, currentProvenance, type BaselineProvenance } from './baselineProvenance.js';
import { ALL_AGENT_CASES } from './allCases.js';
import { appendHistory } from './baselineHistory.js';

// The eval and the baseline MUST run the same cases; they drifted to 70 vs 61.
const ALL_CASES: AgentEvalCase[] = ALL_AGENT_CASES;

const BASELINE_DIR = path.resolve(__dirname, 'baselines');
const RECORD_MODE = process.env.SIDECAR_RECORD_AGENT_BASELINE === '1';
const TAG_FILTER = process.env.SIDECAR_EVAL_TAGS?.split(',').map((s) => s.trim());
const CASE_FILTER = process.env.SIDECAR_EVAL_CASE?.split(',').map((s) => s.trim());
// Trials per case. Default 1 keeps the historical behaviour and cost; above 1
// the recorded `passed` becomes a MAJORITY of trials rather than a single
// sample, and the rate is stored beside it. agent.eval.ts has had this for a
// while — it reports `[flaky] case: 13/25` — but the recorder never used it, so
// every baseline in the repo is one sample per case with no reliability.
const TRIALS = Math.max(1, parseInt(process.env.SIDECAR_EVAL_TRIALS ?? '1', 10) || 1);

interface CaseBaseline {
  passed: boolean;
  iterationsUsed: number;
  durationMs: number;
  /** Trials run for this case, and how many passed. Present only when recorded
   *  with SIDECAR_EVAL_TRIALS > 1.
   *
   *  A single sample cannot separate a capable model from a lucky one. Measured
   *  on the eleven cases that flipped between two sweeps: FIVE flip on seed
   *  alone — `shell-error-recovery` passes 2 of 5 on granite4.1 — so a one-shot
   *  baseline records whichever side the coin landed on, and the flip arrives
   *  later as a phantom regression. */
  trials?: number;
  passes?: number;
}
interface AgentBaseline {
  model: string;
  recordedAt: string;
  version: string;
  /** Conditions the run was measured under. Absent on baselines recorded
   *  before provenance tracking — those are incomparable, not invalid. */
  provenance?: BaselineProvenance;
  cases: Record<string, CaseBaseline>;
}

const slug = (model: string): string => model.replace(/[^a-zA-Z0-9._-]/g, '_');
const baselinePath = (model: string): string => path.join(BASELINE_DIR, `agent.${slug(model)}.json`);

function readVersion(): string {
  try {
    return (
      JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8')) as { version: string }
    ).version;
  } catch {
    return '0.0.0';
  }
}

function selectCases(): AgentEvalCase[] {
  return ALL_CASES.filter(
    (c) =>
      (!CASE_FILTER || CASE_FILTER.some((f) => c.id.includes(f))) &&
      (!TAG_FILTER || TAG_FILTER.every((t) => c.tags.includes(t))),
  );
}

const backend = pickAgentBackend();

describe.skipIf(!backend)('agent regression baseline', () => {
  const model = backend ? backend.defaultModel() : 'unavailable';
  // The hint named ollama regardless of which backend was actually in use,
  // so following it against a cloud baseline re-recorded the wrong thing.
  const recordHint =
    `  SIDECAR_EVAL_BACKEND=${backend?.name ?? 'ollama'} SIDECAR_EVAL_MODEL=${model} ` +
    `npm run eval:agent:baseline:record`;
  const bpath = baselinePath(model);
  const rel = (p: string) => path.relative(process.cwd(), p);
  // Opt-in + slow: a full run plus a retry on every regression.
  // A full sweep needs the budget the cases can actually consume. The old 4h cap
  // killed every model overnight mid-run: qwen reached case 32 of 70 at 4h02m —
  // and the 12h cap that replaced it died the same death at the 600s case
  // budget: 70 × 600s is 11.7h of legitimate case time, and one host
  // hibernation (2026-08-07: 8h on battery death) burns wall clock the cases
  // never saw — ministral was killed at case 55/70 by the CAP, not by work.
  // Per-case durations vary ~25x on the same model between runs, so a cap tuned
  // to a good run guarantees a bad one is truncated. Incremental flushing above
  // makes a long ceiling safe — an over-running sweep now keeps what it
  // measured, so the ceiling is just the computed worst case, uncapped.
  const timeout = 2 * ALL_CASES.length * (DEFAULT_CASE_TIMEOUT_MS + 10_000) + 120_000;

  if (RECORD_MODE) {
    it(
      `records a fresh baseline for ${model}`,
      async () => {
        const cases = selectCases();
        // Reading the version throws if it cannot be determined — a baseline
        // that cannot describe its own conditions must not be written, and
        // failing here costs nothing where failing after the run costs hours.
        const provenance = currentProvenance(model, runConfigForProvenance());
        const baseline: AgentBaseline = {
          model,
          recordedAt: new Date().toISOString(),
          version: readVersion(),
          provenance,
          cases: {},
        };
        fs.mkdirSync(BASELINE_DIR, { recursive: true });
        const flush = () => fs.writeFileSync(bpath, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');

        // Circuit breaker. `agent.eval.ts` has had one; this file did not, so a
        // backend that stops serving mid-sweep is absorbed one case at a time
        // and the run grinds on. Measured: Ollama's llama-server wedged after a
        // power loss — `/api/tags` still answered, so the API looked reachable —
        // and this loop sat for NINE HOURS producing nothing, on a vitest process
        // that looked perfectly alive. A liveness signal is not evidence the
        // thing works.
        let consecutiveUnavailable = 0;
        let totalUnavailable = 0;
        const CIRCUIT_BREAKER_THRESHOLD = 3;
        const startedAt = Date.now();

        // Append the run to the history log whatever happens to it. The log is
        // the only place a truncated run stays visible next to the complete ones
        // it replaced — twice in one sweep a partial write overwrote a better
        // baseline, and both were recoverable only from hand-taken copies.
        const recordHistory = (complete: boolean, abortReason?: string) => {
          const entries = Object.entries(baseline.cases);
          appendHistory(BASELINE_DIR, {
            at: new Date().toISOString(),
            model,
            version: baseline.version,
            provenance,
            casesRun: entries.length,
            casesAvailable: cases.length,
            filtered: Boolean(CASE_FILTER || TAG_FILTER),
            passed: entries.filter(([, v]) => v.passed).length,
            failed: entries.filter(([, v]) => !v.passed).length,
            unavailable: totalUnavailable,
            complete,
            ...(abortReason ? { abortReason } : {}),
            failedCases: entries.filter(([, v]) => !v.passed).map(([id]) => id),
            durationSec: Math.round((Date.now() - startedAt) / 1000),
          });
        };

        try {
          for (const [i, c] of cases.entries()) {
            if (consecutiveUnavailable >= CIRCUIT_BREAKER_THRESHOLD) {
              // Stop rather than skip. Everything recorded so far is already on
              // disk, so aborting costs nothing and burning the remaining budget
              // against a dead backend costs hours.
              throw new Error(
                `[baseline] circuit breaker: ${consecutiveUnavailable} consecutive cases returned nothing from ` +
                  `"${model}" — the backend is not serving. ${Object.keys(baseline.cases).length} cases are already ` +
                  `written to ${rel(bpath)}; re-run to continue. Check the backend is up and actually generating ` +
                  `(a reachable /api/tags does not mean it can serve).`,
              );
            }
            // runAgentCase THROWS on infra breakage rather than returning. That
            // suits agent.eval.ts, where each case is its own `it` — the throw
            // fails one test. Here every case shares a single `it`, so an
            // unguarded throw ends the model's entire run: llama3.2 died at
            // case 16 of 70 on "This operation was aborted", and the
            // incremental flush then left a 16-case file where a 69-case one
            // had been.
            //
            // An infra throw and the `apiUnavailable` return mean the same
            // thing — the backend gave nothing usable — so they are handled
            // identically, including counting toward the circuit breaker.
            let r: Awaited<ReturnType<typeof runAgentCase>>;
            try {
              r = await runAgentCase(c, backend!);
            } catch (err) {
              if (!isWrappedInfraFailure(err)) throw err; // a real harness bug must still fail
              consecutiveUnavailable++;
              totalUnavailable++;
              console.warn(
                `[baseline] ${c.id}: infra failure — not recorded ` +
                  `(${consecutiveUnavailable}/${CIRCUIT_BREAKER_THRESHOLD} before aborting): ` +
                  `${(err as Error).message.slice(0, 120)}`,
              );
              continue;
            }
            if (r.apiUnavailable) {
              consecutiveUnavailable++;
              totalUnavailable++;
              console.warn(
                `[baseline] ${c.id}: API unavailable — not recorded ` +
                  `(${consecutiveUnavailable}/${CIRCUIT_BREAKER_THRESHOLD} before aborting)`,
              );
              continue;
            }
            consecutiveUnavailable = 0;

            // Extra trials, when asked for. The run above is trial 1, so this
            // loop is skipped entirely at TRIALS=1 — cost and behaviour unchanged.
            const results = [r];
            for (let t = 1; t < TRIALS; t++) {
              try {
                const extra = await runAgentCase(c, backend!);
                if (!extra.apiUnavailable) results.push(extra);
              } catch (err) {
                if (!isWrappedInfraFailure(err)) throw err;
                // An infra failure on a later trial costs that trial, not the case.
              }
            }
            const passes = results.filter((x) => x.passed).length;
            baseline.cases[c.id] = {
              // Majority, so one unlucky trial cannot condemn a case that
              // usually works. At TRIALS=1 this is exactly the single result.
              passed: passes * 2 > results.length,
              iterationsUsed: r.iterationsUsed,
              durationMs: r.durationMs,
              ...(results.length > 1 ? { trials: results.length, passes } : {}),
            };
            if (results.length > 1 && passes > 0 && passes < results.length) {
              console.log(`[baseline] ${c.id}: MARGINAL — ${passes}/${results.length} trials passed`);
            }
            // Flush after EVERY case. The write used to happen once, after the
            // loop, so a run that died at case 32 of 70 discarded all 32 real
            // measurements — which is exactly what a 4h timeout did to three
            // models overnight, costing 12 hours and producing nothing. A partial
            // baseline is worth far more than none: the provenance guard makes it
            // safe to compare, and the missing cases simply are not compared.
            flush();
            console.log(
              `[baseline] ${i + 1}/${cases.length} ${c.id}: ${r.passed ? 'pass' : 'FAIL'} (${Math.round(r.durationMs / 1000)}s)`,
            );
          }
        } catch (err) {
          // A run that dies still produced measurements, and the reason it died
          // is the most useful field in the entry. Record, then rethrow — the
          // failure must still fail the run.
          recordHistory(false, (err as Error).message.slice(0, 200));
          throw err;
        }
        recordHistory(true);
        const total = Object.keys(baseline.cases).length;
        const passing = Object.values(baseline.cases).filter((c) => c.passed).length;
        console.log(`[baseline] recorded ${passing}/${total} passing for ${model} → ${rel(bpath)}`);
      },
      timeout,
    );
    return;
  }

  it(
    `no baseline-passing case regressed for ${model}`,
    async () => {
      if (!fs.existsSync(bpath)) {
        console.warn(`[baseline] no baseline for "${model}" (${rel(bpath)}). Record one:\n` + recordHint);
        return; // first run for this model — skip gracefully
      }
      const baseline = JSON.parse(fs.readFileSync(bpath, 'utf-8')) as AgentBaseline;

      // An incomparable baseline is worth exactly what a missing one is worth,
      // and is treated identically: say so, say why, say how to fix it, and do
      // not produce a verdict. Comparing across a changed tool surface or a
      // changed thinking configuration measures the change, not the model —
      // and a green result there is worse than no result, because it is
      // believed.
      const verdict = compareProvenance(baseline.provenance, currentProvenance(model, runConfigForProvenance()));
      if (!verdict.comparable) {
        console.warn(
          `[baseline] baseline for "${model}" (${rel(bpath)}) is NOT comparable to this run:\n` +
            verdict.divergences.map((d) => `  - ${d}`).join('\n') +
            `\nNo regression verdict was produced. Re-record:\n` +
            recordHint,
        );
        return;
      }

      const cases = ALL_CASES.filter((c) => Object.prototype.hasOwnProperty.call(baseline.cases, c.id));

      const regressions: { id: string; failures: string[] }[] = [];
      const improvements: string[] = [];
      const metricDrift: string[] = [];

      for (const c of cases) {
        const base = baseline.cases[c.id];
        // Same guard as the record loop: an infra throw here would abandon the
        // whole verification rather than excluding one case.
        let r: Awaited<ReturnType<typeof runAgentCase>>;
        try {
          r = await runAgentCase(c, backend!);
        } catch (err) {
          if (!isWrappedInfraFailure(err)) throw err;
          console.warn(`[baseline] ${c.id}: infra failure — excluded from the check`);
          continue;
        }
        if (r.apiUnavailable) {
          console.warn(`[baseline] ${c.id}: API unavailable — excluded from the check`);
          continue;
        }

        if (!base.passed && r.passed) improvements.push(c.id);

        if (base.passed && !r.passed) {
          // Retry once — filter a stochastic flip from a real regression.
          const retry = await runAgentCase(c, backend!);
          if (retry.apiUnavailable) {
            console.warn(`[baseline] ${c.id}: retry API-unavailable — excluded`);
          } else if (!retry.passed) {
            const failures = (retry.failures.length ? retry.failures : r.failures).slice(0, 6);
            regressions.push({ id: c.id, failures });
          } else {
            console.warn(`[baseline] ${c.id}: failed once then passed on retry — stochastic flip, not a regression`);
          }
        } else if (r.passed && base.passed && r.iterationsUsed > base.iterationsUsed + 2) {
          metricDrift.push(`${c.id}: iterations ${base.iterationsUsed} → ${r.iterationsUsed}`);
        }
      }

      if (improvements.length)
        console.log(`[baseline] improvements (baseline-fail → now-pass): ${improvements.join(', ')}`);
      if (metricDrift.length) console.log(`[baseline] metric drift (iterations grew):\n  ${metricDrift.join('\n  ')}`);

      if (regressions.length > 0) {
        const detail = regressions.map((rg) => `  ✗ ${rg.id}\n      ${rg.failures.join('\n      ')}`).join('\n');
        throw new Error(
          `${regressions.length} case(s) regressed vs baseline (recorded ${baseline.recordedAt}, v${baseline.version}) ` +
            `for ${model} — each failed twice:\n${detail}\n\n` +
            `If this is an intended behaviour change, re-record: npm run eval:agent:baseline:record`,
        );
      }
    },
    timeout,
  );
});
