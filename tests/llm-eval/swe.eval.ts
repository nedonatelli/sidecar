// ---------------------------------------------------------------------------
// SWE-bench Lite — live prediction generation driver (Phase 2).
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
import { normalizeOllamaHost } from '../../src/ollama/hostUrl.js';
import { type AgentCallbacks, type AgentOptions } from '../../src/agent/loop.js';
import { createTurnLoopSession } from './agentTurnLoop.js';
import { circuitBreaker } from '../../src/ollama/circuitBreaker.js';
import type { ChatMessage } from '../../src/ollama/types.js';
import { ToolRuntime } from '../../src/agent/tools/runtime.js';
import { buildBaseSystemPrompt } from '../../src/webview/handlers/basePrompt.js';
import { getConfig } from '../../src/config/settings.js';
import { getToolDefinitionsForTier } from '../../src/agent/tools.js';
import { mountWorkspaceRoot } from './workspaceSandbox.js';
import { parseTasks, sampleTasks } from '../../bench/swe/loader.js';
import { armConfigOverrides } from '../../bench/swe/arms.js';
import { SCAFFOLD_VERSION, describeScaffold } from '../../src/agent/scaffoldVersion.js';
import { toPredictionsJsonl } from '../../bench/swe/predictions.js';
import { classifyFailure } from '../../bench/swe/failureClassification.js';
import { wholeSuiteGuard } from '../../bench/swe/wholeSuiteGuard.js';
import { renderTestModuleHint } from '../../bench/swe/testModules.js';
import { loadOrBuildRepoIndex, retrieveContext, goldFilesInTopK } from '../../bench/swe/rag.js';
import type { SymbolEmbeddingIndex } from '../../src/config/symbolEmbeddingIndex.js';
import type { SwePrediction, SweTask, ArmName } from '../../bench/swe/types.js';
import { setupTaskEnv, loadEnvSpecs, type SpecMap, type TaskEnv } from '../../bench/swe/taskEnv.js';

const DATA = process.env.SIDECAR_SWE_DATA;
const N = parseInt(process.env.SIDECAR_SWE_N ?? '5', 10);
const MODEL = process.env.SIDECAR_SWE_MODEL || 'gemma4:e4b';
const OUT = process.env.SIDECAR_SWE_OUT || path.join(os.tmpdir(), 'sidecar-swe');
const REPOS = (process.env.SIDECAR_SWE_REPOS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Deterministic task sharding for process-level parallelism. Each shard process
// handles tasks where (index % SHARD_COUNT === SHARD_INDEX), so N sharded
// processes cover the slice with no overlap and no shared in-process state (the
// vscode mock is a global singleton — concurrent in-process agents would stomp
// it). Default 1×0 = the whole slice, single process (unchanged behavior).
const SHARD_INDEX = parseInt(process.env.SIDECAR_SWE_SHARD_INDEX ?? '0', 10);
const SHARD_COUNT = parseInt(process.env.SIDECAR_SWE_SHARD_COUNT ?? '1', 10);
// SWE-bench tasks need a generous budget — a small local model spends many
// iterations just locating the file in a large repo. The fixture-eval default
// of 8 is far too few; default to 30 here. (Smoke run at 8 → empty patches.)
const MAX_ITERS = parseInt(process.env.SIDECAR_SWE_MAX_ITERS ?? '30', 10);
const PER_TASK_MS = parseInt(process.env.SIDECAR_SWE_TASK_TIMEOUT ?? '600000', 10);
// Per-(repo,version) solve environments (uv venvs) so run_tests/run_command work
// against installed deps. Specs from the committed env-specs.json (generated from
// swebench's MAP_REPO_VERSION_TO_SPECS). Venvs cached under the env cache base.
const ENV_SPECS: SpecMap = (() => {
  try {
    return loadEnvSpecs(path.resolve('bench/swe/data/env-specs.json'));
  } catch {
    return {};
  }
})();
const ENV_CACHE_BASE =
  process.env.SIDECAR_SWE_ENV_CACHE ||
  process.env.SIDECAR_SWE_REPO_CACHE ||
  path.join(os.tmpdir(), 'sidecar-swe-venvs');
// Arms to run this pass. Default is the core on/off ablation; SIDECAR_SWE_ARMS
// (comma-separated) selects a decomposed set, e.g. "scaffold-off,gate-only,scaffold-on".
const VALID_ARMS: readonly ArmName[] = ['scaffold-on', 'scaffold-off', 'gate-only', 'scaffold-on-ratchet'];
const ARMS: ArmName[] = (process.env.SIDECAR_SWE_ARMS || 'scaffold-off,scaffold-on')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((name) => {
    // `armConfigOverrides` returns SCAFFOLD_OFF from its `default` branch, so a
    // typo did not fail — it ran the BARE arm and labeled every prediction,
    // report and output file with the typo. Observed live: `SIDECAR_SWE_ARMS=
    // scaffold` produced a run reported as "scaffold" that was scaffold-off.
    if (!VALID_ARMS.includes(name as ArmName)) {
      throw new Error(`Unknown SWE arm "${name}". Valid arms: ${VALID_ARMS.join(', ')}`);
    }
    return name as ArmName;
  });

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString();
}

