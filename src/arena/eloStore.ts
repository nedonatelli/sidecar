import * as fs from 'fs/promises';
import * as path from 'path';
import { ELO_DEFAULT_RATING, ELO_K_FACTOR, type EloState } from './types.js';

/**
 * Persistent ELO rating store. Ratings are loaded from and saved to
 * `<sidecarDir>/arena/elo.json`. Each call to `recordWin` updates the
 * in-memory state and persists immediately.
 *
 * ELO formula: standard K=32, expected score E_a = 1 / (1 + 10^((Rb-Ra)/400)).
 * For multi-way contests (winner vs N losers) each pair is updated independently.
 */
/**
 * elo.json lives in the workspace's .sidecar/ folder, so a cloned repo can ship
 * one. Keep only the shape the store writes -- numbers keyed by model id --
 * so nothing else in it ever reaches the Arena webview.
 */
export function sanitizeEloState(raw: unknown): EloState {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const numbers = (v: unknown, integer: boolean): Record<string, number> => {
    const out: Record<string, number> = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    for (const [k, n] of Object.entries(v)) {
      if (typeof n === 'number' && Number.isFinite(n) && (!integer || (Number.isInteger(n) && n >= 0))) out[k] = n;
    }
    return out;
  };
  const total = obj.totalMatches;
  return {
    ratings: numbers(obj.ratings, false),
    wins: numbers(obj.wins, true),
    losses: numbers(obj.losses, true),
    totalMatches: typeof total === 'number' && Number.isInteger(total) && total >= 0 ? total : 0,
  };
}

export class EloStore {
  private state: EloState = {
    ratings: {},
    wins: {},
    losses: {},
    totalMatches: 0,
  };

  constructor(private readonly storePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.storePath, 'utf-8');
      this.state = sanitizeEloState(JSON.parse(raw));
    } catch {
      // No file yet — start from scratch with empty state.
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  getRating(model: string): number {
    return this.state.ratings[model] ?? ELO_DEFAULT_RATING;
  }

  getRatings(): Record<string, number> {
    return { ...this.state.ratings };
  }

  getState(): EloState {
    return {
      ratings: { ...this.state.ratings },
      wins: { ...this.state.wins },
      losses: { ...this.state.losses },
      totalMatches: this.state.totalMatches,
    };
  }

  /**
   * Record that `winner` beat every model in `losers`.
   * Updates ELO for each pair (winner, loser) and persists.
   */
  async recordWin(winner: string, losers: readonly string[]): Promise<void> {
    this.ensureModel(winner);
    for (const loser of losers) {
      this.ensureModel(loser);
      this.updatePair(winner, loser);
      this.state.totalMatches++;
    }
    await this.save();
  }

  private ensureModel(model: string): void {
    if (!(model in this.state.ratings)) {
      this.state.ratings[model] = ELO_DEFAULT_RATING;
      this.state.wins[model] = 0;
      this.state.losses[model] = 0;
    }
  }

  private updatePair(winner: string, loser: string): void {
    const ra = this.state.ratings[winner]!;
    const rb = this.state.ratings[loser]!;
    const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    const eb = 1 / (1 + Math.pow(10, (ra - rb) / 400));
    this.state.ratings[winner] = Math.round(ra + ELO_K_FACTOR * (1 - ea));
    this.state.ratings[loser] = Math.round(rb + ELO_K_FACTOR * (0 - eb));
    this.state.wins[winner] = (this.state.wins[winner] ?? 0) + 1;
    this.state.losses[loser] = (this.state.losses[loser] ?? 0) + 1;
  }
}
