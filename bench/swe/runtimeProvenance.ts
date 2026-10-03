/**
 * What the model runtime actually was, recorded per run.
 *
 * WHY. On 2026-09-17 the scoped-author hook returned an empty draft on 35% of
 * firings. The obvious suspect was its 700-token output budget — except the A/B
 * that had measured the hook nine days earlier ran the identical constant and
 * saw only 7% empty. Same code, same cap, same model tag, five-fold difference.
 * The variable was Ollama: 0.33.3 during that A/B, 0.34.0 the next week, 0.34.2
 * by the time the discrepancy surfaced. Thinking tokens appear to count against
 * `num_predict` differently across those releases.
 *
 * That cost an afternoon and nearly produced a wrong conclusion — "the cap is
 * what was hurting us" — because nothing in the run record could rule it out.
 * `run.manifest.json` pinned the model tag, temperature, seed, dataset, scaffold
 * version and node version. It did not pin the thing underneath all of them.
 *
 * The model TAG is not the model either. `gemma4:e4b` is a mutable pointer: a
 * re-pull swaps the weights and the tag reads the same. The digest is the
 * identity, so it is recorded alongside the version.
 *
 * Best-effort by construction. A provenance probe must never fail a run, so
 * every field is nullable and a dead endpoint yields nulls rather than a throw —
 * but a null is written to the manifest, so "we do not know" stays visible
 * instead of looking like it was never checked.
 */

/** GET this for the running Ollama's version string. */
export function versionRequest(host: string): { url: string } {
  return { url: `${host.replace(/\/+$/, '')}/api/version` };
}

/** GET this for the installed models, which is where the per-model digest lives. */
export function tagsRequest(host: string): { url: string } {
  return { url: `${host.replace(/\/+$/, '')}/api/tags` };
}

export interface RuntimeProvenance {
  /** e.g. "0.34.2", or null when the endpoint could not be read. */
  ollamaVersion: string | null;
  /** sha256 of the resolved model — the identity the tag only points at. */
  modelDigest: string | null;
  /** Bytes on disk; a cheap second signal that the weights changed. */
  modelSizeBytes: number | null;
  /** When the model was pulled or last modified, as Ollama reports it. */
  modelModifiedAt: string | null;
}

export const UNKNOWN_PROVENANCE: RuntimeProvenance = {
  ollamaVersion: null,
  modelDigest: null,
  modelSizeBytes: null,
  modelModifiedAt: null,
};

/**
 * Fold the two endpoint payloads into the record.
 *
 * Pure and total: any shape that is not what we expect degrades to null for
 * that field. Matching the model is exact on `name` first, then on `model`,
 * because Ollama reports both and older versions populated only one.
 */
export function parseRuntimeProvenance(model: string, versionJson: unknown, tagsJson: unknown): RuntimeProvenance {
  const version = (versionJson as { version?: unknown } | null)?.version;
  const rawModels = (tagsJson as { models?: unknown } | null)?.models;
  const models = Array.isArray(rawModels) ? (rawModels as Record<string, unknown>[]) : [];
  const entry = models.find((m) => m?.name === model) ?? models.find((m) => m?.model === model) ?? undefined;
  return {
    ollamaVersion: typeof version === 'string' && version ? version : null,
    modelDigest: typeof entry?.digest === 'string' && entry.digest ? entry.digest : null,
    modelSizeBytes: typeof entry?.size === 'number' && Number.isFinite(entry.size) ? entry.size : null,
    modelModifiedAt: typeof entry?.modified_at === 'string' && entry.modified_at ? entry.modified_at : null,
  };
}

/** One-line form for a run log, where a JSON blob would be noise. */
export function formatRuntimeProvenance(p: RuntimeProvenance): string {
  const digest = p.modelDigest ? p.modelDigest.slice(0, 12) : 'digest?';
  return `ollama ${p.ollamaVersion ?? 'version?'} model ${digest}`;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/**
 * Probe both endpoints. Never throws, never fails a run.
 *
 * `fetchImpl` is injected so the failure paths — a refused connection, a 500, a
 * body that is not JSON — are unit-testable without a live Ollama. Those paths
 * are the whole point of the module: the one thing it must never do is take a
 * benchmark down on its way to recording a version string.
 */
export async function fetchRuntimeProvenance(
  host: string,
  model: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 5_000,
): Promise<RuntimeProvenance> {
  const get = async (url: string): Promise<unknown> => {
    try {
      const res = await Promise.race([
        fetchImpl(url),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
      ]);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  };
  const [v, t] = await Promise.all([get(versionRequest(host).url), get(tagsRequest(host).url)]);
  return parseRuntimeProvenance(model, v, t);
}
