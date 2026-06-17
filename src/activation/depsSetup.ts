import * as fs from 'fs/promises';
import { logger } from '../system/logger.js';
import { commands, workspace, RelativePattern, type ExtensionContext } from 'vscode';
import { getConfig } from '../config/settings.js';
import { DriftScanner } from '../deps/driftScanner.js';
import { DriftDiagnostics } from '../deps/driftDiagnostics.js';
import type { ManifestScanResult } from '../deps/types.js';

const MANIFEST_GLOBS = ['**/package.json', '**/requirements*.txt', '**/Cargo.toml', '**/go.mod'];
const SKIP_PATTERN = '{**/node_modules/**,**/.git/**,**/vendor/**,**/dist/**,**/build/**,**/.vscode-test/**,**/out/**}';
const SCAN_CACHE_KEY = 'sidecar.deps.scanCache';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — matches DriftScanner's in-memory TTL

interface ManifestCacheEntry {
  mtimeMs: number;
  scannedAt: number;
  result: ManifestScanResult;
}

/**
 * Register the Dependency Drift feature:
 * - Creates a DriftScanner + DriftDiagnostics instance
 * - Sets up file watchers so the Problems panel updates on manifest save
 * - Registers `sidecar.deps.scan` to force a full workspace scan on demand
 * - Runs an initial scan at startup
 *
 * Gated by `sidecar.deps.enabled`. When disabled this function is a no-op.
 */
export function registerDepsFeature(context: ExtensionContext): void {
  const cfg = getConfig();
  if (!cfg.depsEnabled) return;

  const scanner = new DriftScanner();

  // Persisted across VS Code restarts via workspaceState. Keyed by manifest
  // path; each entry records the mtime at scan time so we can detect changes.
  const scanCache = context.workspaceState.get<Record<string, ManifestCacheEntry>>(SCAN_CACHE_KEY) ?? {};

  async function scanManifest(manifestPath: string): Promise<ManifestScanResult | undefined> {
    // Stat before scanning — if the file is unchanged and the cached result is
    // still within the TTL, skip all network calls (version fetches + OSV).
    let mtimeMs: number | undefined;
    try {
      const stat = await fs.stat(manifestPath);
      mtimeMs = stat.mtimeMs;
      const entry = scanCache[manifestPath];
      if (entry && entry.mtimeMs === mtimeMs && Date.now() - entry.scannedAt < CACHE_TTL_MS) {
        return entry.result;
      }
    } catch {
      // File not found or stat failed — fall through to scan (which will fail
      // cleanly and record an error result).
    }

    const results = await scanner.scan([manifestPath], {
      checkVulnerabilities: cfg.depsCheckVulnerabilities,
    });
    const result = results[0];
    if (result && mtimeMs !== undefined) {
      scanCache[manifestPath] = { mtimeMs, scannedAt: Date.now(), result };
      void context.workspaceState.update(SCAN_CACHE_KEY, scanCache);
    }
    return result;
  }

  const diagnostics = new DriftDiagnostics(scanManifest);
  diagnostics.watch();
  context.subscriptions.push({ dispose: () => diagnostics.dispose() });

  context.subscriptions.push(
    commands.registerCommand('sidecar.deps.scan', async () => {
      const roots = workspace.workspaceFolders ?? [];
      const uriArrays = await Promise.all(
        roots.flatMap((root) =>
          MANIFEST_GLOBS.map((glob) => workspace.findFiles(new RelativePattern(root, glob), SKIP_PATTERN, 50)),
        ),
      );
      const manifests = [...new Set(uriArrays.flat().map((u) => u.fsPath))];

      // Scan all manifests in parallel — each is an independent network operation.
      await Promise.all(manifests.map((m) => diagnostics.scanAndReport(m)));
    }),
  );

  // Initial workspace scan (fire-and-forget, errors are non-fatal)
  void commands.executeCommand('sidecar.deps.scan').then(undefined, (err: unknown) => {
    logger.warn('[SideCar deps] Initial scan failed:', err);
  });
}
