import {
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range,
  Uri,
  languages,
  workspace,
  type DiagnosticCollection,
  type Disposable,
} from 'vscode';
import type { DepResult, ManifestScanResult } from './types.js';

const MANIFEST_GLOBS = ['**/package.json', '**/requirements*.txt', '**/Cargo.toml', '**/go.mod'];
const EXCLUDE_SEGMENTS = ['node_modules', '.git', 'vendor', 'dist', 'build', '.vscode-test', 'out'];
const DEBOUNCE_MS = 2000;

function depSeverity(dep: DepResult): DiagnosticSeverity {
  const maxVuln = dep.vulnerabilities.reduce<string>((max, v) => {
    const order = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    return order.indexOf(v.severity) > order.indexOf(max) ? v.severity : max;
  }, 'UNKNOWN');
  if (maxVuln === 'CRITICAL') return DiagnosticSeverity.Error;
  if (maxVuln === 'HIGH' || maxVuln === 'MEDIUM') return DiagnosticSeverity.Warning;
  if (maxVuln === 'LOW') return DiagnosticSeverity.Information;
  // No vulns — outdated is just informational
  return DiagnosticSeverity.Information;
}

function buildMessage(dep: DepResult): string {
  const parts: string[] = [];
  if (dep.isOutdated) {
    parts.push(`${dep.name}: ${dep.currentVersion} → ${dep.latestVersion} available`);
  }
  if (dep.vulnerabilities.length > 0) {
    const ids = dep.vulnerabilities.map((v) => v.id).join(', ');
    parts.push(`${dep.vulnerabilities.length} vulnerabilit${dep.vulnerabilities.length === 1 ? 'y' : 'ies'}: ${ids}`);
  }
  return parts.join(' · ');
}

function manifestRange(): Range {
  return new Range(new Position(0, 0), new Position(0, 1000));
}

export type ScanFn = (manifestPath: string) => Promise<ManifestScanResult | undefined>;

export class DriftDiagnostics {
  private readonly collection: DiagnosticCollection;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: Disposable[] = [];

  constructor(private readonly scanFn: ScanFn) {
    this.collection = languages.createDiagnosticCollection('sidecar-deps');
  }

  report(result: ManifestScanResult): void {
    const uri = Uri.file(result.manifestPath);
    if (result.error) {
      const diag = new Diagnostic(manifestRange(), `SideCar deps: ${result.error}`, DiagnosticSeverity.Warning);
      diag.source = 'sidecar-deps';
      this.collection.set(uri, [diag]);
      return;
    }

    const actionable = result.deps.filter((d) => d.isOutdated || d.vulnerabilities.length > 0);
    if (actionable.length === 0) {
      this.collection.delete(uri);
      return;
    }

    const diagnostics = actionable.map((dep) => {
      const diag = new Diagnostic(manifestRange(), buildMessage(dep), depSeverity(dep));
      diag.source = 'sidecar-deps';
      diag.code = dep.name;
      return diag;
    });
    this.collection.set(uri, diagnostics);
  }

  /** Register file watchers for all manifest patterns and scan on save. */
  watch(): void {
    const roots = workspace.workspaceFolders ?? [];
    for (const root of roots) {
      for (const glob of MANIFEST_GLOBS) {
        const watcher = workspace.createFileSystemWatcher(`${root.uri.fsPath}/${glob}`);
        const schedule = (uri: Uri) => {
          const p = uri.fsPath;
          if (EXCLUDE_SEGMENTS.some((seg) => p.includes(`/${seg}/`))) return;
          this.scheduleScan(p);
        };
        this.disposables.push(watcher, watcher.onDidChange(schedule), watcher.onDidCreate(schedule));
      }
    }
  }

  private scheduleScan(manifestPath: string): void {
    const existing = this.timers.get(manifestPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(manifestPath);
      void this.scanAndReport(manifestPath);
    }, DEBOUNCE_MS);
    this.timers.set(manifestPath, timer);
  }

  async scanAndReport(manifestPath: string): Promise<void> {
    const result = await this.scanFn(manifestPath);
    if (result) this.report(result);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.collection.dispose();
  }
}
