import { EventEmitter } from 'vscode';

/**
 * Runtime health of the active SideCar backend, surfaced to the status
 * bar so the user can tell at a glance whether anything is wrong.
 *
 * Values:
 *   - 'unknown': nothing has exercised the backend yet (fresh session)
 *   - 'ok':      last request succeeded
 *   - 'degraded': the backend is reachable but rate-limited or slow
 *   - 'error':   the last request failed with a surfaced error
 *
 * A separate EventEmitter (rather than a callback registered via
 * `errorSurface.ts`) keeps the error plumbing decoupled: any code path
 * — chat handler, model loader, background agent — can call
 * `healthStatus.setError(...)` without needing a reference to the
 * status bar item.
 */
export type HealthStatusKind = 'unknown' | 'ok' | 'degraded' | 'error';

export interface HealthSnapshot {
  status: HealthStatusKind;
  /** Short human-readable reason, e.g. "401 Unauthorized" or "rate-limited". */
  detail?: string;
  /** Full error message captured at the last failure, for the tooltip. */
  lastError?: string;
  /** Time of the most recent state transition — drives "last checked" text. */
  updatedAt: number;
}

class HealthStatus {
  private snapshot: HealthSnapshot = { status: 'unknown', updatedAt: Date.now() };
  private _onDidChange = new EventEmitter<HealthSnapshot>();
  readonly onDidChange = this._onDidChange.event;

  get(): HealthSnapshot {
    return this.snapshot;
  }

  setOk(): void {
    this.update({ status: 'ok', detail: undefined, lastError: undefined });
  }

  setDegraded(detail: string): void {
    this.update({ status: 'degraded', detail, lastError: undefined });
  }

  setError(detail: string, fullError?: string): void {
    this.update({ status: 'error', detail, lastError: fullError ?? detail });
  }

  reset(): void {
    this.update({ status: 'unknown', detail: undefined, lastError: undefined });
  }

  private update(partial: Omit<HealthSnapshot, 'updatedAt'>): void {
    // Skip no-op transitions so subscribers don't re-render on every
    // successful request.
    if (
      this.snapshot.status === partial.status &&
      this.snapshot.detail === partial.detail &&
      this.snapshot.lastError === partial.lastError
    ) {
      return;
    }
    this.snapshot = { ...partial, updatedAt: Date.now() };
    this._onDidChange.fire(this.snapshot);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

export const healthStatus = new HealthStatus();
