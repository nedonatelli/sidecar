import type { DepEcosystem, DepVulnerability } from './types.js';

const OSV_ECOSYSTEM_MAP: Record<DepEcosystem, string> = {
  npm: 'npm',
  pypi: 'PyPI',
  cargo: 'crates.io',
  go: 'Go',
};

export interface OsvQuery {
  name: string;
  version: string;
  ecosystem: DepEcosystem;
}

interface OsvVuln {
  id?: string;
  summary?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
  severity?: Array<{ type?: string; score?: string }>;
}

function mapSeverity(vuln: OsvVuln): DepVulnerability['severity'] {
  const s = vuln.database_specific?.severity?.toUpperCase();
  if (s === 'CRITICAL') return 'CRITICAL';
  if (s === 'HIGH') return 'HIGH';
  if (s === 'MEDIUM' || s === 'MODERATE') return 'MEDIUM';
  if (s === 'LOW') return 'LOW';
  // Try a numeric CVSS score as fallback. OSV usually gives the CVSS VECTOR
  // here ("CVSS:3.1/AV:N/..."): parseFloat of that is NaN, which fell through
  // every comparison to 'LOW'. A non-numeric score says nothing; skip it.
  for (const sev of vuln.severity ?? []) {
    if (sev.score) {
      const score = Number(sev.score);
      if (!Number.isFinite(score)) continue;
      if (score >= 9.0) return 'CRITICAL';
      if (score >= 7.0) return 'HIGH';
      if (score >= 4.0) return 'MEDIUM';
      return 'LOW';
    }
  }
  return 'UNKNOWN';
}

const MAX_DETAIL_FETCHES = 100;
const DETAIL_CONCURRENCY = 6;

/** True when a vuln record carries something to grade severity from. */
const hasSeverityInfo = (v: OsvVuln): boolean => !!v.database_specific?.severity || (v.severity?.length ?? 0) > 0;

/**
 * Full records for vulns the batch response returned bare. /v1/querybatch
 * answers with ids only (plus `modified`), so every finding used to read
 * severity UNKNOWN with no summary. Fetches /v1/vulns/{id} for each, a few at
 * a time and capped; one that fails or doesn't match keeps its bare record.
 */
async function fetchVulnDetails(ids: string[], signal?: AbortSignal): Promise<Map<string, OsvVuln>> {
  const out = new Map<string, OsvVuln>();
  const queue = ids.slice(0, MAX_DETAIL_FETCHES);
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        const res = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, { signal });
        if (!res.ok) continue;
        const v = (await res.json()) as OsvVuln;
        if (v?.id === id) out.set(id, v);
      } catch {
        if (signal?.aborted) return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, queue.length) }, worker));
  return out;
}

/**
 * Batch-query the OSV API for vulnerabilities.
 * Returns one `DepVulnerability[]` per input query, in order, or null when
 * the lookup itself failed. A failure used to come back as empty arrays —
 * "no vulnerabilities" — and a scan that timed out was cached as clean.
 * Never throws.
 */
export async function osvBatchQuery(queries: OsvQuery[], signal?: AbortSignal): Promise<DepVulnerability[][] | null> {
  if (queries.length === 0) return [];

  const body = {
    queries: queries.map((q) => ({
      version: q.version,
      package: { name: q.name, ecosystem: OSV_ECOSYSTEM_MAP[q.ecosystem] },
    })),
  };

  try {
    const res = await fetch('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { results?: Array<{ vulns?: OsvVuln[] }> };
    const bare = [
      ...new Set(
        (json.results ?? []).flatMap((r) =>
          (r.vulns ?? []).filter((v) => v.id && !hasSeverityInfo(v)).map((v) => v.id!),
        ),
      ),
    ];
    const details = bare.length > 0 ? await fetchVulnDetails(bare, signal) : new Map<string, OsvVuln>();
    return (json.results ?? []).map((r) =>
      (r.vulns ?? []).map((batch) => {
        const v = (batch.id && details.get(batch.id)) || batch;
        return {
          id: v.id ?? 'UNKNOWN',
          summary: v.summary ?? '',
          severity: mapSeverity(v),
          aliases: v.aliases ?? [],
        };
      }),
    );
  } catch {
    return null;
  }
}
