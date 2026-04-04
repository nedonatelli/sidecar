export class Debouncer {
  private lastTrigger = 0;
  private pendingAbort: AbortController | null = null;

  shouldTrigger(minimumIntervalMs: number): boolean {
    const now = Date.now();
    if (now - this.lastTrigger < minimumIntervalMs) {
      return false;
    }
    this.lastTrigger = now;
    return true;
  }

  getSignal(): AbortSignal {
    // Cancel any previous in-flight request
    this.pendingAbort?.abort();
    this.pendingAbort = new AbortController();
    return this.pendingAbort.signal;
  }

  cancel(): void {
    this.pendingAbort?.abort();
    this.pendingAbort = null;
  }
}
