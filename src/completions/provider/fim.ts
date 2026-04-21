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
import { SideCarClient } from '../../ollama/client.js';
import { getConfig } from '../../config/settings.js';
import { Debouncer } from '../debounce.js';
import {
  PredictiveContext,
  MIN_PREFIX_LENGTH,
  MAX_PREFIX_CHARS,
  MAX_SUFFIX_CHARS,
  COMPLETION_SYSTEM_PROMPT,
} from './shared.js';

export class SideCarCompletionProvider implements InlineCompletionItemProvider {
  private debouncer = new Debouncer();
  private predictiveContext = new PredictiveContext();
  private editListener;

  constructor(
    private client: SideCarClient,
    private maxTokens: number = 256,
    private debounceMs: number = 300,
  ) {
    this.editListener = workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return;
      const change = e.contentChanges[0];
      this.predictiveContext.track({
        file: e.document.fileName,
        line: change.range.start.line,
        text: change.text,
        timestamp: Date.now(),
      });
    });
  }

  dispose(): void {
    this.editListener.dispose();
  }

  /**
   * Race a draft model against the main model for FIM completions.
   * Whichever completes first is returned; the loser is aborted.
   * This gives real latency benefit when the draft model is much faster
   * (e.g. 1.5B vs 7B parameter models).
   */
  private async raceCompletions(
    prefix: string,
    suffix: string,
    draftModel: string,
    signal?: CancellationToken,
  ): Promise<string> {
    const draftController = new AbortController();
    const targetController = new AbortController();

    if (signal?.isCancellationRequested) {
      draftController.abort();
      targetController.abort();
      throw new Error('Completion cancelled');
    }
    signal?.onCancellationRequested(() => {
      draftController.abort();
      targetController.abort();
    });

    const draftRace = this.client
      .completeFIM(prefix, suffix, draftModel, this.maxTokens, draftController.signal)
      .then((result) => ({ result, winner: 'draft' as const }))
      .catch(() => ({ result: '', winner: 'draft-error' as const }));

    const targetRace = this.client
      .completeFIM(prefix, suffix, undefined, this.maxTokens, targetController.signal)
      .then((result) => ({ result, winner: 'target' as const }))
      .catch(() => ({ result: '', winner: 'target-error' as const }));

    const { result, winner } = await Promise.race([draftRace, targetRace]);

    if (winner === 'draft' || winner === 'draft-error') {
      targetController.abort();
    } else {
      draftController.abort();
    }

    if (winner !== 'draft' && winner !== 'target') {
      return '';
    }

    console.info(`[SideCar] Inline completion: FIM race winner = ${winner}`);
    return result;
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

    const fullPrefix = document.getText(new Range(new Position(0, 0), position));
    const fullSuffix = document.getText(new Range(position, document.lineAt(document.lineCount - 1).range.end));

    const prefix = fullPrefix.length > MAX_PREFIX_CHARS ? fullPrefix.slice(-MAX_PREFIX_CHARS) : fullPrefix;
    const suffix = fullSuffix.length > MAX_SUFFIX_CHARS ? fullSuffix.slice(0, MAX_SUFFIX_CHARS) : fullSuffix;

    if (prefix.trim().length < MIN_PREFIX_LENGTH) {
      return [];
    }

    const signal = this.debouncer.getSignal();
    token.onCancellationRequested(() => this.debouncer.cancel());

    // v0.62.2 q.2c — per-completion latency telemetry
    const startedAt = Date.now();
    let pathLabel = 'unknown';

    try {
      let completion: string;

      // Role-Based Model Routing (v0.64 phase 4b.3). Tag this as the
      // `completion` role so `sidecar.modelRouting.rules` can point FIM
      // autocomplete at a different model than the main agent loop.
      this.client.routeForDispatch({ role: 'completion' });

      if (this.client.isLocalOllama()) {
        const draftModel = getConfig().completionDraftModel;
        if (draftModel) {
          pathLabel = 'ollama-fim-race';
          completion = await this.raceCompletions(prefix, suffix, draftModel, token);
        } else {
          pathLabel = 'ollama-fim';
          completion = await this.client.completeFIM(prefix, suffix, undefined, this.maxTokens, signal);
        }
      } else {
        pathLabel = 'messages-api';
        const recentEditContext = this.predictiveContext.buildRecentEditContext(document.fileName);
        // v0.62.2 q.2b — stable system preamble for Anthropic prompt caching;
        // language hint stays in the user message so the system block is
        // byte-identical across file types.
        const userMessage = this.predictiveContext.buildCompletionUserMessage(
          prefix,
          suffix,
          document.languageId,
          recentEditContext,
        );
        completion = await this.client.completeWithOverrides(
          COMPLETION_SYSTEM_PROMPT,
          [{ role: 'user', content: userMessage }],
          undefined,
          this.maxTokens,
          signal,
        );
      }

      completion = PredictiveContext.cleanCompletion(completion, prefix, suffix);
      if (!completion) return [];

      const elapsed = Date.now() - startedAt;
      console.info(`[SideCar] Inline completion [${pathLabel}] ${elapsed}ms, ${completion.length} chars`);

      return [new InlineCompletionItem(completion, new Range(position, position))];
    } catch (err) {
      if (!(err instanceof Error) || err.name !== 'AbortError') {
        const elapsed = Date.now() - startedAt;
        console.info(
          `[SideCar] Inline completion [${pathLabel}] failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return [];
    }
  }
}