// One full clone per repo, reused across tasks/arms (the deterministic slice is
// big-repo-heavy, so re-cloning per task would dominate the run). Each use does
// a pristine `reset --hard <base> && clean -fdx`, so no agent edits leak between
// tasks or arms. Cleaned up after the run.
const repoClones = new Map<string, string>();

function resetHardWithRetry(dir: string, baseCommit: string, attempts = 3): void {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      if (i === attempts - 1) {
        // Last chance: pull the objects down explicitly rather than relying on
        // the lazy fetch that just failed.
        try {
          git(['fetch', '--quiet', 'origin', baseCommit], dir);
        } catch {
          /* best-effort — the reset below is what actually has to succeed */
        }
      }
      git(['reset', '--hard', '--quiet', baseCommit], dir);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Get the repo checked out cleanly at base_commit (cached clone, hard-reset). */
function prepareRepo(task: SweTask): string {
  let dir = repoClones.get(task.repo);
  if (!dir) {
    // Egress-flaky-host support: when SIDECAR_SWE_REPO_CACHE is set, reuse a
    // pre-populated FULL clone (all blobs present, so `reset --hard <base>`
    // needs no network). Falls back to a blobless clone otherwise.
    const cacheBase = process.env.SIDECAR_SWE_REPO_CACHE;
    if (cacheBase) {
      const cached = path.join(cacheBase, task.repo.replace(/[/\\]/g, '_'));
      if (!fs.existsSync(path.join(cached, '.git'))) throw new Error(`repo cache miss for ${task.repo} at ${cached}`);
      dir = cached;
    } else {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), `swe-repo-${task.repo.replace(/[/\\]/g, '_')}-`));
      git(['clone', '--quiet', '--filter=blob:none', `https://github.com/${task.repo}.git`, dir]);
    }
    repoClones.set(task.repo, dir);
  }
  // Pristine checkout at this task's base: discard any prior arm/task edits.
  //
  // Retried, because the fallback clone is `--filter=blob:none` and therefore
  // fetches blobs LAZILY — this reset needs the network, and a transient egress
  // failure here kills the task before the agent runs at all (0 turns, empty
  // patch). Measured: 3 of 20 tasks lost this way in one run, one of them after
  // a 955s stall. An explicit fetch of the commit precedes the last attempt so a
  // retry is not just the same failing lazy fetch again.
  resetHardWithRetry(dir, task.base_commit);
  git(['clean', '-fdxq'], dir);
  const head = git(['rev-parse', 'HEAD'], dir).trim();
  if (head !== task.base_commit)
    throw new Error(`checkout mismatch for ${task.instance_id}: ${head} != ${task.base_commit}`);
  return dir;
}

/**
 * Remove clone directories left behind by EARLIER runs.
 *
 * Per-run cleanup now disposes the shell that used to pin each directory, but
 * a killed run (Ctrl-C, a hung vitest child, a crash) never reaches its
 * `finally` at all. Without a sweep those leak forever: 167 directories and
 * several GB had accumulated over two days of measurement runs before anyone
 * looked at the temp folder.
 *
 * The age floor is the safety mechanism. A concurrent campaign's clones are
 * minutes old, so only directories untouched for hours are eligible -- this
 * sweep can never delete a live run's checkout. A failure to remove is ignored
 * for the same reason the per-run cleanup ignores one: this is disk hygiene,
 * and it must never take out the run that is starting.
 */
const STALE_CLONE_AGE_MS = 6 * 60 * 60 * 1000;

function sweepStaleClones(now: number = Date.now()): number {
  if (process.env.SIDECAR_SWE_REPO_CACHE) return 0;
  const tmp = os.tmpdir();
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith('swe-repo-')) continue;
    const dir = path.join(tmp, name);
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory() || now - st.mtimeMs < STALE_CLONE_AGE_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      removed++;
    } catch {
      // Still pinned, or gone already. Either way the next run tries again.
    }
  }
  if (removed > 0) console.log(`[swe] swept ${removed} stale repo clone(s) from ${tmp}`);
  return removed;
}

