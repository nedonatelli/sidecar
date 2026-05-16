// Arena mode types — shared between the panel, ELO store, and commands.

export type ArenaMode = 'chat' | 'agent';

// ---------------------------------------------------------------------------
// ELO
// ---------------------------------------------------------------------------

export const ELO_DEFAULT_RATING = 1200;
export const ELO_K_FACTOR = 32;

export interface EloState {
  /** model id → current ELO rating */
  ratings: Record<string, number>;
  wins: Record<string, number>;
  losses: Record<string, number>;
  totalMatches: number;
}

// ---------------------------------------------------------------------------
// Arena session (chat mode)
// ---------------------------------------------------------------------------

export interface ArenaLane {
  readonly model: string;
  readonly label: string;
}

export interface ArenaTurn {
  readonly prompt: string;
  /** model id → full response text */
  readonly responses: Record<string, string>;
  /** winning model id for this turn (undefined until voted) */
  readonly voteWinner?: string;
}

// ---------------------------------------------------------------------------
// Webview ↔ extension messages
// ---------------------------------------------------------------------------

/** Extension → webview */
export type ArenaToPanel =
  | { command: 'init'; models: string[]; ratings: Record<string, number>; stats: EloState }
  | { command: 'sessionStart'; lanes: Array<{ model: string; label: string; elo: number }> }
  | { command: 'chunk'; laneIndex: number; text: string }
  | { command: 'laneDone'; laneIndex: number }
  | { command: 'laneError'; laneIndex: number; error: string }
  | { command: 'eloUpdate'; ratings: Record<string, number>; stats: EloState };

/** Webview → extension */
export type PanelToArena =
  | { command: 'ready' }
  | { command: 'startChat'; models: string[]; prompt: string }
  | { command: 'vote'; winnerIndex: number }
  | { command: 'changeModels' }
  | { command: 'startAgent'; models: string[]; task: string };
