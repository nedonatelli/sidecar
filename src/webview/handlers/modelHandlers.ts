import { window } from 'vscode';
import type { ChatState } from '../chatState.js';
import type { LibraryModelUI } from '../chatWebview.js';
import { getConfig } from '../../config/settings.js';
import { isProviderReachable } from '../../config/providerReachability.js';
import { modelSupportsTools, probeModelToolSupport, probeAllModelToolSupport } from '../../ollama/ollamaBackend.js';
import { parseHuggingFaceRef, listGGUFFiles, formatSize } from '../../ollama/huggingface.js';
import { surfaceProviderError } from '../errorSurface.js';

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

    const libraryModels = await state.client.listLibraryModels();

    // Probe installed models for tool support via Ollama's /api/show capabilities
    if (state.client.isLocalOllama()) {
      const installedNames = libraryModels.filter((m) => m.installed).map((m) => m.name);
      await probeAllModelToolSupport(config.baseUrl, installedNames);
    }

    const modelsUI: LibraryModelUI[] = libraryModels.map((m) => ({
      name: m.name,
      installed: m.installed,
      supportsTools: modelSupportsTools(m.name),
    }));

    state.postMessage({ command: 'setModels', models: modelsUI });
    const supportsTools = modelSupportsTools(config.model);
    state.postMessage({ command: 'setCurrentModel', currentModel: config.model, supportsTools });
  } catch (err) {
    console.error('Failed to load models:', err);
    const message = state.client.isLocalOllama()
      ? 'Cannot connect to Ollama. Make sure Ollama is running on localhost:11434.'
      : `Cannot connect to API at ${config.baseUrl}.`;
    state.postMessage({ command: 'error', content: message });
    void surfaceProviderError(message, 'connection');
  }
}

export async function handleInstallModel(state: ChatState, modelName: string): Promise<void> {
  // Detect HuggingFace URLs and convert to Ollama pull syntax
  let pullName = modelName;
  const hfRef = parseHuggingFaceRef(modelName);
  if (hfRef) {
    state.postMessage({
      command: 'assistantMessage',
      content: `Detected HuggingFace model: **${hfRef.org}/${hfRef.repo}**\nFetching available GGUF files...\n\n`,
    });

    const ggufFiles = await listGGUFFiles(hfRef);

    if (ggufFiles.length === 0) {
      // No GGUF files found — pull the repo directly (Ollama will pick the default)
      pullName = hfRef.ollamaName;
      state.postMessage({
        command: 'assistantMessage',
        content: `No GGUF files found — pulling \`${pullName}\` directly.\n\n`,
      });
    } else {
      // Show VS Code quick pick for quantization selection
      const items = ggufFiles.map((f) => ({
        label: f.filename,
        description: formatSize(f.size),
        detail: f.ollamaName,
      }));

      const picked = await window.showQuickPick(items, {
        placeHolder: `Select a GGUF quantization for ${hfRef.org}/${hfRef.repo} (${ggufFiles.length} files)`,
        title: 'HuggingFace Model — Choose Quantization',
      });

      if (!picked) {
        state.postMessage({
          command: 'assistantMessage',
          content: 'Model installation cancelled.\n\n',
        });
        return;
      }

      pullName = picked.detail!;
      state.postMessage({
        command: 'assistantMessage',
        content: `Installing **${picked.label}** (${picked.description})...\n\n`,
      });
    }
  }

  state.installAbortController = new AbortController();

  try {
    state.postMessage({
      command: 'installProgress',
      modelName: pullName,
      progress: 'Starting...',
    });

    for await (const progress of state.client.pullModel(pullName, state.installAbortController.signal)) {
      // Format progress message with percentage, size, and status
      let progressMessage = progress.status;

      if (progress.total && progress.completed !== undefined) {
        const percent = Math.round((progress.completed / progress.total) * 100);
        const completedMB = (progress.completed / 1024 / 1024).toFixed(1);
        const totalMB = (progress.total / 1024 / 1024).toFixed(1);
        const progressBar = `[${'█'.repeat(Math.round(percent / 5))}${'░'.repeat(20 - Math.round(percent / 5))}]`;
        progressMessage = `${progressBar} ${percent}% (${completedMB}MB / ${totalMB}MB) — ${progress.status}`;
      } else if (progress.total && progress.completed === undefined) {
        // Layer download starting
        const totalMB = (progress.total / 1024 / 1024).toFixed(1);
        progressMessage = `📥 ${progressMessage} (${totalMB}MB)`;
      }

      state.postMessage({
        command: 'installProgress',
        modelName: pullName,
        progress: progressMessage,
      });
    }

    state.client.updateModel(pullName);
    state.postMessage({ command: 'installComplete', modelName: pullName });

    // Give Ollama a moment to register the newly installed model
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Probe the newly installed model for tool support
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

    // Reload model list to show the newly installed model in dropdown
    await loadModels(state);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      state.postMessage({ command: 'installComplete', modelName: pullName });
      return;
    }
    state.postMessage({
      command: 'error',
      content: `Failed to install ${pullName}: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    state.installAbortController = null;
  }
}
