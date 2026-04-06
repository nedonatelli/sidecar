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

  async executeCommand(command: string): Promise<string | null> {
    const terminal = this.getOrCreateTerminal();
    terminal.show();

    // Try to use shell integration for output capture
    const shellIntegration = (
      terminal as unknown as {
        shellIntegration?: { executeCommand?: (cmd: string) => { read: () => AsyncIterable<string> } };
      }
    ).shellIntegration;

    if (shellIntegration?.executeCommand) {
      try {
        const execution = shellIntegration.executeCommand(command);
        let output = '';
        for await (const chunk of execution.read()) {
          output += chunk;
        }
        return output;
      } catch {
        // Fall back to sendText
      }
    }

    terminal.sendText(command, true);
    return null; // No output capture available
  }

  dispose(): void {
    this.terminal?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
