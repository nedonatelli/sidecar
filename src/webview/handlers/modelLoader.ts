import type { ChatState } from '../chatState.js';
import type { LibraryModelUI } from '../chatWebview.js';
import { getConfig } from '../../config/settings.js';
import { isProviderReachable } from '../../config/providerReachability.js';
import { modelSupportsTools, probeAllModelToolSupport, getCachedOllamaNumCtx } from '../../ollama/ollamaBackend.js';
import { surfaceProviderError } from '../errorSurface.js';

export function formatContextLength(n: number): string {
  const k = n / 1024;
  return (k >= 10 ? Math.round(k) : parseFloat(k.toFixed(1))) + 'K ctx';
}

export async function loadModels(state: ChatState): Promise<void> {
  const config = getConfig();
  try {
    const started = await isProviderReachable(state.client.getProviderType());
    if (!started) {
      const message = state.client.isLocalOllama()
        ? 'Cannot start Ollama. Make sure Ollama is installed and in your PATH.'
        : `Cannot reach API at ${config.baseUrl}. Check your baseUrl and apiKey settings.`;
      state.postMessage({ command: 'error', content: message });
      void surfaceProviderError(message, 'connection');
      return;
    }

    // Chat UX should only surface models the backend can actually run right
    // now — use installed-only view. The `sidecar.selectModel` palette still
    // uses the default (with suggestions) for new-user discovery.
    const libraryModels = await state.client.listLibraryModels({ includeSuggestions: false });

    if (state.client.isLocalOllama()) {
      const installedNames = libraryModels.filter((m) => m.installed).map((m) => m.name);
      await probeAllModelToolSupport(config.baseUrl, installedNames);
    }

    const modelsUI: LibraryModelUI[] = libraryModels.map((m) => {
      // For Ollama models, /api/tags carries no context length. probeAllModelToolSupport
      // already called /api/show for each installed model and cached the result, so
      // prefer that; apply the same 32768 floor used in streamChat so the badge matches
      // the actual num_ctx sent to Ollama. Uninstalled suggestions keep m.contextLength.
      let contextLength = m.contextLength ?? null;
      if (state.client.isLocalOllama() && m.installed) {
        const probed = getCachedOllamaNumCtx(m.name);
        contextLength = Math.max(probed ?? 0, 32_768);
      }
      return {
        name: m.name,
        installed: m.installed,
        supportsTools: modelSupportsTools(m.name),
        contextLength,
      };
    });

    state.postMessage({ command: 'setModels', models: modelsUI });

    // Warn loudly when the persisted model isn't actually installed —
    // a stale HF-style name in sidecar.model would 404 every chat turn
    // until the user manually fixes it.
    if (state.client.isLocalOllama()) {
      const installed = libraryModels.filter((m) => m.installed).map((m) => m.name);
      const configBase = config.model.split(':')[0];
      const hit = installed.some((name) => name === config.model || name.split(':')[0] === configBase);
      if (!hit && installed.length > 0) {
        state.postMessage({
          command: 'assistantMessage',
          content: `⚠️ Your selected model **${config.model}** is not installed in Ollama. Installed models: ${installed.map((n) => `\`${n}\``).join(', ')}. Pick one from the dropdown or install **${config.model}** to continue.\n\n`,
        });
      } else if (!hit && installed.length === 0) {
        state.postMessage({
          command: 'assistantMessage',
          content: `⚠️ No models are installed in Ollama yet. Paste a model name or HuggingFace URL into the custom-model input to get started — try \`Qwen/Qwen2.5-0.5B-Instruct\` for a quick first install.\n\n`,
        });
      }
    }

    const currentModel = getConfig().model;
    const supportsTools = modelSupportsTools(currentModel);
    state.postMessage({ command: 'setCurrentModel', currentModel, supportsTools });
  } catch (err) {
    console.error('Failed to load models:', err);
    const message = state.client.isLocalOllama()
      ? 'Cannot connect to Ollama. Make sure Ollama is running on localhost:11434.'
      : `Cannot connect to API at ${config.baseUrl}.`;
    state.postMessage({ command: 'error', content: message });
    void surfaceProviderError(message, 'connection');
  }
}
