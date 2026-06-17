import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workspace } from 'vscode';
import type { ManifestScanResult } from '../../deps/types.js';

// Control DriftScanner.scan via a hoisted handle so the module-level
// `new DriftScanner()` in deps.ts uses our fake.
const h = vi.hoisted(() => ({ scan: vi.fn() }));
vi.mock('../../deps/driftScanner.js', () => ({
  DriftScanner: vi.fn(function () {
    return { scan: h.scan };
  }),
}));

import { depsTools } from './deps.js';

const checkDependencies = depsTools[0].executor;

function uri(fsPath: string) {
  return { fsPath } as never;
}

beforeEach(() => {
  vi.restoreAllMocks();
  h.scan.mockReset();
});

describe('check_dependencies', () => {
  it('reports when no manifests are found', async () => {
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([]);
    const out = await checkDependencies({});
    expect(out).toContain('No manifest files found');
    expect(h.scan).not.toHaveBeenCalled();
  });

  it('formats outdated, vulnerable, and clean dependency counts', async () => {
    vi.spyOn(workspace, 'findFiles').mockImplementation(async (pattern: unknown) =>
      String(pattern).includes('package.json') ? [uri('/mock-workspace/package.json')] : [],
    );
    const result: ManifestScanResult = {
      manifestPath: 'package.json',
      ecosystem: 'npm',
      deps: [
        {
          name: 'lodash',
          ecosystem: 'npm',
          specifiedVersion: '^4.17.20',
          currentVersion: '4.17.20',
          latestVersion: '4.17.21',
          isOutdated: true,
          dev: false,
          vulnerabilities: [
            { id: 'GHSA-xxxx', summary: 'Prototype pollution', severity: 'HIGH', aliases: ['CVE-2020-8203'] },
          ],
        },
        {
          name: 'typescript',
          ecosystem: 'npm',
          specifiedVersion: '5.0.0',
          currentVersion: '5.0.0',
          latestVersion: '5.4.0',
          isOutdated: true,
          dev: true,
          vulnerabilities: [],
        },
        {
          name: 'react',
          ecosystem: 'npm',
          specifiedVersion: '18.2.0',
          currentVersion: '18.2.0',
          latestVersion: '18.2.0',
          isOutdated: false,
          dev: false,
          vulnerabilities: [],
        },
      ],
    };
    h.scan.mockResolvedValue([result]);

    const out = await checkDependencies({});
    expect(out).toContain('package.json (npm)');
    expect(out).toContain('3 deps scanned · 2 outdated · 1 with vulnerabilities · 1 clean');
    expect(out).toContain('🔴 lodash@4.17.20 — VULNERABLE: GHSA-xxxx (HIGH)');
    expect(out).toContain('Prototype pollution');
    expect(out).toContain('🟡 typescript [dev]: 5.0.0 → 5.4.0');
    // A clean, non-outdated dep should not get its own line.
    expect(out).not.toContain('🟡 react');
  });

  it('passes the ecosystem filter through to manifest discovery and scan opts', async () => {
    const findFiles = vi
      .spyOn(workspace, 'findFiles')
      .mockImplementation(async (pattern: unknown) =>
        String(pattern).includes('package.json') ? [uri('/mock-workspace/package.json')] : [],
      );
    h.scan.mockResolvedValue([]);

    await checkDependencies({ ecosystem: 'npm', checkVulnerabilities: false });

    expect(findFiles).toHaveBeenCalled();
    // checkVulnerabilities:false must reach the scanner.
    expect(h.scan).toHaveBeenCalledWith(expect.any(Array), { checkVulnerabilities: false });
  });

  it('surfaces a per-manifest scan error in the report', async () => {
    vi.spyOn(workspace, 'findFiles').mockImplementation(async (pattern: unknown) =>
      String(pattern).includes('package.json') ? [uri('/mock-workspace/package.json')] : [],
    );
    h.scan.mockResolvedValue([{ manifestPath: 'package.json', ecosystem: 'npm', deps: [], error: 'parse failed' }]);
    const out = await checkDependencies({});
    expect(out).toContain('Error: parse failed');
  });
});
