import { window, type LogOutputChannel } from 'vscode';

// ---------------------------------------------------------------------------
// Process-wide diagnostic logger.
//
// Routes all non-agent-loop diagnostics into a single "SideCar" output
// channel instead of the developer console, so a user debugging a shipped
// extension sees them in VS Code's Output panel. Backed by a
// `LogOutputChannel`, which carries native per-channel log-level control
// (trace/debug/info/warn/error) via VS Code's "Set Log Level" UI — no custom
// level config needed.
//
// The channel is created lazily on first use so importing this module at the
// top level never touches the VS Code API before activation. Method signatures
// mirror `console.*` (a message plus optional interpolation args) so call
// sites migrate with a one-word rename.
//
// Distinct from `AgentLogger` ("SideCar Agent"), which owns per-run agent-loop
// tracing; this channel is for everything else (backends, MCP, indexing, …).
// ---------------------------------------------------------------------------

// Minimal no-op stand-in used when the output-channel API is unavailable
// (e.g. unit tests that mock `vscode` without `createOutputChannel`, or any
// non-extension-host context). A diagnostic logger must never crash its
// caller, so we degrade to silence rather than throw.
const NOOP_CHANNEL = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as LogOutputChannel;

let channel: LogOutputChannel | undefined;

function chan(): LogOutputChannel {
  if (!channel) {
    try {
      channel = window.createOutputChannel('SideCar', { log: true });
    } catch {
      channel = NOOP_CHANNEL;
    }
  }
  return channel;
}

export const logger = {
  trace(message: string, ...args: unknown[]): void {
    chan().trace(message, ...args);
  },
  debug(message: string, ...args: unknown[]): void {
    chan().debug(message, ...args);
  },
  info(message: string, ...args: unknown[]): void {
    chan().info(message, ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    chan().warn(message, ...args);
  },
  error(message: string, ...args: unknown[]): void {
    chan().error(message, ...args);
  },
};
