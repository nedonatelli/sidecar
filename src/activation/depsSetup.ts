import { commands, workspace, RelativePattern, type ExtensionContext } from 'vscode';
import { getConfig } from '../config/settings.js';
import { DriftScanner } from '../deps/driftScanner.js';
import { DriftDiagnostics } from '../deps/driftDiagnostics.js';
import type { ManifestScanResult } from '../deps/types.js';

const MANIFEST_GLOBS = ['**/package.json', '**/requirements*.txt', '**/Cargo.toml', '**/go.mod'];
const SKIP_PATTERN = '{**/node_modules/**,**/.git/**,**/vendor/**,**/dist/**,**/build/**}';

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

  async function scanManifest(manifestPath: string): Promise<ManifestScanResult | undefined> {
    const results = await scanner.scan([manifestPath], {
      checkVulnerabilities: cfg.depsCheckVulnerabilities,
    });
    return results[0];
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

      for (const m of manifests) {
        await diagnostics.scanAndReport(m);
      }
    }),
  );

  // Initial workspace scan (fire-and-forget, errors are non-fatal)
  void commands.executeCommand('sidecar.deps.scan').then(undefined, (err: unknown) => {
    console.warn('[SideCar deps] Initial scan failed:', err);
  });
}
