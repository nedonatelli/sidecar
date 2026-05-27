import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { languages, workspace } from 'vscode';

import { DriftDiagnostics } from './driftDiagnostics.js';
import type { DepResult, DepVulnerability, ManifestScanResult } from './types.js';

// DiagnosticSeverity values from the vscode mock enum
const SEV_ERROR = 0;
const SEV_WARNING = 1;
const SEV_INFORMATION = 2;

function makeVuln(severity: DepVulnerability['severity'], id = 'CVE-2024-001'): DepVulnerability {
  return { id, severity, summary: 'test vuln', aliases: [] };
}

function makeDep(overrides: Partial<DepResult> = {}): DepResult {
  return {
    name: 'lodash',
    ecosystem: 'npm',
    specifiedVersion: '^4.0.0',
    currentVersion: '4.0.0',
    latestVersion: '4.0.0',
    isOutdated: false,
    vulnerabilities: [],
    dev: false,
    ...overrides,
  };
}

function makeResult(overrides: Partial<ManifestScanResult> = {}): ManifestScanResult {
  return {
    manifestPath: '/workspace/package.json',
    ecosystem: 'npm',
    deps: [],
    ...overrides,
  };
}

function makeMockCollection() {
  const store = new Map<string, { message: string; severity: number; source?: string; code?: unknown }[]>();
  return {
    set: vi.fn((uri: { fsPath: string }, diags: typeof store extends Map<string, infer V> ? V : never[]) =>
      store.set(uri.fsPath, diags as never),
    ),
    get: (key: string) => store.get(key),
    has: (key: string) => store.has(key),
    delete: vi.fn((uri: { fsPath: string }) => store.delete(uri.fsPath)),
    clear: vi.fn(() => store.clear()),
    dispose: vi.fn(),
    name: 'sidecar-deps',
  };
}

