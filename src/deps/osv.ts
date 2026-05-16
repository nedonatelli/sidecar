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
  // Try CVSS score as fallback
  for (const sev of vuln.severity ?? []) {
    if (sev.score) {
      const score = parseFloat(sev.score);
      if (score >= 9.0) return 'CRITICAL';
      if (score >= 7.0) return 'HIGH';
      if (score >= 4.0) return 'MEDIUM';
      return 'LOW';
    }
  }
  return 'UNKNOWN';
}

/**
 * Batch-query the OSV API for vulnerabilities.
 * Returns one `DepVulnerability[]` per input query, in order.
 * Never throws — returns empty arrays on network failure.
 */
export async function osvBatchQuery(queries: OsvQuery[], signal?: AbortSignal): Promise<DepVulnerability[][]> {
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
    if (!res.ok) return queries.map(() => []);
    const json = (await res.json()) as { results?: Array<{ vulns?: OsvVuln[] }> };
    return (json.results ?? []).map((r) =>
      (r.vulns ?? []).map((v) => ({
        id: v.id ?? 'UNKNOWN',
        summary: v.summary ?? '',
        severity: mapSeverity(v),
        aliases: v.aliases ?? [],
      })),
    );
  } catch {
    return queries.map(() => []);
  }
}
