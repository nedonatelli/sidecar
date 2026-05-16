import * as path from 'path';
import type { ToolDefinition } from '../../ollama/types.js';
import type { RegisteredTool } from './shared.js';
import { getRoot } from './shared.js';
import { DriftScanner } from '../../deps/driftScanner.js';
import type { ManifestScanResult } from '../../deps/types.js';
import { workspace } from 'vscode';

const MANIFEST_PATTERNS = ['**/package.json', '**/requirements*.txt', '**/Cargo.toml', '**/go.mod'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '__pycache__']);

async function findManifests(root: string, ecosystemFilter?: string): Promise<string[]> {
  const uris = await Promise.all(
    MANIFEST_PATTERNS.map((p) =>
      workspace.findFiles(p, '{**/node_modules/**,**/.git/**,**/vendor/**,**/dist/**,**/build/**}', 20),
    ),
  );
  return uris
    .flat()
    .map((u) => u.fsPath)
    .filter((p) => {
      // Skip paths containing ignored dirs
      const rel = path.relative(root, p);
      return !rel.split(path.sep).some((seg) => SKIP_DIRS.has(seg));
    })
    .filter((p) => {
      if (!ecosystemFilter) return true;
      const base = path.basename(p);
      if (ecosystemFilter === 'npm') return base === 'package.json';
      if (ecosystemFilter === 'pypi') return base.startsWith('requirements') && base.endsWith('.txt');
      if (ecosystemFilter === 'cargo') return base === 'Cargo.toml';
      if (ecosystemFilter === 'go') return base === 'go.mod';
      return true;
    });
}

function formatResults(results: ManifestScanResult[]): string {
  if (results.length === 0) return 'No manifest files found.';

  const lines: string[] = [];
  for (const result of results) {
    lines.push(`\n## ${result.manifestPath} (${result.ecosystem})`);
    if (result.error) {
      lines.push(`  Error: ${result.error}`);
      continue;
    }

    const outdated = result.deps.filter((d) => d.isOutdated);
    const vulnerable = result.deps.filter((d) => d.vulnerabilities.length > 0);
    const clean = result.deps.filter((d) => !d.isOutdated && d.vulnerabilities.length === 0);

    lines.push(
      `  ${result.deps.length} deps scanned · ${outdated.length} outdated · ${vulnerable.length} with vulnerabilities · ${clean.length} clean`,
    );

    for (const dep of vulnerable) {
      const ids = dep.vulnerabilities.map((v) => `${v.id} (${v.severity})`).join(', ');
      lines.push(`  🔴 ${dep.name}@${dep.currentVersion} — VULNERABLE: ${ids}`);
      for (const v of dep.vulnerabilities) {
        if (v.summary) lines.push(`       ${v.id}: ${v.summary}`);
      }
    }

    for (const dep of outdated.filter((d) => d.vulnerabilities.length === 0)) {
      const devTag = dep.dev ? ' [dev]' : '';
      lines.push(`  🟡 ${dep.name}${devTag}: ${dep.currentVersion} → ${dep.latestVersion}`);
    }
  }

  return lines.join('\n');
}

const checkDependenciesDef: ToolDefinition = {
  name: 'check_dependencies',
  description:
    'Scan package manifests (package.json, requirements.txt, Cargo.toml, go.mod) for outdated dependencies and known vulnerabilities. ' +
    'Returns a structured report grouped by manifest file. Vulnerable packages are flagged with CVE/GHSA IDs and severity. ' +
    'Use before shipping to catch supply-chain issues, or when the user asks "are my deps up to date?" or "any security issues in dependencies?". ' +
    'Optional `ecosystem` filter narrows to a single package manager (npm | pypi | cargo | go). ' +
    'Optional `checkVulnerabilities: false` skips the OSV network call for a faster offline check.',
  input_schema: {
    type: 'object',
    properties: {
      ecosystem: {
        type: 'string',
        enum: ['npm', 'pypi', 'cargo', 'go'],
        description: 'Optional: restrict to a single package manager.',
      },
      checkVulnerabilities: {
        type: 'boolean',
        description: 'Whether to check OSV for known vulnerabilities. Default: true.',
      },
    },
    required: [],
  },
  nondeterministicOutput: true,
};

const scanner = new DriftScanner();

async function checkDependencies(input: Record<string, unknown>): Promise<string> {
  const root = getRoot();
  const ecosystem = input.ecosystem as string | undefined;
  const checkVulns = input.checkVulnerabilities !== false;

  const manifests = await findManifests(root ?? process.cwd(), ecosystem);
  if (manifests.length === 0) {
    return 'No manifest files found in the workspace.';
  }

  const results = await scanner.scan(manifests, { checkVulnerabilities: checkVulns });
  return formatResults(results);
}

export const depsTools: RegisteredTool[] = [
  { definition: checkDependenciesDef, executor: checkDependencies, requiresApproval: false },
];
