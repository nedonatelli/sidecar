import { isLocalOllama, isKickstand, detectProvider } from '../config/settings.js';
import { logger } from '../system/logger.js';
import { SideCarClient } from '../ollama/client.js';
import type { SideCarConfig } from '../config/settings.js';

/**
 * Fire-and-forget Ollama pre-warm and model discovery.
 * Extracted from extension.ts to keep the entry point lean.
 */
export function initWarmup(config: SideCarConfig): void {
  if (isLocalOllama(config.baseUrl)) {
    setImmediate(() => {
      const warmUrl = `${config.baseUrl}/api/generate`;
      fetch(warmUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, prompt: '', keep_alive: '10m' }),
      })
        .then((res) => {
          if (res.ok) {
            logger.info(`[SideCar] Pre-warmed model: ${config.model}`);
          } else {
            logger.warn(`[SideCar] Pre-warm failed (${res.status}) for ${config.model}`);
          }
        })
        .catch((err) => {
          logger.warn('[SideCar] Pre-warm skipped — Ollama may not be running:', err.message);
        });
    });
  }

  const provider = detectProvider(config.baseUrl, config.provider);
  if (provider === 'ollama' || provider === 'kickstand') {
    setImmediate(() => {
      const ollamaUrl = isLocalOllama(config.baseUrl) ? config.baseUrl : 'http://localhost:11434';
      const kickstandUrl = isKickstand(config.baseUrl) ? config.baseUrl : 'http://localhost:11435';
      SideCarClient.discoverAllAvailableModels(ollamaUrl, kickstandUrl)
        .then((models) => {
          if (models.length > 0) {
            const modelNames = models.map((m) => m.name).join(', ');
            logger.info(`[SideCar] Discovered ${models.length} available models: ${modelNames}`);
          } else {
            logger.info('[SideCar] No models discovered from Ollama or Kickstand');
          }
        })
        .catch((err) => {
          logger.warn('[SideCar] Model discovery failed:', err.message);
        });
    });
  }
}
