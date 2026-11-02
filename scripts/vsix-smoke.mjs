#!/usr/bin/env node
// Installed-VSIX smoke test (#396).
//
// `test:integration` loads SideCar from the source tree. This installs the
// packaged .vsix into a clean VS Code — its own extensions and user-data
// directories, nothing from the developer's profile — opens a fresh copy of
// this repo (`git archive HEAD`, so no `.sidecar/` caches), records an
// extension-host CPU profile from the first line of activation, and checks the
// SideCar log against startup budgets. It runs several times because the stall
// it was written for is intermittent (the same repo's documentation index has
// built in 8 s and in 623 s).
//
// Usage:
//   node scripts/vsix-smoke.mjs --vsix sidecar-ai-0.135.0.vsix [--runs 3] [--out dir] [--timeout-s 900]
//   node scripts/vsix-smoke.mjs --build            (runs `npm run package` first)
//
// Exits 1 when any run breaks a budget. Each run leaves its SideCar log, its
// .cpuprofile (open in Chrome DevTools or VS Code) and a summary in --out.

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } from '@vscode/test-electron';
import { parseSidecarLog, checkRun, topSelfTime, DEFAULT_BUDGETS } from './lib/vsixSmoke.mjs';

// Same pin as .vscode-test.mjs, so the smoke test and the integration suite run one VS Code.
const VSCODE_VERSION = '1.142.0';
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');

function parseArgs(argv) {
  const args = { runs: 3, timeoutS: 900, build: false, vsix: undefined, out: undefined, port: 9333 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--build') args.build = true;
    else if (a === '--vsix') args.vsix = argv[++i];
    else if (a === '--runs') args.runs = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--timeout-s') args.timeoutS = Number(argv[++i]);
    else if (a === '--port') args.port = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newestVsix() {
  const found = readdirSync(REPO)
    .filter((f) => f.endsWith('.vsix'))
    .map((f) => ({ f, t: statSync(path.join(REPO, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!found.length) throw new Error('no .vsix in the repo root: pass --vsix or --build');
  return path.join(REPO, found[0].f);
}

/** A fresh, cold copy of the committed tree: what a user's clone looks like. */
function freshWorkspace(dir) {
  mkdirSync(dir, { recursive: true });
  const archive = spawnSync('git', ['-C', REPO, 'archive', '--format=tar', 'HEAD'], { maxBuffer: 1 << 30 });
  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout, maxBuffer: 1 << 30 });
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
}

function findFiles(dir, re, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(p, re, out);
    else if (re.test(e.name)) out.push(p);
  }
  return out;
}

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Connect to the extension host's inspector and start profiling before activation runs. */
async function attachProfiler(port, deadline) {
  let target;
  while (!target) {
    if (Date.now() > deadline) throw new Error(`no extension-host inspector on port ${port}`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.webSocketDebuggerUrl);
    } catch {
      // not listening yet
    }
    if (!target) await sleep(250);
  }
  const ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('inspector websocket failed'));
  });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 1000 });
  await send('Profiler.start');
  // --inspect-brk-extensions holds the host at its first line until this.
  await send('Runtime.runIfWaitingForDebugger');
  return {
    async stop() {
      const res = await send('Profiler.stop');
      ws.close();
      return res.result?.profile;
    },
  };
}