/**
 * Remove a clone, or failing that, empty it.
 *
 * Windows refuses `rmdir` on the clone root with EBUSY while every file inside
 * it deletes without complaint. Measured, twice, with the tree intact and 28
 * entries still present after a failed `fs.rmSync(recursive)` -- the removal
 * aborts on its FIRST operation, so nothing gets cleaned rather than
 * everything-but-the-root. The root frees the instant the test process exits,
 * and no child process survives to blame, so a directory handle is being held
 * somewhere inside this process.
 *
 * Two previous fixes for this were root-cause guesses and both did nothing: a
 * longer retry budget (bc429f3) on the theory that cleanup raced the shell's
 * force-kill, then killing the whole process tree (97fe8ab) on the theory that
 * a surviving grandchild held it. Rather than guess a third time, this works
 * with the behaviour actually measured: the contents are free, so take them.
 *
 * A clone left as an empty directory costs a directory entry instead of ~35MB,
 * and sweepStaleClones() collects it on a later run.
 */
function removeCloneDir(dir: string): 'removed' | 'emptied' | 'failed' {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return 'removed';
  } catch {
    // Fall through: the root may be busy while its contents are not.
  }
  let complete = true;
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch {
        complete = false;
      }
    }
  } catch {
    return 'failed';
  }
  try {
    fs.rmdirSync(dir);
    return 'removed';
  } catch {
    return complete ? 'emptied' : 'failed';
  }
}

function cleanupRepoClones(): void {
  // Never delete a pre-populated cache — it is reused across runs and (with a
  // per-model copy) across concurrent campaigns.
  if (!process.env.SIDECAR_SWE_REPO_CACHE) {
    for (const dir of repoClones.values()) {
      // Best-effort, and it MUST NOT throw. This runs in a `finally` after the
      // task loop, so a throw here skipped the `preds.{arm}.jsonl` writes
      // immediately below — the files the official swebench harness actually
      // consumes. A whole run's output was lost to a failed cleanup of a temp
      // directory.
      //
      // The EPERM is NOT read-only pack files, which is what this comment used
      // to claim: clearing the read-only bit changes nothing. Windows refuses to
      // remove a directory that is a live process's working directory, and the
      // per-task shell has its cwd there. toolRuntime.dispose() now kills it,
      // but ShellSession.dispose() sends SIGTERM and only force-kills after 3
      // SECONDS — so cleanup arriving immediately after the last task can still
      // land while the shell is dying. Measured: a 6-task run left exactly one
      // clone behind, and plain rmSync removed it the moment the run's process
      // exited.
      //
      // The retry budget below was raised from 1s to 4.5s to outlast that
      // force-kill. MEASURED: it did not help. A second 6-task run still left
      // exactly one clone behind, and the same directory deleted cleanly the
      // moment the run's process exited.
      //
      // So the holder is very likely a GRANDCHILD, not the shell: run_command
      // starts python inside the shell, and killing a process on Windows does
      // not kill its children. Orphaned venv pythons from earlier runs are still
      // on this box, which is exactly that failure mode. Fixing it properly
      // means killing the whole process tree in ShellSession.dispose() -- a
      // change to PRODUCT code, on the shell every user's run_command goes
      // through, and worth measuring on its own rather than smuggling in here.
      //
      // Residual: one clone per repo per run, which sweepStaleClones() collects
      // on a later run. Down from 167. Losing the directory still costs disk and
      // not correctness.
      const outcome = removeCloneDir(dir);
      if (outcome === 'emptied') {
        console.warn(`[swe] clone root still busy, emptied instead: ${dir}`);
      } else if (outcome === 'failed') {
        console.warn(`[swe] could not remove or empty clone: ${dir}`);
      }
    }
  }
  repoClones.clear();
}

/**
 * The agent's patch, scoped to the files it ACTUALLY edited, diffed against
 * base_commit — not a whole-repo `git diff`.
 *
 * A whole-repo diff trusts the repo tree to be pristine-base + the agent's
 * edits. That trust is fragile: any repo-state drift (a stray `git` in the
 * agent's shell, an env-setup step, or — observed live — two eval processes
 * sharing one cached clone and issuing conflicting `git reset`s) makes the diff
 * explode to hundreds of unrelated files (django-10914: a clean one-line fix
 * came back as a 475KB / 256-file "patch" because the tree had drifted to main).
 *
 * Scoping to `touchedPaths` (every edit_file/write_file/delete_file target) makes
 * the capture immune to that: unrelated files can drift all they want and never
 * reach the patch. base_commit stays the reference so a committed fix is still
 * captured (django-11848). Empty edits (edited then reverted) diff to nothing and
 * drop out. Returns '' when the agent touched no files.
 */
