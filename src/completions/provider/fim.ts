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
import { logger } from '../../system/logger.js';
import { SideCarClient } from '../../ollama/client.js';
import { getConfig } from '../../config/settings.js';
import { lookupDraftModel } from '../../config/constants.js';
import {
  PredictiveContext,
  MIN_PREFIX_LENGTH,
  MAX_PREFIX_CHARS,
  MAX_SUFFIX_CHARS,
  COMPLETION_SYSTEM_PROMPT,
} from './shared.js';

export class SideCarCompletionProvider implements InlineCompletionItemProvider {
  private predictiveContext = new PredictiveContext();
  private editListener;
  /** Recent completions keyed by (prefix tail + suffix head). Serves undo/redo/revisit instantly. */
  private readonly completionCache = new Map<string, string>();
  private static readonly CACHE_MAX = 50;

  // Accept-rate tracking for auto-disable when draft model underperforms.
  private speculativeDraftWins = 0;
  private speculativeTotalRaces = 0;
  private speculativeDisabled = false;
  private static readonly SPECULATIVE_WARMUP = 10;

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
   * Updates the session accept-rate tracker and auto-disables speculation
   * when the draft win rate drops below the configured minimum.
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

    this.speculativeTotalRaces++;
    if (winner === 'draft') this.speculativeDraftWins++;

    // After warmup, auto-disable if draft accept rate is too low.
    if (this.speculativeTotalRaces >= SideCarCompletionProvider.SPECULATIVE_WARMUP) {
      const rate = this.speculativeDraftWins / this.speculativeTotalRaces;
      const minRate = getConfig().speculativeDecoding.minAcceptRateToKeepEnabled;
      if (rate < minRate) {
        this.speculativeDisabled = true;
        logger.warn(
          `[SideCar] Speculative decoding auto-disabled: draft win rate ${(rate * 100).toFixed(0)}% < threshold ${(minRate * 100).toFixed(0)}%`,
        );
      }
    }

    logger.info(
      `[SideCar] Inline completion: FIM race winner = ${winner} ` +
        `(draft ${this.speculativeDraftWins}/${this.speculativeTotalRaces})`,
    );
    return result;
  }

  async provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext,
    token: CancellationToken,
  ): Promise<InlineCompletionItem[]> {
    // True timer-based debounce: wait debounceMs of silence before hitting the
    // model. VS Code cancels the token on each cursor move / new keystroke, which
    // clears the timer — so only the final keystroke in a burst ever fires.
    if (context.triggerKind !== InlineCompletionTriggerKind.Invoke) {
      const passed = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(true), this.debounceMs);
        token.onCancellationRequested(() => {
          clearTimeout(t);
          resolve(false);
        });
      });
      if (!passed || token.isCancellationRequested) return [];
    }

    const fullPrefix = document.getText(new Range(new Position(0, 0), position));
    const fullSuffix = document.getText(new Range(position, document.lineAt(document.lineCount - 1).range.end));
    const prefix = fullPrefix.length > MAX_PREFIX_CHARS ? fullPrefix.slice(-MAX_PREFIX_CHARS) : fullPrefix;
    const suffix = fullSuffix.length > MAX_SUFFIX_CHARS ? fullSuffix.slice(0, MAX_SUFFIX_CHARS) : fullSuffix;

    if (prefix.trim().length < MIN_PREFIX_LENGTH) return [];

    // Cache hit — serve without a model round-trip. Handles undo/redo/revisit.
    // Key uses a tail of the prefix + head of the suffix to keep memory bounded.
    const cacheKey = `${prefix.slice(-500)}|||${suffix.slice(0, 200)}`;
    const cached = this.completionCache.get(cacheKey);
    if (cached !== undefined) {
      return cached ? [new InlineCompletionItem(cached, new Range(position, position))] : [];
    }

    const abort = new AbortController();
    const cancelSub = token.onCancellationRequested(() => abort.abort());
    const startedAt = Date.now();
    let pathLabel = 'unknown';
    let isRacing = false;

    try {
      let completion: string;

      this.client.routeForDispatch({ role: 'completion' });
      const providerType = this.client.getProviderType();
      const isLocalFim = this.client.isLocalOllama() || providerType === 'kickstand';

      if (isLocalFim) {
        const cfg = getConfig();
        const explicitDraft = cfg.completionDraftModel;
        const autoDraft =
          cfg.speculativeDecoding.enabled && !this.speculativeDisabled
            ? explicitDraft || lookupDraftModel(this.client.getModel())
            : explicitDraft;

        if (autoDraft) {
          isRacing = true;
          pathLabel = `${providerType}-fim-race`;
          completion = await this.raceCompletions(prefix, suffix, autoDraft, token);
        } else {
          pathLabel = `${providerType}-fim`;
          completion = await this.client.completeFIM(prefix, suffix, undefined, this.maxTokens, abort.signal);
        }
      } else {
        pathLabel = 'messages-api';
        const recentEditContext = this.predictiveContext.buildRecentEditContext(document.fileName);
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
          abort.signal,
        );
      }

      completion = PredictiveContext.cleanCompletion(completion, prefix, suffix);

      // Cache single-model results (FIM and messages-api) so undo/redo/revisit
      // serve instantly without a model round-trip. Racing results are not
      // cached: the draft model may have won, giving lower-quality output that
      // shouldn't persist to other positions.
      if (!isRacing) {
        if (this.completionCache.size >= SideCarCompletionProvider.CACHE_MAX) {
          const firstKey = this.completionCache.keys().next().value;
          if (firstKey !== undefined) this.completionCache.delete(firstKey);
        }
        this.completionCache.set(cacheKey, completion);
      }

      if (!completion) return [];

      const elapsed = Date.now() - startedAt;
      logger.info(`[SideCar] Inline completion [${pathLabel}] ${elapsed}ms, ${completion.length} chars`);

      return [new InlineCompletionItem(completion, new Range(position, position))];
    } catch (err) {
      if (!(err instanceof Error) || err.name !== 'AbortError') {
        const elapsed = Date.now() - startedAt;
        logger.info(
          `[SideCar] Inline completion [${pathLabel}] failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return [];
    } finally {
      cancelSub?.dispose();
    }
  }
}