async function runOnce(n, { vscodeExe, cli, vsix, outDir, timeoutS, port }) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), `sidecar-vsix-smoke-${n}-`));
  const extDir = path.join(scratch, 'extensions');
  const userDir = path.join(scratch, 'user-data');
  const ws = path.join(scratch, 'workspace');
  try {
    freshWorkspace(ws);
    mkdirSync(path.join(userDir, 'User'), { recursive: true });
    writeFileSync(
      path.join(userDir, 'User', 'settings.json'),
      JSON.stringify(
        {
          'telemetry.telemetryLevel': 'off',
          'workbench.startupEditor': 'none',
          'security.workspace.trust.enabled': false,
          'extensions.autoUpdate': false,
          'extensions.autoCheckUpdates': false,
          'update.mode': 'none',
        },
        null,
        2,
      ),
    );
    execFileSync(
      cli,
      ['--extensions-dir', extDir, '--user-data-dir', userDir, '--install-extension', vsix, '--force'],
      {
        stdio: 'ignore',
        shell: process.platform === 'win32',
      },
    );

    const started = Date.now();
    const code = spawn(
      vscodeExe,
      [
        ws,
        '--extensions-dir',
        extDir,
        '--user-data-dir',
        userDir,
        `--inspect-brk-extensions=${port}`,
        '--new-window',
        '--skip-release-notes',
        '--skip-welcome',
        '--disable-workspace-trust',
      ],
      { stdio: 'ignore', detached: process.platform !== 'win32' },
    );
    const profiler = await attachProfiler(port, started + 60_000);

    // Done when indexing reports ready and the documentation index has finished, or at the timeout.
    let log = '';
    let logFile;
    const deadline = started + timeoutS * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);
      logFile ??= findFiles(path.join(userDir, 'logs'), /SideCar\.log$/)[0];
      if (!logFile) continue;
      log = readFileSync(logFile, 'utf-8');
      if (/Indexing status: ready/.test(log) && /Documentation index built/.test(log)) break;
    }
    // A few more seconds for the stall summary and the model list.
    await sleep(5000);
    if (logFile) log = readFileSync(logFile, 'utf-8');
    const profile = await profiler.stop().catch(() => undefined);
    killTree(code.pid);

    const runDir = path.join(outDir, `run${n}`);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'SideCar.log'), log);
    if (profile) writeFileSync(path.join(runDir, 'extension-host.cpuprofile'), JSON.stringify(profile));
    const result = checkRun(parseSidecarLog(log), DEFAULT_BUDGETS);
    const hot = profile ? topSelfTime(profile) : [];
    writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ ...result, hot }, null, 2));
    return { n, ...result, hot, timedOut: Date.now() >= deadline };
  } finally {
    // The workspace copy and the profile dirs are disposable; the evidence is in runDir.
    await sleep(1000);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  }
}

function report(runs, { vsix, outDir }) {
  const lines = [
    `# Installed-VSIX smoke (#396)`,
    '',
    `VSIX: ${path.basename(vsix)}  ·  VS Code ${VSCODE_VERSION}  ·  ${new Date().toISOString()}`,
    '',
    '| Run | Ready | Tree-sitter → graph | Doc index | Longest stall | Stalls | Models | Result |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  const s = (ms) => (ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} s`);
  for (const r of runs) {
    const t = r.timings;
    lines.push(
      `| ${r.n} | ${s(t.readyMs)} | ${s(t.symbolGraphMs)} | ${s(t.docIndexMs)} | ${s(t.longestStallMs)} | ${t.stallCount} | ${s(t.modelsMs)} | ${r.failures.length ? 'FAIL' : 'pass'} |`,
    );
  }
  for (const r of runs) {
    if (r.failures.length) lines.push('', `**Run ${r.n} failures:**`, ...r.failures.map((f) => `- ${f}`));
  }
  const worst = [...runs].sort((a, b) => (b.timings.longestStallMs ?? 0) - (a.timings.longestStallMs ?? 0))[0];
  if (worst?.hot.length) {
    lines.push('', `**Run ${worst.n} (longest stall): where the extension host's thread was, by self time**`, '');
    lines.push('| Function | Self | Share |', '| --- | ---: | ---: |');
    for (const h of worst.hot) lines.push(`| \`${h.fn}\` | ${h.ms} ms | ${(h.share * 100).toFixed(1)}% |`);
  }
  const text = lines.join('\n') + '\n';
  writeFileSync(path.join(outDir, 'report.md'), text);
  return text;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.build) execFileSync('npm', ['run', 'package'], { cwd: REPO, stdio: 'inherit', shell: true });
  const vsix = path.resolve(args.vsix ?? newestVsix());
  const outDir = path.resolve(
    args.out ?? path.join(REPO, '.vsix-smoke', new Date().toISOString().replace(/[:.]/g, '-')),
  );
  mkdirSync(outDir, { recursive: true });
  const vscodeExe = await downloadAndUnzipVSCode({
    version: VSCODE_VERSION,
    cachePath: path.join(REPO, '.vscode-test'),
  });
  const cli = resolveCliPathFromVSCodeExecutablePath(vscodeExe);

  const runs = [];
  for (let n = 1; n <= args.runs; n++) {
    console.log(`[vsix-smoke] run ${n}/${args.runs}…`);
    const r = await runOnce(n, { vscodeExe, cli, vsix, outDir, timeoutS: args.timeoutS, port: args.port });
    console.log(`[vsix-smoke] run ${n}: ${r.failures.length ? `FAIL (${r.failures.length})` : 'pass'}`);
    runs.push(r);
  }
  console.log(report(runs, { vsix, outDir }));
  console.log(`[vsix-smoke] evidence in ${outDir}`);
  if (runs.some((r) => r.failures.length)) process.exit(1);
}

main().catch((err) => {
  console.error(`[vsix-smoke] ${err?.stack ?? err}`);
  process.exit(2);
});