function captureDiff(dir: string, baseCommit: string, touchedPaths: Set<string>): string {
  const paths = [...touchedPaths];
  if (paths.length === 0) return '';
  git(['add', '-A', '--', ...paths], dir);
  return git(['diff', '--cached', baseCommit, '--', ...paths], dir);
}

const RETRIEVAL_TOPK = parseInt(process.env.SIDECAR_SWE_RETRIEVAL_TOPK ?? '6', 10);
// Mirrors SIDECAR_EVAL_CLIFF_GATE in agentHarness. The SWE path hardcoded the
// gate on, so the arm where injection was actually measured to hurt (top-6
// UNTRIMMED: 55% vs 85% for the leader alone) could not be run here at all.
const CLIFF_GATE = process.env.SIDECAR_SWE_CLIFF_GATE !== '0';

// Real RAG: SideCar's symbol-embedding index (local MiniLM, tree-sitter symbols)
// per repo, memoized (the build is the expensive part). Set on each task's
// ToolRuntime so the agent's real `project_knowledge_search` tool queries it —
// the same retrieval the product uses, not a bespoke keyword injection. Keyed by
// repo, not commit: symbols are stable enough across a repo's task commits, and
// rebuilding per task would dominate wall-clock.
const repoIndexCache = new Map<string, Promise<SymbolEmbeddingIndex>>();
function getRepoIndex(repo: string, dir: string): Promise<SymbolEmbeddingIndex> {
  let p = repoIndexCache.get(repo);
  if (!p) {
    // SIDECAR_SWE_RAG_MAX_FILES caps how many files the in-memory index embeds.
    // Full-repo embedding (django ≈ 4000 files) is minutes of MiniLM CPU inference;
    // a smaller cap makes a run start fast when the exact retrieval set doesn't
    // matter (e.g. measuring end-to-end context growth). Unset = full index.
    const maxFilesEnv = process.env.SIDECAR_SWE_RAG_MAX_FILES;
    const opts = maxFilesEnv ? { maxFiles: Number(maxFilesEnv) } : {};
    // Disk cache: build once per (repo, checked-out commit, maxFiles), then reuse
    // across processes — the ~5-8min MiniLM build becomes a ~few-second reload.
    // `dir` is at base_commit (prepareRepo just reset it), so the commit pins the
    // exact tree the vectors describe. SIDECAR_SWE_RAG_NO_CACHE forces a rebuild.
    const commit = git(['rev-parse', 'HEAD'], dir).trim().slice(0, 12);
    const cacheBase = process.env.SIDECAR_SWE_REPO_CACHE || os.tmpdir();
    const key = `${repo.replace(/[/\\]/g, '_')}_${commit}_${maxFilesEnv || 'full'}`;
    const prefix = path.join(cacheBase, 'rag-cache', key);
    if (process.env.SIDECAR_SWE_RAG_NO_CACHE) {
      p = loadOrBuildRepoIndex(dir, path.join(os.tmpdir(), `rag-nocache-${Date.now() % 1e9}`), opts);
    } else {
      p = loadOrBuildRepoIndex(dir, prefix, opts);
    }
    repoIndexCache.set(repo, p);
  }
  return p;
}

