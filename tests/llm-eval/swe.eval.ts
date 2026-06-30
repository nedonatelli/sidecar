// ---------------------------------------------------------------------------
// SWE-bench Verified — live prediction generation driver (Phase 2).
//
// For each sampled task and each ablation arm: check the repo out at base_commit
// into a temp dir, run SideCar's agent loop autonomously against the issue with
// that arm's scaffold config, capture the unified diff as the prediction, and
// write official `swebench`-format JSONL per arm. Scoring is delegated to the
// official harness (Docker) — see bench/swe/README.md.
//
//   SIDECAR_SWE_DATA=/path/to/swe_verified.jsonl \
//   SIDECAR_SWE_N=5 SIDECAR_SWE_MODEL=gemma4:e4b SIDECAR_SWE_OUT=/path/to/out \
//   npm run bench:swe:predict
//
// Heavy + slow (real clones + a full agent run per task per arm) and cannot be
// scored without Docker, so it is gated to run only when SIDECAR_SWE_DATA is set.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'node:child_process';
import { runAgentLoop, type AgentCallbacks, type AgentOptions } from '../../src/agent/loop.js';
import { SideCarClient } from '../../src/ollama/client.js';
import type { ChatMessage } from '../../src/ollama/types.js';
import { ToolRuntime } from '../../src/agent/tools/runtime.js';
import { buildBaseSystemPrompt } from '../../src/webview/handlers/basePrompt.js';
import { getConfig } from '../../src/config/settings.js';
import { needsColdStart } from '../../src/config/modelAgentBehavior.js';
import { parseTasks, sampleTasks } from '../../bench/swe/loader.js';
import { armConfigOverrides } from '../../bench/swe/arms.js';
import { toPredictionsJsonl } from '../../bench/swe/predictions.js';
import type { SwePrediction, SweTask, ArmName } from '../../bench/swe/types.js';

const DATA = process.env.SIDECAR_SWE_DATA;
const N = parseInt(process.env.SIDECAR_SWE_N ?? '5', 10);
const MODEL = process.env.SIDECAR_SWE_MODEL || 'gemma4:e4b';
const OUT = process.env.SIDECAR_SWE_OUT || path.join(os.tmpdir(), 'sidecar-swe');
const REPOS = (process.env.SIDECAR_SWE_REPOS || '').split(',').map((s) => s.trim()).filter(Boolean);
// SWE-bench tasks need a generous budget — a small local model spends many
// iterations just locating the file in a large repo. The fixture-eval default
// of 8 is far too few; default to 30 here. (Smoke run at 8 → empty patches.)
const MAX_ITERS = parseInt(process.env.SIDECAR_SWE_MAX_ITERS ?? '30', 10);
const PER_TASK_MS = parseInt(process.env.SIDECAR_SWE_TASK_TIMEOUT ?? '600000', 10);
const ARMS: ArmName[] = ['scaffold-off', 'scaffold-on'];

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString();
}

/** Clone the repo at base_commit into a fresh temp dir; return the path. */
function checkoutRepo(task: SweTask): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `swe-${task.instance_id}-`));
  git(['clone', '--quiet', `https://github.com/${task.repo}.git`, dir]);
  git(['checkout', '--quiet', task.base_commit], dir);
  return dir;
}

/** Everything the agent changed, as a unified diff against base_commit. */
function captureDiff(dir: string): string {
  git(['add', '-A'], dir);
  return git(['diff', '--cached', 'HEAD'], dir);
}

async function solve(task: SweTask, arm: ArmName): Promise<SwePrediction> {
  const start = Date.now();
  let patch = '';
  let dir: string | null = null;
  try {
    dir = checkoutRepo(task);
    const toolRuntime = new ToolRuntime(dir);
    const client = new SideCarClient(MODEL, process.env.OLLAMA_HOST || 'http://localhost:11434', 'ollama');
    client.updateSystemPrompt(
      buildBaseSystemPrompt({
        isLocal: true,
        extensionVersion: '0.0.0-bench',
        repoUrl: '',
        docsUrl: '',
        root: dir,
        approvalMode: 'autonomous',
      }),
    );
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PER_TASK_MS);
    const callbacks: AgentCallbacks = { onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onDone: () => {} };
    const options: AgentOptions = {
      approvalMode: 'autonomous',
      maxIterations: MAX_ITERS,
      toolRuntime,
      confirmFn: async () => 'Allow',
      config: { ...getConfig(), sandboxEnabled: false, ...armConfigOverrides(arm) },
    };
    const coldStart = needsColdStart(MODEL);
    const messages: ChatMessage[] = [{ role: 'user', content: buildTaskPrompt(task) }];
    void coldStart;
    try {
      await runAgentLoop(client, messages, callbacks, abort.signal, options);
    } finally {
      clearTimeout(timer);
    }
    patch = captureDiff(dir);
  } catch {
    patch = ''; // clone/agent failure = unresolved, not a lost run
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  return { instance_id: task.instance_id, arm, model_patch: patch, durationMs: Date.now() - start };
}

function buildTaskPrompt(task: SweTask): string {
  return (
    `Resolve this GitHub issue in the repository. Make the minimal code change that fixes it, ` +
    `then stop — do not write new tests.\n\nIssue:\n${task.problem_statement}`
  );
}

describe('SWE-bench Verified — prediction generation', () => {
  it.skipIf(!DATA)(
    `generates predictions for ${MODEL}`,
    async () => {
      const all = parseTasks(fs.readFileSync(DATA as string, 'utf-8'));
      const tasks = sampleTasks(all, N, REPOS);
      fs.mkdirSync(OUT, { recursive: true });
      // eslint-disable-next-line no-console
      console.info(`[swe] ${MODEL}: ${tasks.length} tasks × ${ARMS.length} arms`);

      const predictions: SwePrediction[] = [];
      for (const task of tasks) {
        for (const arm of ARMS) {
          const p = await solve(task, arm);
          predictions.push(p);
          // eslint-disable-next-line no-console
          console.info(`[swe]   ${task.instance_id} ${arm}: ${p.model_patch ? `${p.model_patch.length}b patch` : 'EMPTY'} (${Math.round(p.durationMs / 1000)}s)`);
        }
      }

      for (const arm of ARMS) {
        fs.writeFileSync(path.join(OUT, `preds.${arm}.jsonl`), toPredictionsJsonl(predictions, MODEL, arm));
      }
      // Richer sidecar file (with durations) for the ablate step — the official
      // JSONL strips everything but instance_id/model/patch.
      fs.writeFileSync(path.join(OUT, 'predictions.meta.jsonl'), predictions.map((p) => JSON.stringify(p)).join('\n') + '\n');
      // eslint-disable-next-line no-console
      console.info(`[swe] wrote predictions to ${OUT}/preds.{scaffold-on,scaffold-off}.jsonl (+ predictions.meta.jsonl)`);
      expect(predictions).toHaveLength(tasks.length * ARMS.length);
    },
    N * ARMS.length * PER_TASK_MS + 60_000,
  );
});