describe('DriftDiagnostics', () => {
  let collection: ReturnType<typeof makeMockCollection>;
  let dd: DriftDiagnostics;
  const scanFn = vi.fn();

  beforeEach(() => {
    collection = makeMockCollection();
    vi.spyOn(languages, 'createDiagnosticCollection').mockReturnValue(collection as never);
    dd = new DriftDiagnostics(scanFn);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    scanFn.mockReset();
  });

  // ── report() ─────────────────────────────────────────────────────────────

  describe('report — error results', () => {
    it('sets a single Warning diagnostic when result.error is set', () => {
      dd.report(makeResult({ error: 'network timeout' }));

      expect(collection.set).toHaveBeenCalledOnce();
      const diags = collection.get('/workspace/package.json')!;
      expect(diags).toHaveLength(1);
      expect(diags[0].severity).toBe(SEV_WARNING);
      expect(diags[0].message).toContain('network timeout');
      expect(diags[0].source).toBe('sidecar-deps');
    });
  });

  describe('report — no actionable deps', () => {
    it('deletes the uri when all deps are current and have no vulns', () => {
      dd.report(makeResult({ deps: [makeDep()] }));

      expect(collection.delete).toHaveBeenCalledOnce();
      expect(collection.set).not.toHaveBeenCalled();
    });

    it('deletes the uri when deps array is empty', () => {
      dd.report(makeResult({ deps: [] }));

      expect(collection.delete).toHaveBeenCalledOnce();
    });
  });

  describe('report — outdated deps', () => {
    it('sets a diagnostic for an outdated dep with correct message', () => {
      const dep = makeDep({ isOutdated: true, latestVersion: '5.0.0' });
      dd.report(makeResult({ deps: [dep] }));

      const diags = collection.get('/workspace/package.json')!;
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain('lodash');
      expect(diags[0].message).toContain('4.0.0');
      expect(diags[0].message).toContain('5.0.0');
    });

    it('sets dep.name as diagnostic.code', () => {
      dd.report(makeResult({ deps: [makeDep({ isOutdated: true, latestVersion: '5.0.0', name: 'axios' })] }));

      const diags = collection.get('/workspace/package.json')!;
      expect(diags[0].code).toBe('axios');
    });

    it('sets source to "sidecar-deps" on actionable diagnostics', () => {
      dd.report(makeResult({ deps: [makeDep({ isOutdated: true, latestVersion: '5.0.0' })] }));

      const diags = collection.get('/workspace/package.json')!;
      expect(diags[0].source).toBe('sidecar-deps');
    });

    it('produces one diagnostic per actionable dep', () => {
      const deps = [
        makeDep({ name: 'a', isOutdated: true, latestVersion: '2.0.0' }),
        makeDep({ name: 'b', isOutdated: true, latestVersion: '3.0.0' }),
        makeDep({ name: 'c' }), // not actionable
      ];
      dd.report(makeResult({ deps }));

      expect(collection.get('/workspace/package.json')).toHaveLength(2);
    });
  });

  // ── depSeverity ───────────────────────────────────────────────────────────

  describe('depSeverity — via report()', () => {
    function severityOf(dep: DepResult): number {
      dd.report(makeResult({ deps: [dep] }));
      const diags = collection.get('/workspace/package.json')!;
      return diags[0].severity;
    }

    it('Information for an outdated dep with no vulnerabilities', () => {
      expect(severityOf(makeDep({ isOutdated: true, latestVersion: '5.0.0' }))).toBe(SEV_INFORMATION);
    });

    it('Information for UNKNOWN severity vulnerability', () => {
      expect(severityOf(makeDep({ isOutdated: true, vulnerabilities: [makeVuln('UNKNOWN')] }))).toBe(SEV_INFORMATION);
    });

    it('Information for LOW severity vulnerability', () => {
      expect(severityOf(makeDep({ isOutdated: true, vulnerabilities: [makeVuln('LOW')] }))).toBe(SEV_INFORMATION);
    });

    it('Warning for MEDIUM severity vulnerability', () => {
      expect(severityOf(makeDep({ isOutdated: true, vulnerabilities: [makeVuln('MEDIUM')] }))).toBe(SEV_WARNING);
    });

    it('Warning for HIGH severity vulnerability', () => {
      expect(severityOf(makeDep({ isOutdated: true, vulnerabilities: [makeVuln('HIGH')] }))).toBe(SEV_WARNING);
    });

    it('Error for CRITICAL severity vulnerability', () => {
      expect(severityOf(makeDep({ isOutdated: true, vulnerabilities: [makeVuln('CRITICAL')] }))).toBe(SEV_ERROR);
    });

    it('uses the worst severity across multiple vulnerabilities (LOW + CRITICAL → Error)', () => {
      expect(
        severityOf(
          makeDep({
            isOutdated: true,
            vulnerabilities: [makeVuln('LOW', 'CVE-A'), makeVuln('CRITICAL', 'CVE-B')],
          }),
        ),
      ).toBe(SEV_ERROR);
    });

    it('HIGH + MEDIUM → Warning (both map to Warning)', () => {
      expect(
        severityOf(
          makeDep({
            isOutdated: true,
            vulnerabilities: [makeVuln('HIGH', 'CVE-C'), makeVuln('MEDIUM', 'CVE-D')],
          }),
        ),
      ).toBe(SEV_WARNING);
    });
  });

  // ── buildMessage ──────────────────────────────────────────────────────────

  describe('buildMessage — via report()', () => {
    function messageOf(dep: DepResult): string {
      dd.report(makeResult({ deps: [dep] }));
      return collection.get('/workspace/package.json')![0].message;
    }

    it('singular "vulnerability" for exactly one vuln', () => {
      const msg = messageOf(makeDep({ isOutdated: true, vulnerabilities: [makeVuln('HIGH')] }));
      expect(msg).toContain('1 vulnerability:');
      expect(msg).not.toContain('1 vulnerabilities');
    });

    it('plural "vulnerabilities" for two or more vulns', () => {
      const msg = messageOf(
        makeDep({ isOutdated: true, vulnerabilities: [makeVuln('HIGH', 'CVE-1'), makeVuln('LOW', 'CVE-2')] }),
      );
      expect(msg).toContain('2 vulnerabilities:');
    });

    it('includes all vulnerability IDs in the message', () => {
      const msg = messageOf(
        makeDep({ isOutdated: true, vulnerabilities: [makeVuln('HIGH', 'CVE-111'), makeVuln('LOW', 'CVE-222')] }),
      );
      expect(msg).toContain('CVE-111');
      expect(msg).toContain('CVE-222');
    });

    it('joins outdated and vulnerability parts with " · "', () => {
      const msg = messageOf(makeDep({ isOutdated: true, latestVersion: '5.0.0', vulnerabilities: [makeVuln('HIGH')] }));
      expect(msg).toContain(' · ');
      expect(msg).toMatch(/4\.0\.0.*5\.0\.0/);
    });

    it('shows only the vulnerability part when dep is not outdated', () => {
      const msg = messageOf(makeDep({ isOutdated: false, vulnerabilities: [makeVuln('HIGH')] }));
      expect(msg).toContain('vulnerability');
      expect(msg).not.toContain('→');
    });
  });

  // ── scanAndReport ─────────────────────────────────────────────────────────

  describe('scanAndReport', () => {
    it('calls report() when scanFn resolves with a result', async () => {
      const result = makeResult({ deps: [makeDep({ isOutdated: true, latestVersion: '5.0.0' })] });
      scanFn.mockResolvedValue(result);

      await dd.scanAndReport('/workspace/package.json');

      expect(collection.set).toHaveBeenCalledOnce();
    });

    it('does not call report() when scanFn resolves with undefined', async () => {
      scanFn.mockResolvedValue(undefined);

      await dd.scanAndReport('/workspace/package.json');

      expect(collection.set).not.toHaveBeenCalled();
      expect(collection.delete).not.toHaveBeenCalled();
    });

    it('passes the manifestPath to scanFn', async () => {
      scanFn.mockResolvedValue(undefined);

      await dd.scanAndReport('/project/Cargo.toml');

      expect(scanFn).toHaveBeenCalledWith('/project/Cargo.toml');
    });
  });

  // ── dispose ───────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('disposes the diagnostic collection', () => {
      dd.dispose();
      expect(collection.dispose).toHaveBeenCalledOnce();
    });
  });

  // ── watch ─────────────────────────────────────────────────────────────────

  describe('watch', () => {
    it('creates file watchers — one per manifest glob per workspace folder', () => {
      vi.spyOn(workspace, 'createFileSystemWatcher').mockReturnValue({
        onDidChange: () => ({ dispose: vi.fn() }),
        onDidCreate: () => ({ dispose: vi.fn() }),
        onDidDelete: () => ({ dispose: vi.fn() }),
        dispose: vi.fn(),
      } as never);

      dd.watch();

      // 4 globs × 1 workspace folder (mock has 1 folder at /mock-workspace)
      expect(workspace.createFileSystemWatcher).toHaveBeenCalledTimes(4);
    });

    it('fires scheduleScan when onDidChange triggers for a non-excluded path', async () => {
      let changeCallback: ((uri: { fsPath: string }) => void) | undefined;

      vi.spyOn(workspace, 'createFileSystemWatcher').mockReturnValue({
        onDidChange: (cb: (uri: { fsPath: string }) => void) => {
          changeCallback = cb;
          return { dispose: vi.fn() };
        },
        onDidCreate: () => ({ dispose: vi.fn() }),
        onDidDelete: () => ({ dispose: vi.fn() }),
        dispose: vi.fn(),
      } as never);

      scanFn.mockResolvedValue(undefined);
      dd.watch();

      // Trigger the change callback with a valid path
      vi.useFakeTimers();
      changeCallback!({ fsPath: '/workspace/package.json' });
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      expect(scanFn).toHaveBeenCalledWith('/workspace/package.json');
    });

    it('does not scan paths inside excluded directories (node_modules)', async () => {
      let changeCallback: ((uri: { fsPath: string }) => void) | undefined;

      vi.spyOn(workspace, 'createFileSystemWatcher').mockReturnValue({
        onDidChange: (cb: (uri: { fsPath: string }) => void) => {
          changeCallback = cb;
          return { dispose: vi.fn() };
        },
        onDidCreate: () => ({ dispose: vi.fn() }),
        onDidDelete: () => ({ dispose: vi.fn() }),
        dispose: vi.fn(),
      } as never);

      dd.watch();

      vi.useFakeTimers();
      changeCallback!({ fsPath: '/workspace/node_modules/some-pkg/package.json' });
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      expect(scanFn).not.toHaveBeenCalled();
    });
  });
});