async function solve(task: SweTask, arm: ArmName): Promise<SwePrediction> {
  const start = Date.now();
  // Each benchmark task is independent — clear the backend circuit breaker so a
  // flaky earlier task (transient network blips against a remote endpoint) can't
  // leave the breaker OPEN and fast-fail every subsequent task. The breaker is a
  // cross-task process singleton; without this reset one bad task poisons the run.
  circuitBreaker.reset();
  let patch = '';
  let failureReason: string | null = null;
  let dir: string | null = null;
  let restoreMock: (() => void) | null = null;
  // Hoisted so the finally below can dispose it even when the run throws.
  let toolRuntime: ToolRuntime | null = null;
  // F1 failure-taxonomy bucket the loop terminated with (null = natural
  // completion). Diagnostic: lets us see WHY a run ended (stuck / timeout /
  // incomplete / bad-reasoning) instead of inferring it from patch shape alone.
  let terminationBucket: import('../../src/agent/failureTaxonomy.js').FailureBucket | null = null;
  // Did the keep-best ratchet revert scaffold-tail changes this run? Detected
  // from the loop's ♻️ marker — the third-arm ablation's revert-rate signal.
  let ratchetReverted = false;
  // Tool-call count is the infra-vs-capability discriminator (ported from
  // agentHarness's hasModelContent guard): a run that issued ZERO tool calls
  // never engaged the repo — it stalled or the model request timed out
  // (firstTokenTimeout, 300s) — so its empty patch is an infrastructure
  // failure, not the model failing the task. The ablation excludes these.
  let toolCalls = 0;
  // Files the agent mutated (edit_file/write_file/delete_file targets). captureDiff
  // scopes the patch to exactly these, so unrelated repo-state drift can't pollute it.
  const touchedPaths = new Set<string>();
  // Did the RAG retrieve a gold-patch file in the top-k (localization recall)?
  // SWE-bench as a RAG benchmark — undefined when the gold patch isn't known.
  let retrievalRecall: boolean | undefined;
  // Context-size instrumentation: the backend's ACTUAL prompt-token count per
  // turn (Ollama's prompt_eval_count via usage.inputTokens), so ballooning is
  // measured, not guessed. peak = the largest prompt the model was asked to
  // prefill in this solve.
  let peakInputTokens = 0;
  // Turn count = the highest loop iteration reached (each iteration is a full
  // model generation pass). The on-vs-off latency axis: scaffold-on can drive
  // MORE turns when a gate re-prompts or an autofix bounces an edit.
  let turns = 0;
  // How often the scaffold fired (gate re-prompts, autofixes, nudges), from the
  // loop's onOutcome meta. Zero on scaffold-off; a high count paired with worse
  // resolution is the harmful-scaffold signal.
  let scaffoldInterventions = 0;
  try {
    dir = prepareRepo(task);
    // Point the vscode mock's fs/workspaceFolders/findFiles at the clone — without
    // this the agent's read_file hits the stub mock ("mock file content", 63b) and
    // loops until cycle detection bails. This is the same hook installSandbox uses.
    restoreMock = mountWorkspaceRoot(dir);
    // Build (or reuse) the per-(repo,version) uv venv so run_tests/run_command
    // execute against installed deps. null = no local env (native-dep repo) →
    // the agent runs without one (blind) until the container fallback lands.
    const taskEnv = task.version ? setupTaskEnv(task.repo, task.version, dir, ENV_CACHE_BASE, ENV_SPECS) : null;
    toolRuntime = new ToolRuntime(dir, taskEnv?.env);
    // Real RAG: attach the repo's symbol-embedding index so the agent's
    // project_knowledge_search tool queries it (same retrieval as the product),
    // and seed the orientation block from the SAME index — real symbol bodies,
    // not the old keyword-ranked file heads.
    const repoIndex = await getRepoIndex(task.repo, dir);
    toolRuntime.symbolEmbeddings = repoIndex;
    const retrieval = await retrieveContext(repoIndex, task.problem_statement, dir, RETRIEVAL_TOPK, CLIFF_GATE);
    retrievalRecall = task.patch ? goldFilesInTopK(retrieval.hits, task.patch).recalled : undefined;
    // API key defaults to 'ollama' (local, authless). Set SIDECAR_SWE_API_KEY to
    // a bearer token to drive a remote OpenAI-compatible endpoint instead — e.g.
    // a Vast box's token-authed /v1 edge (OLLAMA_HOST=http://<host>:<port>), which
    // uses independent HTTP requests rather than a fragile persistent SSH tunnel.
    const systemPrompt = buildBaseSystemPrompt({
      isLocal: true,
      extensionVersion: '0.0.0-bench',
      repoUrl: '',
      docsUrl: '',
      root: dir,
      approvalMode: 'autonomous',
    });
    // Trajectory: append every event to disk LIVE (not buffered-then-dumped), so
    // a run is watchable mid-flight with `tail -f` — same observability the
    // real product/logger gives, instead of a black box until the solve ends.
    // Tool RESULTS carry a content snippet so run_tests/run_command output (the
    // real test feedback) is visible, not just a byte count.
    const trajPath = path.join(OUT, `trajectory.${task.instance_id}.${arm}.log`);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(trajPath, '');
    // Elapsed-ms stamps (not wall clock) so trajectories stay diffable across
    // runs. Without these, model time and tool time are indistinguishable: a
    // `run_command` that runs django's suite for four minutes looks identical
    // to a slow model turn, which made every latency question about this
    // harness undecidable.
    const solveStartedAt = Date.now();
    const traj = (line: string): void => {
      try {
        fs.appendFileSync(trajPath, `[+${Date.now() - solveStartedAt}ms] ${line}\n`);
      } catch {
        /* best-effort logging — never fail a solve on a log write */
      }
    };
    const snippet = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 300);
    // onText streams token-by-token; buffer it and flush a whole message as one
    // line (before the next tool call / at termination) so the log is readable.
    let textBuf = '';
    const flushText = (): void => {
      const t = textBuf.replace(/\s+/g, ' ').trim();
      if (t) traj(`  text: ${t.slice(0, 300)}`);
      textBuf = '';
    };
    const callbacks: AgentCallbacks = {
      onText: (t) => {
        if (t.includes('Keep-best ratchet reverted')) ratchetReverted = true;
        textBuf += t;
      },
      onToolCall: (name, input) => {
        flushText();
        toolCalls += 1;
        const arg = (input.path || input.pattern || input.query || input.command || '') as string;
        // Record which files the agent mutates, so captureDiff can scope the
        // patch to exactly those (immune to unrelated repo-state drift).
        if (
          (name === 'edit_file' || name === 'write_file' || name === 'delete_file') &&
          typeof input.path === 'string'
        ) {
          touchedPaths.add(input.path);
        }
        traj(`TOOL ${name}${arg ? ` ${String(arg).slice(0, 120)}` : ''}`);
      },
      onToolResult: (name, result, isError) => {
        const snip = snippet(result);
        traj(`  → ${name} ${isError ? 'ERROR' : 'ok'} (${result.length}b)${snip ? `: ${snip}` : ''}`);
      },
      onUsage: (usage) => {
        // Ground-truth context size: what the model actually prefilled this turn.
        if (usage.inputTokens > peakInputTokens) peakInputTokens = usage.inputTokens;
        traj(`  CONTEXT in=${usage.inputTokens}tok out=${usage.outputTokens}tok (peak_in=${peakInputTokens})`);
      },
      onIterationStart: (info) => {
        // The loop increments iteration at the top of each pass, so the last
        // value seen is the turn count the run terminated on.
        turns = info.iteration;
      },
      onOutcome: (bucket, meta) => {
        flushText();
        terminationBucket = bucket;
        if (meta) scaffoldInterventions = meta.scaffoldInterventions;
        traj(`TERMINATION: ${bucket ?? 'natural'} turns=${turns} scaffoldInterventions=${scaffoldInterventions}`);
      },
      onDone: () => flushText(),
    };
    const armConfig = { ...getConfig(), sandboxEnabled: false, ...armConfigOverrides(arm) };
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
      config: armConfig,
      // Remove `run_tests` outright rather than telling the model not to use it.
      // Its runner auto-detection picks npm in any repo that also ships a
      // package.json, so on django it ran `pretest > eslint django/ js_tests/...`
      // — linting JavaScript instead of running Python tests, and reporting `ok`.
      // The prompt DID say "NOT run_tests"; the model used it anyway on the first
      // task of the first run. Negative instructions do not hold at a 27K
      // context, so the harness removes the option instead of asking.
      toolOverride: getToolDefinitionsForTier('full', undefined, armConfig).filter((t) => t.name !== 'run_tests'),
      // Runs in BOTH arms: this is a zero-token deterministic control, like cycle
      // detection and the thrash defenses, not part of the verification
      // scaffolding under test. A whole-suite invocation is a harness-cost bug
      // (thousands of tests, truncated output) that would otherwise distort both
      // arms' wall clock and leave the agent with no usable test signal.
      extraPolicyHooks: [wholeSuiteGuard()],
    };
    const userMsg = buildTaskPrompt(task, retrieval.context, taskEnv, dir);
    const messages: ChatMessage[] = [{ role: 'user', content: userMsg }];
    // Initial-prompt size BEFORE the first model call — logged unconditionally so
    // a first-token timeout (which produces no usage event) still tells us how big
    // the turn-0 context was, and which piece (system prompt vs RAG orientation vs
    // problem statement) dominates it.
    traj(
      `INIT system=${systemPrompt.length}c user=${userMsg.length}c ` +
        `(rag_orientation=${retrieval.context.length}c problem=${task.problem_statement.length}c) ` +
        `total≈${systemPrompt.length + userMsg.length}c`,
    );
    // The shared core owns client construction, system-prompt assignment, the
    // abort/timeout, and surface recording — the four things this file used to
    // re-implement, and where it silently diverged from agentHarness (hardcoded
    // ollama backend, unrecorded prompt surface, timeouts indistinguishable
    // from failures).
    const session = createTurnLoopSession({
      model: MODEL,
      baseUrl: normalizeOllamaHost(process.env.OLLAMA_HOST || '') || 'http://localhost:11434',
      apiKey: process.env.SIDECAR_SWE_API_KEY || 'ollama',
      systemPrompt,
      options,
      // This file's own per-task trajectory callbacks are preserved; the session
      // wraps them, so SWE keeps its elapsed-ms log AND gains the structured
      // record promptlab reads.
      callbacks,
      timeoutMs: PER_TASK_MS,
      caseId: task.instance_id,
      arm,
      trial: 0,
      ragOrientationChars: retrieval.context.length,
      logDir: OUT,
    });
    try {
      await session.run(messages);
    } finally {
      const closed = session.close(terminationBucket ?? 'natural');
      // A timeout is a fact about the configuration, not the model. It used to
      // arrive as a bare abort and land in the same bucket as a real failure.
      if (closed.timedOut && !failureReason) failureReason = `per-task timeout after ${PER_TASK_MS}ms`;
    }
  } catch (err) {
    // Surface the cause — a silently swallowed failure here turned a broken
    // OLLAMA_HOST into 150 instant 'EMPTY' rows that looked like model
    // behavior (observed live). The `[kind]` tag makes that class of mistake
    // visible at a glance instead of after 150 rows.
    const classified = classifyFailure(err);
    failureReason = classified.reason;
    console.error(`[swe] solve failed for ${task.instance_id} (${arm}) [${classified.kind}]:`, classified.reason);
  } finally {
    // ALWAYS attempt the diff, including after a throw. `captureDiff` used to
    // sit inside the try AFTER the agent loop, so any abort — per-task timeout,
    // fetch failure, stream error — skipped it and forced an empty patch,
    // discarding edits the agent had already written to disk. `touchedPaths` is
    // populated during the run, so the diff is recoverable. The loss was not
    // random: it fell on whichever arm ran longest, systematically understating
    // scaffolded arms.
    // `dir` is null only when prepareRepo itself threw — no checkout, so there
    // is genuinely nothing on disk to salvage.
    try {
      patch = dir ? captureDiff(dir, task.base_commit, touchedPaths) : '';
    } catch {
      patch = '';
    }
    if (restoreMock) restoreMock();
    // Dispose the per-task shell. ToolRuntime spawns a PERSISTENT shell whose
    // cwd is the clone, and nothing ever released it: one orphaned shell per
    // task (50 per run), each pinning a directory that Windows then refuses to
    // delete. That is what produced the cleanup warnings --
    //
    //   EPERM, Permission denied: \?\C:\...\swe-repo-astropy_astropy-e3LOTH
    //
    // note the failure is on the DIRECTORY, not on a file inside it: on Windows
    // a directory that is any live process's working directory cannot be
    // removed. 184 such warnings across the runs recorded so far, and the
    // clones they left behind were still on disk days later.
    toolRuntime?.dispose();
    // Don't delete the clone — it's cached and reset per task. cleanupRepoClones() at the end.
  }
  return {
    instance_id: task.instance_id,
    arm,
    model_patch: patch,
    durationMs: Date.now() - start,
    terminationBucket,
    toolCalls,
    failureReason,
    retrievalRecall,
    ratchetReverted,
    peakInputTokens,
    turns,
    scaffoldInterventions,
  };
}

