#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Export a run's trajectories with sensitive values replaced, for a handoff
// from a machine other than this workstation (#294).
//
//   node bench/swe/export_trajectories.mjs --in <run dir> --out <export dir> \
//     [--redact <value>]... [--redact-token <value>]... [--no-user]
//
// Reads every *.jsonl / *.log / *.json under --in (the SWE loop's
// `*.trial*.jsonl` traces and `trajectory.*.log` files, plus run manifests).
// Replaced, with a count per rule in export-manifest.json (never the values):
//   - the backend endpoint from OLLAMA_HOST / OLLAMA_BASE_URL /
//     SIDECAR_EVAL_BASE_URL, and any private URL host with its port;
//   - any IPv4 address;
//   - API keys from the provider env vars, key-shaped tokens, bearer tokens;
//   - this machine's home path, username and git author (name and email),
//     and the username in any /home/…, /Users/…, C:\Users\… path;
//   - each --redact value (e.g. a public DNS name for the endpoint);
//   - each --redact-token value WITH the whole name around it: `--redact-token
//     acme-` removes all of `acme-billing-tests-3f2a`, where --redact would
//     leave `billing-tests-3f2a`. Pass these on the command line, never in a
//     committed file: a list of what is sensitive is itself sensitive;
//   - the Windows short form of the username (`JOHNSM~1`);
//   - every run of three or more `ls -l` entries, whatever it lists.
//
// FAILS CLOSED: after rewriting, a stricter scan looks for anything that still
// looks like a secret. On any hit nothing is written, and the hits are listed
// as file:line and detector, without the value. Add a --redact for it, or
// --no-user when the username is an ordinary word that the repository's own
// text contains (the home-path rule still covers paths).
//
// Standalone (no build step) so it runs on the run machine itself.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planExport } from '../../scripts/lib/sanitizeTrajectories.mjs';

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function args(name) {
  return argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []));
}

const IN = arg('in');
const OUT = arg('out');
if (!IN || !OUT) {
  console.error(
    'usage: node bench/swe/export_trajectories.mjs --in <run dir> --out <export dir> [--redact <value>]... [--redact-token <value>]... [--no-user]',
  );
  process.exit(2);
}
if (!fs.existsSync(IN) || !fs.statSync(IN).isDirectory()) {
  console.error(`--in ${IN} is not a directory`);
  process.exit(2);
}
if (fs.existsSync(OUT) && fs.readdirSync(OUT).length > 0) {
  console.error(`--out ${OUT} exists and is not empty; refusing to mix exports`);
  process.exit(2);
}

function gitConfig(key) {
  try {
    return execFileSync('git', ['config', '--get', key], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** The explicit values this machine knows are sensitive. */
function explicitValues() {
  const e = [];
  for (const k of ['OLLAMA_HOST', 'OLLAMA_BASE_URL', 'SIDECAR_EVAL_BASE_URL']) {
    const v = process.env[k];
    if (!v) continue;
    e.push({ value: v, placeholder: '<host>' });
    // The host alone, so a trace that names it without the scheme or port is caught.
    const host = v.replace(/^[a-z]+:\/\//i, '').replace(/[:/].*$/, '');
    if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0')
      e.push({ value: host, placeholder: '<host>' });
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (/(?:_API_KEY|_TOKEN|BEARER_TOKEN_\w+)$/.test(k) && v && v.length >= 8 && v !== 'ollama')
      e.push({ value: v, placeholder: '<api-key>' });
  }
  e.push({ value: os.homedir(), placeholder: '<home>' });
  if (!argv.includes('--no-user')) e.push({ value: os.userInfo().username, placeholder: '<user>' });
  const name = gitConfig('user.name');
  const email = gitConfig('user.email');
  if (name) e.push({ value: name, placeholder: '<author>' });
  if (email) e.push({ value: email, placeholder: '<email>' });
  for (const v of args('redact')) e.push({ value: v, placeholder: '<redacted>' });
  for (const v of args('redact-token')) e.push({ value: v, placeholder: '<redacted>', token: true });
  return e;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return walk(p);
    return /\.(?:jsonl|log|json)$/.test(d.name) ? [p] : [];
  });
}

const files = walk(IN).map((p) => ({
  // Forward slashes, so the manifest reads the same from any machine.
  path: path.relative(IN, p).split(path.sep).join('/'),
  text: fs.readFileSync(p, 'utf8'),
}));
if (files.length === 0) {
  console.error(`no .jsonl / .log / .json files under ${IN}`);
  process.exit(2);
}

const plan = planExport(files, { explicit: explicitValues() });
if (!plan.ok) {
  console.error(`REFUSING: ${plan.findings.length} value(s) still look sensitive after rewriting; nothing written.`);
  for (const f of plan.findings.slice(0, 50)) console.error(`  ${f.path}:${f.line}  ${f.detector}`);
  if (plan.findings.length > 50) console.error(`  … and ${plan.findings.length - 50} more`);
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
for (const f of plan.files) {
  const dest = path.join(OUT, f.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, f.text, 'utf8');
}
const manifest = {
  generatedBy: 'bench/swe/export_trajectories.mjs',
  source: path.basename(path.resolve(IN)),
  ...plan.manifest,
};
fs.writeFileSync(path.join(OUT, 'export-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`exported ${plan.files.length} file(s) to ${OUT}`);
for (const [rule, n] of Object.entries(plan.manifest.totals)) console.log(`  ${rule}: ${n}`);
