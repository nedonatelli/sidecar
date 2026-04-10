import { window } from 'vscode';
import type { ChatState } from '../chatState.js';
import type { LibraryModelUI } from '../chatWebview.js';
import { getConfig } from '../../config/settings.js';
import { modelSupportsTools } from '../../ollama/ollamaBackend.js';
import { parseHuggingFaceRef, listGGUFFiles, formatSize } from '../../ollama/huggingface.js';

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
      supportsTools: modelSupportsTools(m.name),
    }));

    state.postMessage({ command: 'setModels', models: modelsUI });
    const supportsTools = modelSupportsTools(config.model);
    state.postMessage({ command: 'setCurrentModel', currentModel: config.model, supportsTools });
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

  // Check if model supports tool use (required for agent mode)
  const supportsTools = modelSupportsTools(pullName);
  if (!supportsTools) {
    const proceed = await window.showWarningMessage(
      `⚠️ "${pullName}" does not support tool use. SideCar's agent mode requires tool-calling capabilities for autonomous code execution (file read/write, shell commands, etc). This model will only work in chat-only mode.\n\nDo you want to continue?`,
      'Yes, Download Anyway',
      'Cancel',
    );

    if (proceed !== 'Yes, Download Anyway') {
      state.postMessage({
        command: 'assistantMessage',
        content: `Model download cancelled. Tip: Look for models like qwen3-coder, llama3.1, command-r, or claude models that support tool use.\n\n`,
      });
      return;
    }

    state.postMessage({
      command: 'assistantMessage',
      content: `ℹ️ Proceeding with chat-only model. You can still use SideCar for code explanation, refactoring suggestions, and chat — but agent mode (autonomous code changes) won't be available.\n\n`,
    });
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
    state.postMessage({ command: 'setCurrentModel', currentModel: pullName });

    // Give Ollama a moment to register the newly installed model
    await new Promise((resolve) => setTimeout(resolve, 500));

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

async function ensureReachable(state: ChatState): Promise<boolean> {
  const config = getConfig();
  const provider = state.client.getProviderType();
  try {
    let checkUrl: string;
    const headers: Record<string, string> = {};

    switch (provider) {
      case 'ollama':
        checkUrl = `${config.baseUrl}/api/tags`;
        break;
      case 'anthropic':
        checkUrl = config.baseUrl;
        headers['x-api-key'] = config.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        break;
      case 'llmmanager':
        checkUrl = `${config.baseUrl}/v1/models`;
        headers['Authorization'] = `Bearer ${config.apiKey}`;
        break;
      case 'openai':
        checkUrl = `${config.baseUrl}/v1/models`;
        if (config.apiKey && config.apiKey !== 'ollama') {
          headers['Authorization'] = `Bearer ${config.apiKey}`;
        }
        break;
    }

    const response = await fetch(checkUrl, { headers });
    return response.ok;
  } catch {
    return false;
  }
}
