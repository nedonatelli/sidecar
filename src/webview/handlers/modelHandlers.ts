import { window } from 'vscode';
import type { ChatState } from '../chatState.js';
import { getConfig } from '../../config/settings.js';
import { probeModelToolSupport, deleteOllamaModel } from '../../ollama/ollamaBackend.js';
import { parseHuggingFaceRef } from '../../ollama/huggingface.js';
import {
  kickstandPullModel,
  normalizeHfRepo,
  kickstandLoadModel,
  kickstandListRegistry,
  kickstandUnloadModel,
} from '../../ollama/kickstandBackend.js';
import { loadModels } from './modelLoader.js';
import { handleHuggingFaceInstall } from './hfInstallFlow.js';

export { loadModels } from './modelLoader.js';

export async function handleInstallModel(state: ChatState, modelName: string): Promise<void> {
  // HuggingFace inspection + safetensors/GGUF classification only applies to
  // local Ollama. Other backends have their own management APIs.
  if (state.client.isLocalOllama()) {
    let pullName = modelName;
    const hfRef = parseHuggingFaceRef(modelName);

    if (hfRef) {
      const handled = await handleHuggingFaceInstall(state, hfRef, modelName);
      if (!handled.shouldFallThroughToPull) return;
      pullName = handled.pullName;
    }

    await runOllamaPull(state, pullName);
    return;
  }

  // Kickstand: pull from HuggingFace via Kickstand's API, then load into GPU.
  if (state.client.getProviderType() === 'kickstand') {
    await runKickstandInstall(state, modelName);
    return;
  }

  // Other non-Ollama backends: pass the model name directly.
  state.client.updateModel(modelName);
  state.postMessage({ command: 'setCurrentModel', currentModel: modelName });
  await loadModels(state);
}

async function verifyModelLoads(baseUrl: string, model: string): Promise<string | null> {
  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: '30s' }),
      signal: AbortSignal.timeout(30000),
    });
    if (response.ok) return null;

    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* use status line */
    }

    if (response.status === 500 && detail.includes('unable to load model')) {
      return (
        `Ollama pulled the model successfully but cannot load it: ${detail}\n\n` +
        'This usually means the GGUF was built with a model architecture that ' +
        "Ollama's engine doesn't fully support for HuggingFace imports yet. " +
        'Check if an official Ollama library version exists (e.g. `ollama pull gemma4:e4b`).'
      );
    }
    return `Model verification failed: ${detail}`;
  } catch {
    return null;
  }
}

