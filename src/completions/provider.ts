import {
  InlineCompletionItem,
  InlineCompletionItemProvider,
  InlineCompletionContext,
  InlineCompletionTriggerKind,
  TextDocument,
  Position,
  Range,
  CancellationToken,
  workspace,
} from 'vscode';
import { SideCarClient } from '../ollama/client.js';
import { Debouncer } from './debounce.js';

const MIN_PREFIX_LENGTH = 10;
const MAX_PREFIX_CHARS = 8000;
const MAX_SUFFIX_CHARS = 2000;

export class SideCarCompletionProvider implements InlineCompletionItemProvider {
  private debouncer = new Debouncer();
  private recentEdits: { file: string; line: number; text: string; timestamp: number }[] = [];
  private editListener;

  constructor(
    private client: SideCarClient,
    private maxTokens: number = 256,
    private debounceMs: number = 300,
  ) {
    // Track recent edits for next-edit prediction
    this.editListener = workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return;
      const change = e.contentChanges[0];
      this.recentEdits.push({
        file: e.document.fileName,
        line: change.range.start.line,
        text: change.text,
        timestamp: Date.now(),
      });
      // Keep only last 10 edits from last 60 seconds
      const cutoff = Date.now() - 60_000;
      this.recentEdits = this.recentEdits.filter((e) => e.timestamp > cutoff).slice(-10);
    });
  }

  dispose(): void {
    this.editListener.dispose();
  }

  async provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext,
    token: CancellationToken,
  ): Promise<InlineCompletionItem[]> {
    if (context.triggerKind === InlineCompletionTriggerKind.Invoke) {
      // Manual invoke — skip debounce
    } else if (!this.debouncer.shouldTrigger(this.debounceMs)) {
      return [];
    }

    // Get prefix and suffix with size limits
    const fullPrefix = document.getText(new Range(new Position(0, 0), position));
    const fullSuffix = document.getText(new Range(position, document.lineAt(document.lineCount - 1).range.end));

    const prefix = fullPrefix.length > MAX_PREFIX_CHARS ? fullPrefix.slice(-MAX_PREFIX_CHARS) : fullPrefix;
    const suffix = fullSuffix.length > MAX_SUFFIX_CHARS ? fullSuffix.slice(0, MAX_SUFFIX_CHARS) : fullSuffix;

    if (prefix.trim().length < MIN_PREFIX_LENGTH) {
      return [];
    }

    const signal = this.debouncer.getSignal();
    token.onCancellationRequested(() => this.debouncer.cancel());

    try {
      let completion: string;

      if (this.client.isLocalOllama()) {
        completion = await this.client.completeFIM(prefix, suffix, undefined, this.maxTokens, signal);
      } else {
        const recentEditContext = this.buildRecentEditContext(document.fileName);
        const prompt = this.buildCompletionPrompt(prefix, suffix, document.languageId, recentEditContext);
        completion = await this.client.complete([{ role: 'user', content: prompt }], this.maxTokens, signal);
      }

      completion = this.cleanCompletion(completion, prefix, suffix);
      if (!completion) return [];

      return [new InlineCompletionItem(completion, new Range(position, position))];
    } catch {
      return [];
    }
  }

  private buildCompletionPrompt(prefix: string, suffix: string, languageId: string, recentEdits: string): string {
    let prompt = `You are a code completion engine. Complete the ${languageId} code at <CURSOR>. Output ONLY the completion text — no explanations, no code fences, no markdown.\n\n`;

    if (recentEdits) {
      prompt += `Recent edits (for context on what the developer is doing):\n${recentEdits}\n\n`;
    }

    prompt += `${prefix}<CURSOR>${suffix}`;
    return prompt;
  }

  private buildRecentEditContext(currentFile: string): string {
    const relevant = this.recentEdits.filter((e) => e.file === currentFile && e.text.trim().length > 0);
    if (relevant.length === 0) return '';

    return relevant
      .slice(-5)
      .map((e) => `Line ${e.line + 1}: ${e.text.slice(0, 100)}`)
      .join('\n');
  }

  private cleanCompletion(raw: string, prefix: string, suffix: string): string {
    let text = raw;

    // Remove code fence wrappers if the model adds them
    text = text.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');

    // Remove leading/trailing blank lines but preserve internal structure
    text = text.replace(/^\n+/, '').replace(/\n+$/, '');

    // If the completion repeats the end of the prefix, trim the overlap
    const lastPrefixLine = prefix.split('\n').pop() || '';
    if (lastPrefixLine && text.startsWith(lastPrefixLine)) {
      text = text.slice(lastPrefixLine.length);
    }

    // If the completion includes the start of the suffix, trim it
    const firstSuffixLine = suffix.split('\n')[0] || '';
    if (firstSuffixLine && text.endsWith(firstSuffixLine)) {
      text = text.slice(0, -firstSuffixLine.length);
    }

    return text;
  }
}