function buildTaskPrompt(task: SweTask, retrievalContext: string, taskEnv: TaskEnv | null, repoDir: string): string {
  // With a working environment, ask for the real coding loop (reproduce → fix →
  // verify). Give the exact Python test command from the spec and steer AWAY
  // from run_tests: its auto-detection picks the wrong runner in repos that also
  // ship a package.json (e.g. django's `pretest: eslint`). Without an env, the
  // old blind "minimal change then stop" is all the agent can do.
  const runner = taskEnv?.testCmd ?? './run tests';
  const workflow = taskEnv
    ? `The repository's dependencies are installed in the active environment. Run its Python tests with ` +
      `run_command.\n\n` +
      `You MUST scope every test run to the module for this issue by appending a test label:\n` +
      `  ${runner} <test_label>\n` +
      `The label is the runner's own MODULE notation, not a filesystem path:\n` +
      `  correct:   \`${runner} some_module\`   or   \`${runner} some_module.test_file\`\n` +
      `  incorrect: \`${runner} tests/some_module/\`   \`${runner} tests/some_module/tests.py\`\n` +
      `Drop any \`tests/\` prefix, trailing slash and \`.py\` suffix; use dots, not slashes. ` +
      `A path-shaped label is rejected by the runner with an import error and runs no tests at all.\n` +
      `A label names a TEST module, NOT the source module you edited — a source path runs zero tests ` +
      `and reports \`Ran 0 tests ... OK\`, which is a failure, not a pass.\n` +
      `${renderTestModuleHint(repoDir)}\n` +
      `Do NOT run \`${runner}\` with no label — that executes the project's entire suite (thousands of tests). ` +
      `It takes many minutes and its output is truncated before the part you need, so it cannot tell you ` +
      `whether your fix worked.\n\n` +
      `Reproduce the issue with a failing test, make the code change that fixes it, then re-run the scoped ` +
      `tests to verify before you finish.`
    : `Make the minimal code change that fixes it, then stop — do not write new tests.`;
  const head = `Resolve this GitHub issue in the repository. ${workflow}\n\nIssue:\n${task.problem_statement}`;
  return retrievalContext ? `${head}\n\n---\n${retrievalContext}` : head;
}