async function runKickstandInstall(state: ChatState, modelName: string): Promise<void> {
  const config = getConfig();
  const baseUrl = config.baseUrl;

  try {
    const registry = await kickstandListRegistry(baseUrl);
    const existing = registry.find((m) => m.model_id === modelName || m.hf_repo === modelName);
    if (existing && existing.status === 'ready') {
      if (existing.loaded) {
        state.postMessage({
          command: 'assistantMessage',
          content: `**${existing.model_id}** is already loaded and ready to use.\n\n`,
        });
        state.client.updateModel(existing.model_id);
        state.postMessage({ command: 'setCurrentModel', currentModel: existing.model_id });
        return;
      }
      state.postMessage({
        command: 'assistantMessage',
        content: `**${existing.model_id}** is downloaded. Loading into GPU...\n\n`,
      });
      try {
        await kickstandLoadModel(baseUrl, existing.model_id);
        state.client.updateModel(existing.model_id);
        state.postMessage({ command: 'setCurrentModel', currentModel: existing.model_id });
        state.postMessage({
          command: 'assistantMessage',
          content: `**${existing.model_id}** loaded successfully.\n\n`,
        });
      } catch (err) {
        state.postMessage({
          command: 'error',
          content: `Failed to load ${existing.model_id}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      await loadModels(state);
      return;
    }
  } catch {
    // Registry unreachable — fall through to pull
  }

  const parts = normalizeHfRepo(modelName).split('/');
  let repo: string;
  let filename: string | undefined;
  if (parts.length >= 3) {
    repo = `${parts[0]}/${parts[1]}`;
    filename = parts.slice(2).join('/');
  } else {
    repo = normalizeHfRepo(modelName);
  }

  state.postMessage({
    command: 'assistantMessage',
    content: `Pulling **${modelName}** via Kickstand...\n\n`,
  });
  state.postMessage({ command: 'installProgress', modelName, progress: 'Starting pull...' });

  state.installAbortController = new AbortController();

  try {
    let modelId = modelName;

    for await (const event of kickstandPullModel(
      baseUrl,
      repo,
      filename,
      undefined,
      state.installAbortController.signal,
    )) {
      if (event.status === 'downloading') {
        state.postMessage({
          command: 'installProgress',
          modelName,
          progress: `Downloading ${event.format ?? ''} from ${event.repo ?? repo}...`,
        });
      } else if (event.status === 'progress') {
        const doneMB = (((event.bytes_done ?? 0) / 1024 / 1024) | 0).toString();
        const totalMB = event.bytes_total ? ((event.bytes_total / 1024 / 1024) | 0).toString() : '?';
        state.postMessage({
          command: 'installProgress',
          modelName,
          progress: `${doneMB} MB / ${totalMB} MB`,
          percent: event.percent ?? 0,
        });
      } else if (event.status === 'done') {
        state.postMessage({ command: 'installProgress', modelName, progress: 'Download complete.' });
        if (event.local_path) {
          const registry = await kickstandListRegistry(baseUrl);
          const pulled = registry.find((m) => m.local_path === event.local_path);
          if (pulled) modelId = pulled.model_id;
        }
      } else if (event.status === 'error') {
        state.postMessage({ command: 'installComplete', modelName });
        state.postMessage({
          command: 'error',
          content: `Kickstand pull failed: ${event.message ?? 'unknown error'}`,
        });
        return;
      }
    }

    if (state.installAbortController?.signal.aborted) {
      state.postMessage({ command: 'installComplete', modelName });
      return;
    }

    state.postMessage({ command: 'installProgress', modelName, progress: 'Loading model into GPU...' });
    try {
      await kickstandLoadModel(baseUrl, modelId);
    } catch (err) {
      state.postMessage({ command: 'installComplete', modelName });
      state.postMessage({
        command: 'assistantMessage',
        content: `**Warning:** Model pulled successfully but failed to load: ${err instanceof Error ? err.message : String(err)}\n\nThe model is downloaded — you can try loading it manually.\n\n`,
      });
      await loadModels(state);
      return;
    }

    state.client.updateModel(modelId);
    state.postMessage({ command: 'installComplete', modelName: modelId });
    state.postMessage({ command: 'setCurrentModel', currentModel: modelId });
    state.postMessage({
      command: 'assistantMessage',
      content: `**${modelId}** installed and loaded.\n\n`,
    });
    await loadModels(state);
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.message === 'Aborted')) {
      state.postMessage({ command: 'installComplete', modelName });
      return;
    }
    state.postMessage({ command: 'installComplete', modelName });
    state.postMessage({
      command: 'error',
      content: `Failed to install ${modelName}: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    state.installAbortController = null;
  }
}

export async function handleKickstandLoadModel(state: ChatState, modelId: string): Promise<void> {
  state.postMessage({ command: 'assistantMessage', content: `Loading **${modelId}** into GPU...\n\n` });
  try {
    const caps = state.client.getBackendCapabilities();
    const summary = await caps?.lifecycle?.loadModel(modelId);
    state.client.updateModel(modelId);
    state.postMessage({ command: 'setCurrentModel', currentModel: modelId });
    state.postMessage({ command: 'assistantMessage', content: `**${summary ?? `${modelId} loaded`}**\n\n` });
  } catch (err) {
    state.postMessage({
      command: 'error',
      content: `Failed to load ${modelId}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  await loadModels(state);
}

export async function handleKickstandUnloadModel(state: ChatState, modelId: string): Promise<void> {
  const config = getConfig();
  state.postMessage({ command: 'assistantMessage', content: `Unloading **${modelId}**...\n\n` });
  try {
    await kickstandUnloadModel(config.baseUrl, modelId);
    state.postMessage({ command: 'assistantMessage', content: `**${modelId}** unloaded.\n\n` });
  } catch (err) {
    state.postMessage({
      command: 'error',
      content: `Failed to unload ${modelId}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  await loadModels(state);
}

async function runOllamaPull(state: ChatState, pullName: string): Promise<void> {
  state.installAbortController = new AbortController();

  try {
    state.postMessage({
      command: 'installProgress',
      modelName: pullName,
      progress: 'Starting...',
    });

    for await (const progress of state.client.pullModel(pullName, state.installAbortController.signal)) {
      let progressMessage = progress.status;

      if (progress.total && progress.completed !== undefined) {
        const percent = Math.round((progress.completed / progress.total) * 100);
        const completedMB = (progress.completed / 1024 / 1024).toFixed(1);
        const totalMB = (progress.total / 1024 / 1024).toFixed(1);
        const progressBar = `[${'█'.repeat(Math.round(percent / 5))}${'░'.repeat(20 - Math.round(percent / 5))}]`;
        progressMessage = `${progressBar} ${percent}% (${completedMB}MB / ${totalMB}MB) — ${progress.status}`;
      } else if (progress.total && progress.completed === undefined) {
        const totalMB = (progress.total / 1024 / 1024).toFixed(1);
        progressMessage = `📥 ${progressMessage} (${totalMB}MB)`;
      }

      state.postMessage({
        command: 'installProgress',
        modelName: pullName,
        progress: progressMessage,
      });
    }

    state.postMessage({ command: 'installProgress', modelName: pullName, progress: 'Verifying model loads...' });

    if (state.client.isLocalOllama()) {
      const loadError = await verifyModelLoads(getConfig().baseUrl, pullName);
      if (loadError) {
        state.postMessage({ command: 'installComplete', modelName: pullName });
        state.postMessage({
          command: 'assistantMessage',
          content: `**Warning:** ${loadError}\n\n`,
        });
        return;
      }
    }

    state.client.updateModel(pullName);
    state.postMessage({ command: 'installComplete', modelName: pullName });

    await new Promise((resolve) => setTimeout(resolve, 500));

    if (state.client.isLocalOllama()) {
      const hasTools = await probeModelToolSupport(getConfig().baseUrl, pullName);
      if (!hasTools) {
        state.postMessage({
          command: 'assistantMessage',
          content: `ℹ️ **${pullName}** does not support tool use. You can use it for chat, code explanation, and refactoring suggestions — but agent mode (autonomous code changes) won't be available with this model.\n\n`,
        });
      }
    }

    state.postMessage({ command: 'setCurrentModel', currentModel: pullName });
    await loadModels(state);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      state.postMessage({ command: 'installComplete', modelName: pullName });
      return;
    }
    state.postMessage({ command: 'installComplete', modelName: pullName });
    state.postMessage({
      command: 'error',
      content: `Failed to install ${pullName}: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    state.installAbortController = null;
  }
}

export async function handleDeleteModel(state: ChatState, modelName: string): Promise<void> {
  if (!state.client.isLocalOllama()) return;

  const confirm = await window.showWarningMessage(
    `Delete model "${modelName}" from Ollama? This cannot be undone.`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') return;

  const config = getConfig();
  try {
    await deleteOllamaModel(config.baseUrl, modelName);
    await loadModels(state);
  } catch (err) {
    state.postMessage({
      command: 'error',
      content: `Failed to delete ${modelName}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/** @deprecated Use `modelSupportsTools` from ollamaBackend directly. Re-exported for test backward compat. */
export { modelSupportsTools } from '../../ollama/ollamaBackend.js';
