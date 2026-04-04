import {
  InlineCompletionItem,
  InlineCompletionItemProvider,
  InlineCompletionContext,
  InlineCompletionTriggerKind,
  TextDocument,
  Position,
  Range,
  CancellationToken,
} from 'vscode';
import { SideCarClient } from '../ollama/client.js';
import { Debouncer } from './debounce.js';

const MIN_INTERVAL_MS = 300;
const MIN_PREFIX_LENGTH = 10;

export class SideCarCompletionProvider implements InlineCompletionItemProvider {
  private debouncer = new Debouncer();

  constructor(
    private client: SideCarClient,
    private maxTokens: number = 256
  ) {}

  async provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext,
    token: CancellationToken
  ): Promise<InlineCompletionItem[]> {
    // Only trigger on automatic (typing), not manual invocations being too aggressive
    if (context.triggerKind === InlineCompletionTriggerKind.Invoke) {
      // Manual invoke is fine, skip debounce
    } else if (!this.debouncer.shouldTrigger(MIN_INTERVAL_MS)) {
      return [];
    }

    const prefix = document.getText(new Range(new Position(0, 0), position));
    const suffix = document.getText(new Range(position, document.lineAt(document.lineCount - 1).range.end));

    // Skip if too little context
    if (prefix.trim().length < MIN_PREFIX_LENGTH) {
      return [];
    }

    const signal = this.debouncer.getSignal();

    // Link VS Code cancellation to our abort
    token.onCancellationRequested(() => this.debouncer.cancel());

    try {
      let completion: string;

      if (this.client.isLocalOllama()) {
        // Use FIM endpoint for local Ollama models
        completion = await this.client.completeFIM(prefix, suffix, undefined, this.maxTokens, signal);
      } else {
        // Use Messages API for remote providers
        completion = await this.client.complete(
          [{
            role: 'user',
            content: `Complete the code at the cursor position marked with <CURSOR>. Only output the completion text, nothing else.\n\n${prefix}<CURSOR>${suffix}`,
          }],
          this.maxTokens,
          signal
        );
      }

      completion = completion.trim();
      if (!completion) return [];

      return [new InlineCompletionItem(completion, new Range(position, position))];
    } catch {
      return [];
    }
  }
}
