// ---------------------------------------------------------------------------
// Can semantic retrieval identify WHICH TESTS cover a change?
//
// The question behind it: `run_tests` with no scope runs a whole suite, and a
// path-derived scope is not available — measured on this canary, the true test
// module contains the modified file's basename only 45% of the time, and 15% of
// tasks share no name component at all (django/conf/global_settings.py is
// covered by test_utils.tests). Worse, a wrong scope reads as success: django
// answers `Ran 0 tests ... OK`.
//
// So before building a retrieval-scoped run_tests, measure whether retrieval
// actually surfaces the right test file. Three query strategies, because the
// query is the whole design decision:
//
//   issue   — the problem statement (what the agent already retrieves with)
//   source  — the modified file paths + their symbol names
//   both    — concatenated
//
// Ground truth is the FAIL_TO_PASS module, reduced to its leading path segment
// (`test_utils.tests.OverrideSettingsTests` -> `test_utils`), and a hit is any
// retrieved path under a tests/ directory containing that segment. That is
// deliberately GENEROUS: it answers "did retrieval point at the right test
// AREA", which is the best case for the design. If the generous number is low,
// the strict one cannot be better.
//
//   SIDECAR_SWE_DATA=<canary.jsonl> SIDECAR_SWE_REPO_CACHE=<dir> \
//   npx vitest run --config vitest.eval.config.ts tests/llm-eval/testRetrievalRecall.eval.ts
// ---------------------------------------------------------------------------

import { describe, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseTasks } from '../../bench/swe/loader.js';
import { loadOrBuildRepoIndex, retrieveContext } from '../../bench/swe/rag.js';
import { stableCloneDir } from '../../bench/swe/clonePath.js';
import { execFileSync } from 'node:child_process';
import type { SymbolEmbeddingIndex } from '../../src/config/symbolEmbeddingIndex.js';

const DATA = process.env.SIDECAR_SWE_DATA;
const TOPK = parseInt(process.env.SIDECAR_TESTRAG_TOPK ?? '10', 10);
const OUT = process.env.SIDECAR_TESTRAG_OUT ?? path.join(os.tmpdir(), 'test-retrieval-recall.json');

/** FAIL_TO_PASS entries -> the leading segment of each test module. */
function truthSegments(f2pRaw: unknown): string[] {
  let f2p: string[] = [];
  if (Array.isArray(f2pRaw)) f2p = f2pRaw as string[];
  else if (typeof f2pRaw === 'string') {
    try {
      f2p = JSON.parse(f2pRaw);
    } catch {
      f2p = [f2pRaw];
    }
  }
  const segs = new Set<string>();
  for (const entry of f2p) {
    const paren = /\(([\w.]+)\)/.exec(entry);
    if (paren) {
      const first = paren[1].split('.')[0];
      if (first) segs.add(first);
      continue;
    }
    const filePath = /([\w/]+\.py)/.exec(entry);
    if (filePath) {
      const base = path.basename(filePath[1], '.py');
      segs.add(base);
    }
  }
  return [...segs];
}

const isTestPath = (p: string) => /(^|\/)tests?\//.test(p) || /(^|\/)test_[^/]*\.py$/.test(p) || /_test\.py$/.test(p);

describe('which tests cover a change — retrieval feasibility', () => {
  it.skipIf(!DATA)(
    'measures test-file recall@k for three query strategies',
    async () => {
      const tasks = parseTasks(fs.readFileSync(DATA as string, 'utf-8'));
      const rows: Record<string, unknown>[] = [];
      const indexes = new Map<string, SymbolEmbeddingIndex>();
      const skipped = { noTruth: 0, noSrc: 0, noClone: 0 };

      for (const task of tasks) {
        // parseTasks normalises FAIL_TO_PASS -> fail_to_pass; reading the raw
        // uppercase key off the PARSED object silently yields nothing.
        const segs = truthSegments(task.fail_to_pass);
        const goldFiles = [...((task.patch ?? '').match(/^\+\+\+ b\/(.+)$/gm) ?? [])].map((l) =>
          l.replace(/^\+\+\+ b\//, '').trim(),
        );
        const srcFiles = goldFiles.filter((f) => f.endsWith('.py') && !isTestPath(f));
        if (segs.length === 0) {
          skipped.noTruth++;
          continue;
        }
        if (srcFiles.length === 0) {
          skipped.noSrc++;
          continue;
        }

        const dir = stableCloneDir(os.tmpdir(), task.repo);
        if (!fs.existsSync(dir)) {
          skipped.noClone++;
          continue;
        }

        // One index per repo, built once and cached on disk with the same key
        // scheme the harness uses, so a later retrieval run reloads instead of
        // paying the ~5-8min MiniLM build again.
        let index = indexes.get(task.repo);
        if (!index) {
          try {
            const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' })
              .trim()
              .slice(0, 12);
            const prefix = path.join(os.tmpdir(), 'rag-cache', `${task.repo.replace(/[/\\]/g, '_')}_${commit}_full`);
            console.log(`[testrag] building/loading index for ${task.repo} @ ${commit}`);
            index = await loadOrBuildRepoIndex(dir, prefix);
            indexes.set(task.repo, index);
          } catch (err) {
            console.log(`[testrag] SKIP ${task.repo}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }

        const queries: Record<string, string> = {
          issue: task.problem_statement.slice(0, 2000),
          source: srcFiles.map((f) => `${f} ${path.basename(f, '.py')}`).join('\n'),
          both: `${task.problem_statement.slice(0, 1200)}\n${srcFiles.join('\n')}`,
        };

        const row: Record<string, unknown> = { instance_id: task.instance_id, segs, srcFiles };
        for (const [name, query] of Object.entries(queries)) {
          // cliffGate off: this measures RECALL of the full top-k, not what a
          // gate would choose to inject.
          const { hits } = await retrieveContext(index, query, dir, TOPK, false);
          const testHits = hits.map((h) => h.filePath).filter(isTestPath);
          const hit = testHits.some((p) => segs.some((s) => p.includes(s)));
          row[`${name}_hit`] = hit;
          row[`${name}_testHits`] = testHits.length;
          row[`${name}_top`] = hits.slice(0, 3).map((h) => h.filePath);
        }
        rows.push(row);
        const flags = ['issue', 'source', 'both'].map((k) => `${k}=${row[`${k}_hit`] ? 'Y' : 'n'}`).join(' ');
        console.log(`[testrag] ${task.instance_id} ${flags} truth=${segs.join(',')}`);
      }

      fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));
      const n = rows.length;
      const pct = (k: string) => `${Math.round((100 * rows.filter((r) => r[`${k}_hit`]).length) / Math.max(1, n))}%`;
      const anyTest = (k: string) =>
        (rows.reduce((a, r) => a + (r[`${k}_testHits`] as number), 0) / Math.max(1, n)).toFixed(1);
      console.log(`\n[testrag] tasks measured: ${n}   top-k: ${TOPK}`);
      console.log(`[testrag] skipped: ${JSON.stringify(skipped)}`);
      console.log(`[testrag] recall  issue=${pct('issue')}  source=${pct('source')}  both=${pct('both')}`);
      console.log(
        `[testrag] mean test files in top-k  issue=${anyTest('issue')} source=${anyTest('source')} both=${anyTest('both')}`,
      );
      console.log('[testrag] naming-convention baseline on this canary: 45%');
      console.log(`[testrag] rows -> ${OUT}`);
    },
    60 * 60 * 1000,
  );
});
