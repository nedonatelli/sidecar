import { getConfig } from '../../config/settings.js';
import { ShellSession } from '../../terminal/shellSession.js';
import type { SymbolGraph } from '../../config/symbolGraph.js';
import type { SymbolEmbeddingIndex } from '../../config/symbolEmbeddingIndex.js';
import { getRoot } from './shared.js';

// ---------------------------------------------------------------------------
// Tool runtime — cohesive container for tool-execution state that used to
// live as loose module-level singletons (persistent shell session + symbol
// graph index). One object means:
//   - single dispose point
//   - single injection seam (for sub-agents or tests)
//   - obvious ownership: extension owns one; tests can construct their own
//
// Each tool executor reads from `getDefaultToolRuntime()`, so extension
// activation populates the default instance while tests and future parallel
// agent contexts can still construct their own via `new ToolRuntime()`.
// ---------------------------------------------------------------------------
export class ToolRuntime {
  private shell: ShellSession | null = null;
  symbolGraph: SymbolGraph | null = null;
  /** Project Knowledge Index symbol-embedding store (v0.61 b.3). Wired
   *  when `sidecar.projectKnowledge.enabled` is on; null otherwise. */
  symbolEmbeddings: SymbolEmbeddingIndex | null = null;

  /**
   * Lazily-constructed persistent shell session. State (cwd, env vars,
   * aliases) survives across tool calls — important so that `cd src/ && ls`
   * followed by `pwd` reports the new cwd.
   */
  getShellSession(): ShellSession {
    if (this.shell && this.shell.isAlive) return this.shell;
    const config = getConfig();
    const maxOutput = (config.shellMaxOutputMB || 10) * 1024 * 1024;
    this.shell = new ShellSession(getRoot(), undefined, maxOutput);
    return this.shell;
  }

  /** Tear down the persistent shell; safe to call repeatedly. */
  dispose(): void {
    this.shell?.dispose();
    this.shell = null;
  }
}

const defaultRuntime = new ToolRuntime();

/** Access the process-wide default ToolRuntime. Extension owns this one. */
export function getDefaultToolRuntime(): ToolRuntime {
  return defaultRuntime;
}

/** Convenience accessor used by tool executors that need the persistent shell. */
export function getShellSession(): ShellSession {
  return defaultRuntime.getShellSession();
}

/** Call on extension deactivate to clean up the shell process. */
export function disposeShellSession(): void {
  defaultRuntime.dispose();
}

/**
 * Wire (or unwire) the symbol graph into the default runtime. Extension
 * activation calls this with the real tree-sitter indexer; tests pass a
 * mock. Passing `null` detaches, which the reload flow uses before
 * rebuilding.
 */
export function setSymbolGraph(graph: SymbolGraph | null): void {
  defaultRuntime.symbolGraph = graph;
}

/**
 * Wire (or unwire) the symbol-embedding index so `project_knowledge_search`
 * has something to query (v0.61 b.3). Passing `null` detaches and makes
 * the tool surface an "index not available" response.
 */
export function setSymbolEmbeddings(index: SymbolEmbeddingIndex | null): void {
  defaultRuntime.symbolEmbeddings = index;
}
