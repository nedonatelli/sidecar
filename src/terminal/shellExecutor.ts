/**
 * Unified shell-execution abstraction for the agent.
 *
 * Prior to v0.92, `shell.ts` had two nearly-identical try/catch/fallback
 * blocks (one in `runCommand`, one in `runTests`) that each duplicated the
 * logic:
 *   1. Try the VS Code shell-integration terminal (AgentTerminalExecutor).
 *   2. Fall back to the child_process-backed ShellSession when integration
 *      is unavailable or the user has opted out.
 *   3. Always use ShellSession for background commands (no shell-integration
 *      equivalent exists).
 *
 * `CompositeShellExecutor` consolidates that routing so the tool handlers
 * work against a single interface — and tests can inject fakes at either
 * layer.
 */

import type { ShellExecuteOptions, ShellResult } from './shellSession.js';
import type { AgentTerminalExecutor } from './agentExecutor.js';
import type { ShellSession } from './shellSession.js';

export type { ShellExecuteOptions, ShellResult };

export interface BackgroundStatus {
  done: boolean;
  output: string;
  exitCode: number | null;
}

/**
 * Contract that every shell-execution backend must satisfy. Deliberately
 * minimal — background-command tracking and disposal are the only extras
 * beyond `execute`.
 */
export interface IShellExecutor {
  /** Run a command synchronously (from the caller's perspective) and return
   *  its output + exit code. */
  execute(command: string, options?: ShellExecuteOptions): Promise<ShellResult>;
  /** Start a command in the background and return a tracking ID. */
  executeBackground(command: string): string;
  /** Poll a background command by ID. Returns null when the ID is unknown. */
  checkBackground(id: string): BackgroundStatus | null;
  dispose(): void;
}

export interface CompositeShellExecutorOptions {
  /** Whether to try the terminal (shell-integration) path first. Default true. */
  terminalEnabled: boolean;
  /** Whether to fall back to ShellSession when terminal returns null. Default true. */
  fallbackToChildProcess: boolean;
}

/**
 * Composes AgentTerminalExecutor (visible VS Code terminal) with ShellSession
 * (hidden child_process) into a single executor with well-defined routing:
 *
 *   foreground commands:
 *     terminalEnabled → try AgentTerminalExecutor.execute()
 *       • returns ShellResult → done
 *       • returns null (integration unavailable) → fall through
 *       • throws → fall through if fallbackToChildProcess, else rethrow
 *     ShellSession.execute() (fallback or primary when terminal disabled)
 *
 *   background commands: always ShellSession (shell-integration has no
 *   background-execution API).
 */
export class CompositeShellExecutor implements IShellExecutor {
  constructor(
    private readonly terminal: AgentTerminalExecutor,
    private readonly session: ShellSession,
    private readonly opts: CompositeShellExecutorOptions,
  ) {}

  async execute(command: string, options?: ShellExecuteOptions): Promise<ShellResult> {
    if (this.opts.terminalEnabled) {
      let terminalResult: ShellResult | null = null;
      try {
        terminalResult = await this.terminal.execute(command, options ?? {});
      } catch (err) {
        if (!this.opts.fallbackToChildProcess) throw err;
        // Fall through to session
      }
      if (terminalResult) return terminalResult;
      if (!this.opts.fallbackToChildProcess) {
        throw new Error(
          'Command not executed: shell integration is unavailable and ' +
            '`sidecar.terminalExecution.fallbackToChildProcess` is false.',
        );
      }
    }
    return this.session.execute(command, options ?? {});
  }

  executeBackground(command: string): string {
    return this.session.executeBackground(command);
  }

  checkBackground(id: string): BackgroundStatus | null {
    return this.session.checkBackground(id);
  }

  dispose(): void {
    this.terminal.dispose();
    this.session.dispose();
  }
}
