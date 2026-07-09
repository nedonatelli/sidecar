import type { SidecarDir } from '../../config/sidecarDir.js';
import type { ChatMessage } from '../../ollama/types.js';

export interface PlanCheckpoint {
  /** The user's original task/goal — extracted from the first user message. */
  goal: string;
  /** Full conversation snapshot at the time of checkpointing. */
  messages: ChatMessage[];
  /** Number of agent iterations completed so far. */
  turnCount: number;
  /** Unique run ID for deduplication. */
  runId: string;
  /** Unix epoch ms when the task was first started. */
  createdAt: number;
  /** Unix epoch ms of the most recent checkpoint save. */
  updatedAt: number;
  /** Externalized plan (S1) at checkpoint time, so resume restores step state, not just messages. */
  plan?: import('./externalPlan.js').ExternalPlan | null;
}

const CHECKPOINT_PATH = 'plans/active.json';

/**
 * Persists an active agent task checkpoint to `.sidecar/plans/active.json`
 * so it can be resumed after a VS Code restart.
 *
 * The plan is cleared on clean agent loop exit (onDone) and is only
 * restored if VS Code closes mid-run. Use `exists()` on startup to
 * detect an interrupted task and prompt the user to resume.
 */
export class PlanStore {
  constructor(private readonly sidecarDir: SidecarDir) {}

  async save(checkpoint: PlanCheckpoint): Promise<void> {
    try {
      await this.sidecarDir.writeJson(CHECKPOINT_PATH, checkpoint);
    } catch {
      /* non-fatal — checkpoint is best-effort */
    }
  }

  async load(): Promise<PlanCheckpoint | null> {
    try {
      return await this.sidecarDir.readJson<PlanCheckpoint>(CHECKPOINT_PATH);
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    try {
      await this.sidecarDir.writeJson(CHECKPOINT_PATH, null);
    } catch {
      /* non-fatal */
    }
  }

  async exists(): Promise<boolean> {
    const checkpoint = await this.load();
    return checkpoint !== null && checkpoint !== undefined && checkpoint.goal !== null && checkpoint.goal !== undefined;
  }
}

/**
 * Extract a short goal string from the messages array.
 * Uses the first user message, truncated to 80 chars.
 */
export function extractGoal(messages: ChatMessage[]): string {
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (!text) return '(unknown task)';
      return text.length > 80 ? text.slice(0, 77) + '…' : text;
    }
  }
  return '(unknown task)';
}
