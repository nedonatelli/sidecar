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
import { mountWorkspaceRoot } from './workspaceSandbox.js';
import { parseTasks, sampleTasks } from '../../bench/swe/loader.js';
import { armConfigOverrides } from '../../bench/swe/arms.js';
import { toPredictionsJsonl } from '../../bench/swe/predictions.js';
import { selectRelevantFiles, type RepoFile } from '../../bench/swe/retrieve.js';
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

const RETRIEVAL_TOPK = parseInt(process.env.SIDECAR_SWE_RETRIEVAL_TOPK ?? '6', 10);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', 'dist', '.tox', '.eggs', '__pycache__', 'docs']);

/** Read repo source files (bounded) for the keyword retriever. */
function gatherRepoFiles(dir: string, maxFiles = 4000, maxBytes = 80_000): RepoFile[] {
  const out: RepoFile[] = [];
  const walk = (rel: string): void => {
    if (out.length >= maxFiles) return;
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (out.length >= maxFiles) return;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(rel, entry.name));
      } else if (/\.(py|pyx)$/.test(entry.name)) {
        const p = path.join(rel, entry.name);
        try {
          const content = fs.readFileSync(path.join(dir, p), 'utf-8').slice(0, maxBytes);
          out.push({ path: p.split(path.sep).join('/'), content });
        } catch {
          /* unreadable — skip */
        }
      }
    }
  };
  walk('');
  return out;
}

/** An orientation block listing the files most relevant to the issue + head snippets. */
function buildRetrievalContext(dir: string, task: SweTask): string {
  const hits = selectRelevantFiles(gatherRepoFiles(dir), task.problem_statement, RETRIEVAL_TOPK);
  if (hits.length === 0) return '';
  const lines = ['Files in this repository most likely relevant to the issue (start here):'];
  for (const h of hits) {
    lines.push(`\n### ${h.path}`);
    try {
      const head = fs.readFileSync(path.join(dir, h.path), 'utf-8').split('\n').slice(0, 40).join('\n');
      lines.push('```python\n' + head + '\n```');
    } catch {
      /* skip snippet */
    }
  }
  return lines.join('\n');
}

async function solve(task: SweTask, arm: ArmName): Promise<SwePrediction> {
  const start = Date.now();
  let patch = '';
  let dir: string | null = null;
  let restoreMock: (() => void) | null = null;
  try {
    dir = checkoutRepo(task);
    // Point the vscode mock's fs/workspaceFolders/findFiles at the clone — without
    // this the agent's read_file hits the stub mock ("mock file content", 63b) and
    // loops until cycle detection bails. This is the same hook installSandbox uses.
    restoreMock = mountWorkspaceRoot(dir);
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
    // Trajectory: record every tool call + a tail of text so a run is never a
    // black box (and we can see whether the agent located + edited the file).
    const trajectory: string[] = [];
    const callbacks: AgentCallbacks = {
      onText: (t) => {
        if (t.trim()) trajectory.push(`  text: ${t.trim().slice(0, 200)}`);
      },
      onToolCall: (name, input) => {
        const arg = (input.path || input.pattern || input.query || input.command || '') as string;
        trajectory.push(`TOOL ${name}${arg ? ` ${String(arg).slice(0, 120)}` : ''}`);
      },
      onToolResult: (name, result, isError) => {
        trajectory.push(`  → ${name} ${isError ? 'ERROR' : 'ok'} (${result.length}b)`);
      },
      onDone: () => {},
    };
    const options: AgentOptions = {
      approvalMode: 'autonomous',
      maxIterations: MAX_ITERS,
      toolRuntime,
      // Critical: fs tools resolve paths via resolveRootUri(context), which
      // honors context.cwd first. Without cwdOverride they'd resolve against the
      // (wrong) default workspace root — read_file returned a 63-byte not-found
      // and the agent looped until cycle detection bailed. cwdOverride pins
      // every fs tool to the cloned repo (the Shadow Workspace mechanism).
      cwdOverride: dir,
      confirmFn: async () => 'Allow',
      config: { ...getConfig(), sandboxEnabled: false, ...armConfigOverrides(arm) },
    };
    const messages: ChatMessage[] = [{ role: 'user', content: buildTaskPrompt(task, buildRetrievalContext(dir, task)) }];
    try {
      await runAgentLoop(client, messages, callbacks, abort.signal, options);
    } finally {
      clearTimeout(timer);
    }
    patch = captureDiff(dir);
    fs.writeFileSync(path.join(OUT, `trajectory.${task.instance_id}.${arm}.log`), trajectory.join('\n') + '\n');
  } catch {
    patch = ''; // clone/agent failure = unresolved, not a lost run
  } finally {
    if (restoreMock) restoreMock();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  return { instance_id: task.instance_id, arm, model_patch: patch, durationMs: Date.now() - start };
}

function buildTaskPrompt(task: SweTask, retrievalContext: string): string {
  const head =
    `Resolve this GitHub issue in the repository. Make the minimal code change that fixes it, ` +
    `then stop — do not write new tests.\n\nIssue:\n${task.problem_statement}`;
  return retrievalContext ? `${head}\n\n---\n${retrievalContext}` : head;
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
