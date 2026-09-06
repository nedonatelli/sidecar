import { FIRST_TOKEN_WARMUP_MS, FIRST_TOKEN_PREFILL_MS_PER_TOKEN } from '../../config/constants.js';

/**
 * Context-adaptive first-token deadline, in ms.
 *
 * Prefill time scales with prompt size, so a large-repo context legitimately
 * takes far longer to produce its first token than a short chat. The configured
 * `sidecar.firstTokenTimeout` (passed here in ms) acts as a FLOOR — tight
 * hang-detection for small prompts — and large prompts add prefill headroom
 * proportional to the input token estimate. This keeps a real coding session on
 * a big repo (slow local model) from being aborted mid-prefill and mislabeled a
 * capability failure, without loosening hang-detection for everyday prompts.
 *
 * `configuredMs <= 0` means the user disabled the timeout; that is preserved.
 */
export function firstTokenTimeoutMsFor(configuredMs: number, inputTokens: number): number {
  if (configuredMs <= 0) return configuredMs;
  const adaptiveMs = FIRST_TOKEN_WARMUP_MS + Math.max(0, inputTokens) * FIRST_TOKEN_PREFILL_MS_PER_TOKEN;
  return Math.max(configuredMs, adaptiveMs);
}