describe('SWE-bench Lite — prediction generation', () => {
  it.skipIf(!DATA)(
    `generates predictions for ${MODEL}`,
    async () => {
      sweepStaleClones();
      const all = parseTasks(fs.readFileSync(DATA as string, 'utf-8'));
      const sampled = sampleTasks(all, N, REPOS);
      // Take this shard's slice (round-robin over the deterministic sample).
      const tasks = SHARD_COUNT > 1 ? sampled.filter((_, i) => i % SHARD_COUNT === SHARD_INDEX) : sampled;
      fs.mkdirSync(OUT, { recursive: true });

      // Provenance manifest (workstreams #1): every run records exactly what
      // produced it — model, seed, temperature, slice, arms — so a resolve/lift
      // number is reproducible and attributable, not a floating point estimate.
      const seedEnv = process.env.SIDECAR_AGENT_SEED;
      const manifest = {
        model: MODEL,
        backend: 'ollama',
        ollamaHost: normalizeOllamaHost(process.env.OLLAMA_HOST || '') || 'http://localhost:11434',
        agentTemperature: getConfig().agentTemperature,
        agentSeed: seedEnv !== undefined && seedEnv !== '' ? Number(seedEnv) : (getConfig().agentSeed ?? null),
        dataset: path.basename(DATA as string),
        taskCount: tasks.length,
        requestedN: N,
        shardIndex: SHARD_INDEX,
        shardCount: SHARD_COUNT,
        // Scaffold provenance: the version + the ACTUAL mechanism on/off state
        // per arm, so a resolve/lift number is attributable to the exact scaffold
        // that produced it (the scaffold evolves; results must be comparable only
        // across matching versions).
        scaffoldVersion: SCAFFOLD_VERSION,
        scaffold: Object.fromEntries(
          ARMS.map((arm) => [arm, describeScaffold({ ...getConfig(), ...armConfigOverrides(arm) })]),
        ),
        repos: REPOS,
        arms: ARMS,
        maxIterations: MAX_ITERS,
        retrievalTopK: RETRIEVAL_TOPK,
        retrievalCliffGate: CLIFF_GATE,
        // The deterministic control layer. bench/swe/README notes it is not
        // config-gated and runs in BOTH ablation arms, so a scaffold-on/off
        // number never isolates it. When these are disabled the run is a bare
        // loop — a different baseline entirely — and a manifest that omits
        // them reads exactly like a normal guarded run.
        cycleDetectionDisabled: process.env.SIDECAR_DISABLE_CYCLE_DETECTION === 'true',
        circuitBreakerDisabled: process.env.SIDECAR_DISABLE_CIRCUIT_BREAKER === 'true',
        perTaskTimeoutMs: PER_TASK_MS,
        nodeVersion: process.version,
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(OUT, 'run.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      console.info(`[swe] ${MODEL}: ${tasks.length} tasks × ${ARMS.length} arms`);

      const predictions: SwePrediction[] = [];
      const metaPath = path.join(OUT, 'predictions.meta.jsonl');
      fs.writeFileSync(metaPath, ''); // truncate; we append per prediction so a crash mid-run keeps progress
      try {
        for (const task of tasks) {
          for (const arm of ARMS) {
            const p = await solve(task, arm);
            predictions.push(p);
            fs.appendFileSync(metaPath, JSON.stringify(p) + '\n');
            // Tag the failure kind inline. Now that an aborted run keeps its
            // edits, "1364b patch [infra]" is a distinct and useful state —
            // the model produced real work and the RUN died, which reads
            // nothing like a capability failure. Without the tag here you have
            // to cross-reference the `solve failed` line above to tell them
            // apart while scanning a log.
            const kind = p.failureReason ? classifyFailure(new Error(p.failureReason)).kind : null;
            console.info(
              `[swe]   ${task.instance_id} ${arm}: ${p.model_patch ? `${p.model_patch.length}b patch` : 'EMPTY'}` +
                `${kind ? ` [${kind}]` : ''} ` +
                `(${Math.round(p.durationMs / 1000)}s, ${p.turns} turns, ${p.scaffoldInterventions} scaffold-fires)`,
            );
          }
        }
      } finally {
        cleanupRepoClones();
      }

      for (const arm of ARMS) {
        fs.writeFileSync(path.join(OUT, `preds.${arm}.jsonl`), toPredictionsJsonl(predictions, MODEL, arm));
      }
      console.info(`[swe] wrote predictions to ${OUT}/preds.{${ARMS.join(',')}}.jsonl (+ predictions.meta.jsonl)`);
      expect(predictions).toHaveLength(tasks.length * ARMS.length);
    },
    N * ARMS.length * PER_TASK_MS + 60_000,
  );
});
