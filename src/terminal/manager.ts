import { window, Terminal, Disposable } from 'vscode';

export class TerminalManager implements Disposable {
  private terminal: Terminal | null = null;
  private disposables: Disposable[] = [];

  constructor() {
    this.disposables.push(
      window.onDidCloseTerminal((t) => {
        if (t === this.terminal) {
          this.terminal = null;
        }
      }),
    );
  }

  getOrCreateTerminal(): Terminal {
    if (!this.terminal) {
      this.terminal = window.createTerminal('SideCar');
    }
    return this.terminal;
  }

  async executeCommand(command: string): Promise<string> {
    const terminal = this.getOrCreateTerminal();
    terminal.show();

    // Try to use shell integration for output capture
    const integration = terminal.shellIntegration;
    if (integration?.executeCommand) {
      try {
        const execution = integration.executeCommand(command);
        let output = '';
        for await (const chunk of execution.read()) {
          output += chunk;
        }
        return output;
      } catch {
        // Fall back to sendText
      }
    }

    // Sent: it WILL run in the terminal (VS Code queues the text until the
    // shell starts). There is just no output to return. Callers must not run
    // it again -- reading null as "not run" executed every approved command
    // twice whenever the terminal had no shell integration yet.
    terminal.sendText(command, true);
    return TerminalManager.SENT_WITHOUT_OUTPUT;
  }

  /** Returned when the command was sent to the terminal but its output could not be captured. */
  static readonly SENT_WITHOUT_OUTPUT = '(sent to the SideCar terminal -- see its output there)';

  dispose(): void {
    this.terminal?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
