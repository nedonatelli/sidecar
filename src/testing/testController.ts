import * as vscode from 'vscode';
import { parseTestOutput, type TestRunSummary, type ParsedTest } from './testOutputParser.js';

export class SidecarTestController {
  private readonly controller: vscode.TestController;
  private readonly fileItems: Map<string, vscode.TestItem> = new Map();
  private readonly testItems: Map<string, vscode.TestItem> = new Map();

  constructor(context: vscode.ExtensionContext) {
    this.controller = vscode.tests.createTestController('sidecar-tests', 'SideCar Tests');
    context.subscriptions.push(this.controller);

    this.controller.createRunProfile(
      'Run via SideCar',
      vscode.TestRunProfileKind.Run,
      (_request, _token) => {
        const run = this.controller.createTestRun(new vscode.TestRunRequest());
        run.appendOutput('Trigger test runs from the SideCar chat panel.\r\n');
        run.end();
      },
      true,
    );
  }

  reportRun(command: string, output: string): void {
    const summary = parseTestOutput(output);
    if (summary.total === 0) return;

    this.syncItems(summary);

    const run = this.controller.createTestRun(new vscode.TestRunRequest(), command, true);
    for (const test of summary.tests) {
      const item = this.getTestItem(test);
      run.started(item);
      if (test.status === 'pass') {
        run.passed(item, test.duration);
      } else if (test.status === 'fail') {
        run.failed(item, new vscode.TestMessage(test.errorMessage ?? 'Test failed'), test.duration);
      } else {
        run.skipped(item);
      }
    }
    run.end();
  }

  private itemId(test: ParsedTest): string {
    return `${test.filePath ?? '__root__'}::${test.name}`;
  }

  private getTestItem(test: ParsedTest): vscode.TestItem {
    const id = this.itemId(test);
    if (this.testItems.has(id)) return this.testItems.get(id)!;

    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    const fileUri = test.filePath && wsRoot ? vscode.Uri.joinPath(wsRoot, test.filePath) : undefined;

    let parent: vscode.TestItemCollection = this.controller.items;
    if (test.filePath) {
      let fileItem = this.fileItems.get(test.filePath);
      if (!fileItem) {
        fileItem = this.controller.createTestItem(test.filePath, test.filePath, fileUri);
        this.controller.items.add(fileItem);
        this.fileItems.set(test.filePath, fileItem);
      }
      parent = fileItem.children;
    }

    const item = this.controller.createTestItem(id, test.name, fileUri);
    parent.add(item);
    this.testItems.set(id, item);
    return item;
  }

  private syncItems(summary: TestRunSummary): void {
    for (const test of summary.tests) {
      this.getTestItem(test);
    }
  }
}
