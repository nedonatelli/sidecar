import { window, LogOutputChannel } from 'vscode';

export class AgentLogger {
  private channel: LogOutputChannel;

  constructor() {
    this.channel = window.createOutputChannel('SideCar Agent', { log: true });
  }

  info(message: string): void {
    this.channel.info(message);
  }

  debug(message: string): void {
    this.channel.debug(message);
  }

  warn(message: string): void {
    this.channel.warn(message);
  }

  error(message: string): void {
    this.channel.error(message);
  }

  logIteration(iteration: number, maxIterations: number): void {
    this.channel.info(`--- Iteration ${iteration}/${maxIterations} ---`);
  }

  logToolCall(name: string, input: Record<string, unknown>): void {
    const inputStr = JSON.stringify(input, null, 2);
    this.channel.info(`Tool call: ${name}`);
    this.channel.debug(`Input: ${inputStr}`);
  }

  logToolResult(name: string, result: string, isError: boolean): void {
    const prefix = isError ? 'Tool error' : 'Tool result';
    const preview = result.length > 500 ? result.slice(0, 500) + '...' : result;
    this.channel.info(`${prefix}: ${name}`);
    this.channel.debug(`Output: ${preview}`);
  }

  logText(text: string): void {
    this.channel.trace(`Text: ${text}`);
  }

  logDone(iterations: number): void {
    this.channel.info(`Agent loop completed after ${iterations} iteration(s)`);
  }

  logAborted(): void {
    this.channel.warn('Agent loop aborted by user');
  }

  logError(err: unknown): void {
    this.channel.error(`Agent error: ${err instanceof Error ? err.message : String(err)}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
