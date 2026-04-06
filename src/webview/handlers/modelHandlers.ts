import type { ChatState } from '../chatState.js';
import type { LibraryModelUI } from '../chatWebview.js';
import { getConfig } from '../../config/settings.js';

export async function loadModels(state: ChatState): Promise<void> {
  const config = getConfig();
  try {
    const started = await ensureReachable(state);
    if (!started) {
      state.postMessage({
        command: 'error',
        content: state.client.isLocalOllama()
          ? 'Cannot start Ollama. Make sure Ollama is installed and in your PATH.'
          : `Cannot reach API at ${config.baseUrl}. Check your baseUrl and apiKey settings.`,
      });
      return;
    }

    const libraryModels = await state.client.listLibraryModels();

    const modelsUI: LibraryModelUI[] = libraryModels.map((m) => ({
      name: m.name,
      installed: m.installed,
    }));

    state.postMessage({ command: 'setModels', models: modelsUI });
    state.postMessage({ command: 'setCurrentModel', currentModel: config.model });
  } catch (err) {
    console.error('Failed to load models:', err);
    state.postMessage({
      command: 'error',
      content: state.client.isLocalOllama()
        ? 'Cannot connect to Ollama. Make sure Ollama is running on localhost:11434.'
        : `Cannot connect to API at ${config.baseUrl}.`,
    });
  }
}

export async function handleInstallModel(state: ChatState, modelName: string): Promise<void> {
  state.installAbortController = new AbortController();

  try {
    state.postMessage({
      command: 'installProgress',
      modelName,
      progress: 'Starting...',
    });

    for await (const progress of state.client.pullModel(modelName, state.installAbortController.signal)) {
      state.postMessage({
        command: 'installProgress',
        modelName,
        progress: progress.status,
      });
    }

    state.client.updateModel(modelName);
    state.postMessage({ command: 'installComplete', modelName });
    state.postMessage({ command: 'setCurrentModel', currentModel: modelName });
    await loadModels(state);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      state.postMessage({ command: 'installComplete', modelName });
      return;
    }
    state.postMessage({
      command: 'error',
      content: `Failed to install ${modelName}: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    state.installAbortController = null;
  }
}

async function ensureReachable(state: ChatState): Promise<boolean> {
  const config = getConfig();
  try {
    const checkUrl = state.client.isLocalOllama() ? `${config.baseUrl}/api/tags` : config.baseUrl;
    const response = await fetch(checkUrl, {
      headers: state.client.isLocalOllama()
        ? {}
        : {
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
          },
    });
    return response.ok;
  } catch {
    return false;
  }
}
