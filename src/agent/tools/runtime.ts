import { getConfig, type SideCarConfig } from '../../config/settings.js';
import { tokensToChars } from '../../config/tokenEstimation.js';
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
  /** Project Knowledge Index symbol-embedding store. Wired
   *  when `sidecar.projectKnowledge.enabled` is on; null otherwise. */
  symbolEmbeddings: SymbolEmbeddingIndex | null = null;

  /**
   * @param cwdOverride  Optional working directory for the shell session.
   *   Production omits this and uses the VS Code workspace root. The eval
   *   harness passes the sandbox root so run_command stays scoped to the
   *   temp workspace instead of scanning the whole project tree.
   * @param envOverride  Optional environment for the shell session, merged
   *   over process.env. The SWE-bench harness passes a per-task venv's
   *   VIRTUAL_ENV/PATH so run_tests/run_command execute against the repo's
   *   installed dependencies instead of the bare host interpreter.
   */
  constructor(
    private readonly cwdOverride?: string,
    private readonly envOverride?: Record<string, string>,
  ) {}

  /**
   * Lazily-constructed persistent shell session. State (cwd, env vars,
   * aliases) survives across tool calls — important so that `cd src/ && ls`
   * followed by `pwd` reports the new cwd.
   */
  getShellSession(injectedConfig?: SideCarConfig): ShellSession {
    if (this.shell && this.shell.isAlive) return this.shell;
    const config = injectedConfig ?? getConfig();
    // Bound shell capture near what the model will actually see. The prompt-pruner
    // truncates each tool result to ~promptPruningMaxToolResultTokens before it
    // reaches the model, so capturing far more stdout than that just wastes memory —
    // a `run_command` that dumps a whole test suite held megabytes we then discarded
    // 99% of. Default (shellMaxOutputMB = 0 / auto): cap at 16× the pruner keep with a
    // 512KB floor — enough head+tail material for the pruner, but no unbounded buffer.
    // An explicit shellMaxOutputMB (>0) forces a hard MB ceiling for users who want the
    // full stream in the webview.
    const autoCap = Math.max(512 * 1024, tokensToChars(config.promptPruningMaxToolResultTokens) * 16);
    const maxOutput = config.shellMaxOutputMB > 0 ? config.shellMaxOutputMB * 1024 * 1024 : autoCap;
    this.shell = new ShellSession(this.cwdOverride ?? getRoot(), this.envOverride, maxOutput, config.sandboxEnabled);
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
 * has something to query. Passing `null` detaches and makes
 * the tool surface an "index not available" response.
 */
export function setSymbolEmbeddings(index: SymbolEmbeddingIndex | null): void {
  defaultRuntime.symbolEmbeddings = index;
}
