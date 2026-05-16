export type DepEcosystem = 'npm' | 'pypi' | 'cargo' | 'go';

export interface ParsedDep {
  name: string;
  specifiedVersion: string;
  ecosystem: DepEcosystem;
  dev: boolean;
}

export interface DepVulnerability {
  id: string;
  summary: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  aliases: string[];
}

export interface DepResult {
  name: string;
  ecosystem: DepEcosystem;
  specifiedVersion: string;
  currentVersion: string;
  latestVersion: string;
  isOutdated: boolean;
  vulnerabilities: DepVulnerability[];
  dev: boolean;
}

export interface ManifestScanResult {
  manifestPath: string;
  ecosystem: DepEcosystem;
  deps: DepResult[];
  error?: string;
}
