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
import { getConfig } from '../config/settings.js';
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

  /**
   * Race a draft model against the main model for FIM completions.
   * Whichever completes first is returned; the loser is aborted.
   * This gives real latency benefit when the draft model is much faster (e.g. 1.5B vs 7B parameter models).
   */
  private async raceCompletions(
    prefix: string,
    suffix: string,
    draftModel: string,
    signal?: CancellationToken,
  ): Promise<string> {
    const draftController = new AbortController();
    const targetController = new AbortController();

    // If the outer signal is cancelled, cancel both races
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

    // Cancel the loser
    if (winner === 'draft' || winner === 'draft-error') {
      targetController.abort();
    } else {
      draftController.abort();
    }

    if (winner !== 'draft' && winner !== 'target') {
      // Both failed; return empty
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

    // v0.62.2 q.2c — per-completion latency telemetry. Pre-fix,
    // users who reported "inline completions feel slow" had no
    // numbers to point at. `startedAt` lets us emit a simple
    // summary on completion OR abort so the SideCar output channel
    // shows actual per-call timings.
    const startedAt = Date.now();
    let pathLabel = 'unknown';

    try {
      let completion: string;

      // Role-Based Model Routing (v0.64 phase 4b.3). Tag this as the
      // `completion` role so `sidecar.modelRouting.rules` can point FIM
      // autocomplete at a different model than the main agent loop
      // (typical shape: tiny draft on completion + big target on
      // agent-loop). No-op when no router is attached.
      this.client.routeForDispatch({ role: 'completion' });

      if (this.client.isLocalOllama()) {
        // Check if we should race against a draft model for speculative FIM speedup
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
        const recentEditContext = this.buildRecentEditContext(document.fileName);
        // v0.62.2 q.2b — split the prompt into a STABLE system
        // preamble + a VARIABLE user body so Anthropic prompt
        // caching kicks in from the second call onward (cache_control
        // is auto-applied by `buildSystemBlocks` in the Anthropic
        // backend, so we just need to ship the system prompt as its
        // own string instead of concatenated into the user message).
        // The stable preamble is language-agnostic — language hint
        // moved into the user body so the system prompt stays
        // identical across file types and caches more aggressively.
        const systemPrompt = SideCarCompletionProvider.COMPLETION_SYSTEM_PROMPT;
        const userMessage = this.buildCompletionUserMessage(prefix, suffix, document.languageId, recentEditContext);
        completion = await this.client.completeWithOverrides(
          systemPrompt,
          [{ role: 'user', content: userMessage }],
          undefined,
          this.maxTokens,
          signal,
        );
      }

      completion = this.cleanCompletion(completion, prefix, suffix);
      if (!completion) return [];

      const elapsed = Date.now() - startedAt;
      console.info(`[SideCar] Inline completion [${pathLabel}] ${elapsed}ms, ${completion.length} chars`);

      return [new InlineCompletionItem(completion, new Range(position, position))];
    } catch (err) {
      // Only log errors that aren't cancellations (noise otherwise).
      if (!(err instanceof Error) || err.name !== 'AbortError') {
        const elapsed = Date.now() - startedAt;
        console.info(
          `[SideCar] Inline completion [${pathLabel}] failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return [];
    }
  }

  /**
   * Static, language-agnostic system preamble for the non-Ollama
   * completion path (v0.62.2 q.2b). Anthropic's prompt caching keys
   * on the system block's byte content — keeping this string
   * constant across every call means from the second completion
   * onward the preamble reads from cache (~10% of the cost + lower
   * TTFT). Include the language hint in the USER message instead so
   * this stays stable across file types.
   */
  static readonly COMPLETION_SYSTEM_PROMPT =
    'You are a code completion engine. Complete the code at <CURSOR>. Output ONLY the completion text — no explanations, no code fences, no markdown.';

  /** Build the variable part of the prompt (language hint + recent-
   *  edit context + code). Kept in a single user message so the
   *  completion model sees a unified prompt shape. */
  private buildCompletionUserMessage(prefix: string, suffix: string, languageId: string, recentEdits: string): string {
    let msg = `Language: ${languageId}\n\n`;
    if (recentEdits) {
      msg += `Recent edits (for context on what the developer is doing):\n${recentEdits}\n\n`;
    }
    msg += `${prefix}<CURSOR>${suffix}`;
    return msg;
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
