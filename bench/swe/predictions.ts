// ---------------------------------------------------------------------------
// Official `swebench` prediction emission + resolved-report parsing.
//
// The handoff to the official harness: we write one predictions JSONL per arm in
// the exact shape `swebench` expects, run the harness (Docker) on each, then read
// back its resolved-instances report to compute the ablation. We never run the
// repo tests ourselves.
// ---------------------------------------------------------------------------

import type { ArmName, OfficialPrediction, SwePrediction } from './types.js';

/**
 * Render predictions for one arm as official `swebench` JSONL. The model name is
 * suffixed with the arm so the two harness runs don't collide in its cache and
 * the resolved reports are clearly attributable.
 */
export function toPredictionsJsonl(predictions: SwePrediction[], modelName: string, arm: ArmName): string {
  return (
    predictions
      .filter((p) => p.arm === arm)
      .map((p) => {
        const line: OfficialPrediction = {
          instance_id: p.instance_id,
          model_name_or_path: `${modelName}__${arm}`,
          model_patch: p.model_patch,
        };
        return JSON.stringify(line);
      })
      .join('\n') + '\n'
  );
}

/**
 * Extract the set of resolved instance_ids from the official harness's report.
 * `swebench` writes a `<run_id>.<model>.json` summary with a `resolved_ids`
 * array; older/looser shapes use a per-instance map with `{ resolved: true }`.
 * Both are handled so the parser survives harness-version drift.
 */
export function parseResolvedReport(reportJson: string): Set<string> {
  const data = JSON.parse(reportJson) as {
    resolved_ids?: string[];
    resolved?: string[];
    results?: Record<string, { resolved?: boolean }>;
  };
  if (Array.isArray(data.resolved_ids)) return new Set(data.resolved_ids);
  if (Array.isArray(data.resolved)) return new Set(data.resolved);
  if (data.results) {
    return new Set(
      Object.entries(data.results)
        .filter(([, v]) => v.resolved)
        .map(([k]) => k),
    );
  }
  return new Set();
}
