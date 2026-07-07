#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Fetch a SWE-bench split from the HuggingFace datasets-server and write a
// deterministic, reproducible slice as JSONL (the raw rows — bench/swe/loader.ts
// normalizes FAIL_TO_PASS / PASS_TO_PASS at load time).
//
// Standalone (no build step, global fetch) so it runs on a fresh cloud box.
//
//   node bench/swe/cloud/fetch_dataset.mjs \
//     --dataset SWE-bench_Lite --n 50 --stride auto --out /tmp/swe_slice.jsonl
//
// Deterministic: rows are sorted by instance_id, then sampled by a fixed stride
// (default: floor(total / n)) so the slice is proportionally representative of
// the repo mix AND identical on every machine — the reproducibility envelope
// requires this. Use --stride 1 for the first-N contiguous slice instead.
// ---------------------------------------------------------------------------

import fs from 'node:fs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const DATASET = arg('dataset', 'SWE-bench_Lite'); // or SWE-bench_Verified
const N = parseInt(arg('n', '50'), 10);
const STRIDE_ARG = arg('stride', 'auto');
const OUT = arg('out', '/tmp/swe_slice.jsonl');
const CONFIG = arg('config', 'default');
const SPLIT = arg('split', 'test');

const base = `https://datasets-server.huggingface.co/rows?dataset=princeton-nlp/${DATASET}&config=${CONFIG}&split=${SPLIT}`;

async function fetchAll() {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const res = await fetch(`${base}&offset=${offset}&length=100`);
    if (!res.ok) throw new Error(`datasets-server ${res.status} at offset ${offset}`);
    const data = await res.json();
    const batch = (data.rows ?? []).map((x) => x.row);
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
}

const all = await fetchAll();
all.sort((a, b) => (a.instance_id < b.instance_id ? -1 : a.instance_id > b.instance_id ? 1 : 0));

const stride = STRIDE_ARG === 'auto' ? Math.max(1, Math.floor(all.length / N)) : parseInt(STRIDE_ARG, 10);
const slice = [];
for (let i = 0; i < all.length && slice.length < N; i += stride) slice.push(all[i]);

fs.writeFileSync(OUT, slice.map((r) => JSON.stringify(r)).join('\n') + '\n');

const byRepo = {};
for (const r of slice) byRepo[r.repo] = (byRepo[r.repo] ?? 0) + 1;
console.error(`[fetch] ${DATASET}: ${all.length} tasks → slice of ${slice.length} (stride ${stride}) → ${OUT}`);
console.error(`[fetch] repos: ${Object.entries(byRepo).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', ')}`);
