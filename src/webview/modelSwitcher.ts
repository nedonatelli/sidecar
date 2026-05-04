/**
 * Model-switching logic extracted from `ChatViewProvider`.
 *
 * `setModel` verifies that the requested model is installed in local Ollama
 * before persisting to global settings — without this guard a mis-typed name
 * corrupts `sidecar.model` and soft-bricks every subsequent chat turn.
 * `refreshOpenRouterCostsIfActive` is a fire-and-forget helper that updates
 * the runtime cost overlay after a backend switch.
 *
 * Both functions are pure enough (no `this`) to be tested with mocks.
 */

import { workspace, window } from 'vscode';
import { getConfig } from '../config/settings.js';
import { handleInstallModel } from './handlers/modelHandlers.js';
import type { ChatState } from './chatState.js';
import type { ExtensionMessage } from './chatWebview.js';

/**
 * Switch the active model. For local Ollama backends, verifies the model is
 * installed before persisting — falls through on Ollama connectivity errors
 * so the user sees a clearer "cannot reach Ollama" error from the next chat
 * turn rather than a generic model-not-found failure.
 */
export async function setModel(
  state: ChatState,
  postMessage: (msg: ExtensionMessage) => void,
  model: string,
): Promise<void> {
  if (!model) return;
  const cfg = getConfig();
  state.client.updateConnection(cfg.baseUrl, cfg.apiKey);

  if (state.client.isLocalOllama()) {
    try {
      const installed = await state.client.listInstalledModels();
      const hit = installed.some((m) => m.name === model || m.name.split(':')[0] === model.split(':')[0]);
      if (!hit) {
        const action = await window.showWarningMessage(
          `SideCar: ${model} is not installed in Ollama. Install it first, then select it.`,
          'Install Model',
          'Cancel',
        );
        if (action === 'Install Model') {
          await handleInstallModel(state, model);
        }
        return;
      }
    } catch (err) {
      // Ollama unreachable — fall through; next chat will surface the error.
      console.warn('setModel: could not verify installed models:', err);
    }
  }

  state.client.updateModel(model);
  const { modelSupportsTools, probeModelToolSupport } = await import('../ollama/ollamaBackend.js');
  if (state.client.isLocalOllama()) {
    await probeModelToolSupport(cfg.baseUrl, model);
  }
  const supports = modelSupportsTools(model);
  postMessage({ command: 'setCurrentModel', currentModel: model, supportsTools: supports });
  await workspace.getConfiguration('sidecar').update('model', model, true);
}

/**
 * Fetch the OpenRouter model catalog and ingest pricing for all models.
 * No-op when the active backend is not OpenRouter.
 */
export async function refreshOpenRouterCostsIfActive(baseUrl: string, apiKey: string): Promise<void> {
  const { detectProvider, ingestOpenRouterCatalog } = await import('../config/settings.js');
  if (detectProvider(baseUrl, getConfig().provider) !== 'openrouter') return;
  try {
    const { OpenRouterBackend } = await import('../ollama/openrouterBackend.js');
    const backend = new OpenRouterBackend(baseUrl, apiKey);
    const catalog = await backend.listOpenRouterModels();
    const registered = ingestOpenRouterCatalog(catalog);
    if (registered > 0 && getConfig().verboseMode) {
      console.log(`[SideCar openrouter] ingested pricing for ${registered} models from the catalog`);
    }
  } catch (err) {
    console.warn('[SideCar openrouter] failed to refresh cost catalog:', err);
  }
}
