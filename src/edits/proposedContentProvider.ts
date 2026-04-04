import { TextDocumentContentProvider, Uri, EventEmitter, Event } from 'vscode';

export class ProposedContentProvider implements TextDocumentContentProvider {
  private content = new Map<string, string>();
  private _onDidChange = new EventEmitter<Uri>();

  get onDidChange(): Event<Uri> {
    return this._onDidChange.event;
  }

  provideTextDocumentContent(uri: Uri): string {
    return this.content.get(uri.path) ?? '';
  }

  addProposal(key: string, proposedContent: string): Uri {
    const uri = Uri.parse(`sidecar-proposed:${key}`);
    this.content.set(key, proposedContent);
    this._onDidChange.fire(uri);
    return uri;
  }

  removeProposal(key: string): void {
    this.content.delete(key);
  }

  dispose(): void {
    this._onDidChange.dispose();
    this.content.clear();
  }
}
