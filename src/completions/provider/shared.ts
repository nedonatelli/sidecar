export const MIN_PREFIX_LENGTH = 10;
export const MAX_PREFIX_CHARS = 8000;
export const MAX_SUFFIX_CHARS = 2000;

export const COMPLETION_SYSTEM_PROMPT =
  'You are a code completion engine. Complete the code at <CURSOR>. Output ONLY the completion text — no explanations, no code fences, no markdown.';

export interface RecentEdit {
  file: string;
  line: number;
  text: string;
  timestamp: number;
}

/**
 * Shared "what is the user likely to do next?" signal that feeds both
 * FIM-style token-level predictions (fim.ts) and whole-edit-block
 * suggestions (nextEdit.ts). Tracks recent edits in a rolling 60-second
 * window, builds the context strings each path needs, and owns the
 * completion-cleanup logic shared across both callers.
 */
export class PredictiveContext {
  private recentEdits: RecentEdit[] = [];

  track(edit: RecentEdit): void {
    this.recentEdits.push(edit);
    const cutoff = Date.now() - 60_000;
    this.recentEdits = this.recentEdits.filter((e) => e.timestamp > cutoff).slice(-10);
  }

  buildRecentEditContext(currentFile: string): string {
    const relevant = this.recentEdits.filter((e) => e.file === currentFile && e.text.trim().length > 0);
    if (relevant.length === 0) return '';
    return relevant
      .slice(-5)
      .map((e) => `Line ${e.line + 1}: ${e.text.slice(0, 100)}`)
      .join('\n');
  }

  buildCompletionUserMessage(prefix: string, suffix: string, languageId: string, recentEdits: string): string {
    let msg = `Language: ${languageId}\n\n`;
    if (recentEdits) {
      msg += `Recent edits (for context on what the developer is doing):\n${recentEdits}\n\n`;
    }
    msg += `${prefix}<CURSOR>${suffix}`;
    return msg;
  }

  static cleanCompletion(raw: string, prefix: string, suffix: string): string {
    let text = raw;
    text = text.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    text = text.replace(/^\n+/, '').replace(/\n+$/, '');
    const lastPrefixLine = prefix.split('\n').pop() || '';
    if (lastPrefixLine && text.startsWith(lastPrefixLine)) {
      text = text.slice(lastPrefixLine.length);
    }
    const firstSuffixLine = suffix.split('\n')[0] || '';
    if (firstSuffixLine && text.endsWith(firstSuffixLine)) {
      text = text.slice(0, -firstSuffixLine.length);
    }
    return text;
  }
}
