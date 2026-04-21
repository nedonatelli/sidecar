import { window, commands } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatState } from '../chatState.js';
import type { LibraryModelUI } from '../chatWebview.js';
import { getConfig, getHuggingFaceToken } from '../../config/settings.js';
import { isProviderReachable } from '../../config/providerReachability.js';
import { modelSupportsTools, probeModelToolSupport, probeAllModelToolSupport } from '../../ollama/ollamaBackend.js';
import {
  parseHuggingFaceRef,
  inspectHFRepo,
  formatSize,
  checkKnownGGUFIssues,
  type HFModelRef,
  type SafetensorsRepo,
} from '../../ollama/huggingface.js';
import { importSafetensorsModel, type ImportProgress, type Quantization } from '../../ollama/hfSafetensorsImport.js';
import {
  kickstandPullModel,
  normalizeHfRepo,
  kickstandLoadModel,
  kickstandListRegistry,
  kickstandUnloadModel,
} from '../../ollama/kickstandBackend.js';
import { surfaceProviderError } from '../errorSurface.js';

function formatContextLength(n: number): string {
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

    // The chat UX should only surface models the backend can actually
    // run *right now*, so we ask for the installed-only view. The
    // `sidecar.selectModel` command palette picker still uses the
    // default (with suggestions) for new-user discovery.
    const libraryModels = await state.client.listLibraryModels({ includeSuggestions: false });

    // Probe installed models for tool support via Ollama's /api/show capabilities
    if (state.client.isLocalOllama()) {
      const installedNames = libraryModels.filter((m) => m.installed).map((m) => m.name);
      await probeAllModelToolSupport(config.baseUrl, installedNames);
    }

    const modelsUI: LibraryModelUI[] = libraryModels.map((m) => ({
      name: m.name,
      installed: m.installed,
      supportsTools: modelSupportsTools(m.name),
      contextLength: m.contextLength ?? null,
    }));

    state.postMessage({ command: 'setModels', models: modelsUI });

    // Reconcile the persisted model against what's actually installed.
    // If `config.model` is stale — e.g. the user typed an HF-style name
    // into the custom-model input before v0.55 and got it saved without
    // a matching pull — every chat turn will 404 until they manually
    // fix it. We don't overwrite the setting silently (a transient
    // Ollama outage would clobber the user's real preference), but we
    // warn loudly in the chat so the stale state is visible.
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

/** Quantization options shown in the quick-pick for safetensors imports. */
const QUANT_OPTIONS: Array<{ label: Quantization; description: string; sizeMultiplier: number }> = [
  { label: 'q4_K_M', description: 'Recommended — ~4x smaller, minimal quality loss', sizeMultiplier: 0.3 },
  { label: 'q5_K_M', description: 'Slightly larger, slightly better quality', sizeMultiplier: 0.36 },
  { label: 'q6_K', description: 'Near-lossless quality, larger file', sizeMultiplier: 0.42 },
  { label: 'q8_0', description: 'Almost full quality, ~half the original size', sizeMultiplier: 0.55 },
  { label: 'f16', description: 'No quantization — full original weights', sizeMultiplier: 1.0 },
];

export async function handleInstallModel(state: ChatState, modelName: string): Promise<void> {
  // The HuggingFace inspection + safetensors/GGUF classification flow
  // only applies to local Ollama. Other backends (Kickstand, Anthropic,
  // OpenRouter, etc.) have their own model management and don't need
  // HF repo analysis — just pass the name through to the pull/load API.
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

  // Kickstand backend: pull from HuggingFace via Kickstand's own API,
  // then load the model into GPU memory.
  if (state.client.getProviderType() === 'kickstand') {
    await runKickstandInstall(state, modelName);
    return;
  }

  // Other non-Ollama backends: just pass the model name to the client directly.
  state.client.updateModel(modelName);
  state.postMessage({ command: 'setCurrentModel', currentModel: modelName });
  await loadModels(state);
}

interface HFInstallResult {
  shouldFallThroughToPull: boolean;
  pullName: string;
}

/**
 * Handle the HuggingFace-specific part of an install: classify the repo,
 * show any quick-pick UI, and either delegate to the safetensors import
 * flow (returning `shouldFallThroughToPull: false`) or return a resolved
 * `pullName` that the plain pull flow will consume.
 */
async function handleHuggingFaceInstall(
  state: ChatState,
  hfRef: HFModelRef,
  originalInput: string,
): Promise<HFInstallResult> {
  state.postMessage({
    command: 'assistantMessage',
    content: hfRef.isExplicit
      ? `Detected HuggingFace model: **${hfRef.org}/${hfRef.repo}**\nInspecting repo...\n\n`
      : `Checking if **${hfRef.org}/${hfRef.repo}** is a HuggingFace model...\n\n`,
  });

  let hfToken = await getHuggingFaceToken();
  let inspection = await inspectHFRepo(hfRef, { hfToken });

  // If the repo is gated and we don't have a token yet, the first inspection
  // bails out early (HF's raw config.json endpoint 401s without auth).
  // Prompt for a token and re-run the classifier once — if the user sets
  // one, we'll continue normally; if not, we cancel.
  if (inspection.kind === 'gated-auth-required') {
    const granted = await promptForHuggingFaceToken(state, hfRef);
    if (!granted) {
      return { shouldFallThroughToPull: false, pullName: '' };
    }
    hfToken = await getHuggingFaceToken();
    inspection = await inspectHFRepo(hfRef, { hfToken });
  }

  if (inspection.kind === 'not-found') {
    // Bare `org/repo` input that HF doesn't know — could be a legit
    // Ollama community model like `hhao/qwen2.5-coder`. Fall through
    // to a plain pull with the user's original string.
    if (!hfRef.isExplicit) {
      state.postMessage({
        command: 'assistantMessage',
        content: `Not on HuggingFace — trying Ollama registry for **${originalInput}**...\n\n`,
      });
      return { shouldFallThroughToPull: true, pullName: originalInput };
    }
    state.postMessage({
      command: 'assistantMessage',
      content: `**Error:** Repository \`${hfRef.org}/${hfRef.repo}\` was not found on HuggingFace. Double-check the org and repo name — a typo or a model that hasn't been published yet will both land here.\n\n`,
    });
    return { shouldFallThroughToPull: false, pullName: '' };
  }

  if (inspection.kind === 'network-error') {
    state.postMessage({
      command: 'assistantMessage',
      content: `**Error:** Couldn't reach the HuggingFace API (${inspection.message}). Check your internet connection and try again.\n\n`,
    });
    return { shouldFallThroughToPull: false, pullName: '' };
  }

  if (inspection.kind === 'no-weights') {
    state.postMessage({
      command: 'assistantMessage',
      content: `**Error:** \`${hfRef.org}/${hfRef.repo}\` publishes no weight files SideCar knows how to install (no \`.gguf\` or \`.safetensors\`). If this is a PyTorch-only repo, look for a community mirror like \`bartowski/${hfRef.repo}-GGUF\`.\n\n`,
    });
    return { shouldFallThroughToPull: false, pullName: '' };
  }

  if (inspection.kind === 'unsupported-arch') {
    state.postMessage({
      command: 'assistantMessage',
      content: `**Error:** \`${hfRef.org}/${hfRef.repo}\` uses architecture \`${inspection.architecture}\`, which llama.cpp's GGUF converter doesn't support yet. Look for a community GGUF conversion — e.g. \`bartowski/${hfRef.repo}-GGUF\` or \`unsloth/${hfRef.repo}-GGUF\` — and try again with that URL.\n\n`,
    });
    return { shouldFallThroughToPull: false, pullName: '' };
  }

  if (inspection.kind === 'gated-auth-required') {
    // User declined to set a token, or the follow-up inspection still
    // returned gated — either way, we can't proceed.
    state.postMessage({
      command: 'assistantMessage',
      content: `**Error:** \`${hfRef.org}/${hfRef.repo}\` is gated and requires a HuggingFace access token. Run **SideCar: Set / Clear HuggingFace Token** and try again.\n\n`,
    });
    return { shouldFallThroughToPull: false, pullName: '' };
  }

  if (inspection.kind === 'gguf') {
    const ggufWarning = checkKnownGGUFIssues(hfRef.repo);
    if (ggufWarning) {
      const choice = await window.showWarningMessage(
        `${hfRef.org}/${hfRef.repo} may not load in Ollama after pulling.`,
        { modal: true, detail: ggufWarning },
        'Pull Anyway',
        'Cancel',
      );
      if (choice !== 'Pull Anyway') {
        state.postMessage({
          command: 'assistantMessage',
          content: `Model installation cancelled. Try \`ollama pull qwen3.5\` from the terminal for the official library version.\n\n`,
        });
        return { shouldFallThroughToPull: false, pullName: '' };
      }
    }

    const pullName = await pickGGUFFile(state, hfRef, inspection.files, inspection.contextLength);
    if (pullName === null) {
      return { shouldFallThroughToPull: false, pullName: '' };
    }
    return { shouldFallThroughToPull: true, pullName };
  }

  // inspection.kind === 'safetensors' — run the convert-and-import flow.
  await runSafetensorsImport(state, hfRef, inspection.repo, hfToken);
  return { shouldFallThroughToPull: false, pullName: '' };
}

/**
 * Show a modal prompt explaining the repo is gated and launch the
 * `sidecar.setHuggingFaceToken` command if the user agrees. Returns true
 * if a token is now present in SecretStorage, false if the user cancelled
 * or didn't actually enter one.
 */
async function promptForHuggingFaceToken(state: ChatState, hfRef: HFModelRef): Promise<boolean> {
  const choice = await window.showWarningMessage(
    `${hfRef.org}/${hfRef.repo} is a gated model. SideCar needs a HuggingFace access token to download it.`,
    { modal: true, detail: 'Get one at https://huggingface.co/settings/tokens (read access is enough).' },
    'Set Token',
    'Cancel',
  );
  if (choice !== 'Set Token') {
    state.postMessage({ command: 'assistantMessage', content: 'Model installation cancelled.\n\n' });
    return false;
  }
  await commands.executeCommand('sidecar.setHuggingFaceToken');
  const token = await getHuggingFaceToken();
  return Boolean(token);
}

/**
 * Show a quick-pick for GGUF quantizations, stream a confirmation message,
 * and return the resolved Ollama pull name. Returns null if the user cancels.
 */
async function pickGGUFFile(
  state: ChatState,
  hfRef: HFModelRef,
  files: Array<{ filename: string; size: number; ollamaName: string }>,
  contextLength: number | null,
): Promise<string | null> {
  const ctxSuffix = contextLength ? ` · ${formatContextLength(contextLength)}` : '';
  const items = files.map((f) => ({
    label: f.filename,
    description: `${formatSize(f.size)}${ctxSuffix}`,
    detail: f.ollamaName,
  }));

  const picked = await window.showQuickPick(items, {
    placeHolder: `Select a GGUF quantization for ${hfRef.org}/${hfRef.repo} (${files.length} files)`,
    title: 'HuggingFace Model — Choose Quantization',
  });

  if (!picked) {
    state.postMessage({ command: 'assistantMessage', content: 'Model installation cancelled.\n\n' });
    return null;
  }

  state.postMessage({
    command: 'assistantMessage',
    content: `Installing **${picked.label}** (${picked.description})...\n\n`,
  });
  return picked.detail!;
}

/**
 * Run the full safetensors → GGUF import flow: pick a quantization,
 * download the weights, shell out to `ollama create`, and reload the
 * model list at the end. The caller (`handleHuggingFaceInstall`) has
 * already resolved any gated-repo token prompts before we get here.
 */
async function runSafetensorsImport(
  state: ChatState,
  hfRef: HFModelRef,
  repo: SafetensorsRepo,
  hfToken: string | undefined,
): Promise<void> {
  // Pick a quantization. Show the estimated final size so the user can
  // pick between "small and fast" and "full-fidelity but huge".
  const ctxSuffix = repo.contextLength ? ` · ${formatContextLength(repo.contextLength)}` : '';
  const quantItems = QUANT_OPTIONS.map((q) => ({
    label: q.label,
    description: `~${formatSize(repo.totalBytes * q.sizeMultiplier)} final size${ctxSuffix}`,
    detail: q.description,
    quant: q.label,
  }));
  const pickedQuant = await window.showQuickPick(quantItems, {
    placeHolder: `Choose a quantization for ${hfRef.org}/${hfRef.repo} (${formatSize(repo.totalBytes)} download)`,
    title: 'HuggingFace Safetensors — Choose Quantization',
  });
  if (!pickedQuant) {
    state.postMessage({ command: 'assistantMessage', content: 'Model installation cancelled.\n\n' });
    return;
  }

  // Stage directory lives under globalStorage so it survives workspace
  // switches but isn't committed to any project. Uses the extension's
  // own storage space per the "don't use .sidecar/ for generated state" rule.
  const stagingDir = path.join(state.context.globalStorageUri.fsPath, 'hf-imports', `${hfRef.org}__${hfRef.repo}`);
  fs.mkdirSync(stagingDir, { recursive: true });

  // Disk-space preflight: converters typically write a temp buffer roughly
  // the same size as the weights, so require 2x. Fail loudly rather than
  // crashing mid-convert.
  try {
    const stat = fs.statfsSync(stagingDir);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const requiredBytes = repo.totalBytes * 2;
    if (freeBytes < requiredBytes) {
      state.postMessage({
        command: 'assistantMessage',
        content: `**Error:** Not enough free disk space. Need ~${formatSize(requiredBytes)}, have ${formatSize(freeBytes)} available in ${stagingDir}. Free some space and try again.\n\n`,
      });
      return;
    }
  } catch {
    // `statfs` is Node 18.15+ but may fail on unusual filesystems — skip
    // the preflight silently rather than blocking the install.
  }

  state.postMessage({
    command: 'assistantMessage',
    content: `Downloading **${hfRef.org}/${hfRef.repo}** (${formatSize(repo.totalBytes)}) and converting to GGUF with quantization \`${pickedQuant.quant}\`. This can take 5–30 minutes depending on model size and hardware.\n\n`,
  });

  state.installAbortController = new AbortController();
  const ollamaName = `hf.co/${hfRef.org}/${hfRef.repo}`;

  try {
    state.postMessage({ command: 'installProgress', modelName: ollamaName, progress: 'Preparing download...' });

    for await (const event of importSafetensorsModel({
      ref: hfRef,
      repo,
      quantization: pickedQuant.quant,
      hfToken,
      stagingDir,
      ollamaName,
      signal: state.installAbortController.signal,
    })) {
      state.postMessage({
        command: 'installProgress',
        modelName: ollamaName,
        progress: renderImportProgress(event),
      });
    }

    state.client.updateModel(ollamaName);
    state.postMessage({ command: 'installComplete', modelName: ollamaName });

    await new Promise((resolve) => setTimeout(resolve, 500));

    if (state.client.isLocalOllama()) {
      const hasTools = await probeModelToolSupport(getConfig().baseUrl, ollamaName);
      if (!hasTools) {
        state.postMessage({
          command: 'assistantMessage',
          content: `ℹ️ **${ollamaName}** does not support tool use. You can use it for chat, code explanation, and refactoring suggestions — but agent mode (autonomous code changes) won't be available with this model.\n\n`,
        });
      }
    }

    state.postMessage({ command: 'setCurrentModel', currentModel: ollamaName });
    await loadModels(state);
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.message === 'Aborted')) {
      state.postMessage({ command: 'installComplete', modelName: ollamaName });
      state.postMessage({
        command: 'assistantMessage',
        content: `Install cancelled. Partially downloaded files are kept in \`${stagingDir}\` so a retry can resume where you left off.\n\n`,
      });
      return;
    }
    state.postMessage({
      command: 'error',
      content: `Failed to install ${ollamaName}: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    state.installAbortController = null;
  }
}

/** Render an ImportProgress event as a single-line progress string for the webview. */
function renderImportProgress(event: ImportProgress): string {
  switch (event.phase) {
    case 'download': {
      const { overallCompleted, overallTotal, file } = event;
      const percent = overallTotal > 0 ? Math.round((overallCompleted / overallTotal) * 100) : 0;
      const bar = `[${'█'.repeat(Math.round(percent / 5))}${'░'.repeat(20 - Math.round(percent / 5))}]`;
      const completedGB = (overallCompleted / 1024 / 1024 / 1024).toFixed(2);
      const totalGB = (overallTotal / 1024 / 1024 / 1024).toFixed(2);
      const shortFile = file.split('/').pop() ?? file;
      return `${bar} ${percent}% (${completedGB}GB / ${totalGB}GB) — downloading ${shortFile}`;
    }
    case 'convert':
      return `Converting to GGUF — ${event.line}`;
    case 'cleanup':
      return 'Cleaning up staging files...';
    case 'done':
      return 'Installed.';
  }
}

/**
 * Try to load a model into Ollama's inference engine. Returns null on success
 * or an error message string if the model fails to load (e.g. unsupported
 * architecture in HF-sourced GGUFs). This catches the class of bugs where
 * `ollama pull` succeeds but the model can't actually run.
 */
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
        'Check if an official Ollama library version exists (e.g. `ollama pull qwen3.5`).'
      );
    }
    return `Model verification failed: ${detail}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Kickstand install (pull + load)
// ---------------------------------------------------------------------------

/**
 * Install a model via Kickstand: pull from HuggingFace, then load into GPU.
 *
 * The input can be:
 * - A bare HF repo (`google/gemma-4-26B-A4B`) — Kickstand treats it as an MLX pull
 * - A repo + GGUF filename (`Qwen/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q4_k_m.gguf`)
 * - Just a repo name for a GGUF repo — we let the user pick a file
 */
async function runKickstandInstall(state: ChatState, modelName: string): Promise<void> {
  const config = getConfig();
  const baseUrl = config.baseUrl;

  // Check if the model is already in the registry
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
      // Model downloaded but not loaded — load it
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

  // Pull the model from HuggingFace via Kickstand
  // Parse repo vs repo/filename — strip full HF URLs first
  const parts = normalizeHfRepo(modelName).split('/');
  let repo: string;
  let filename: string | undefined;
  if (parts.length >= 3) {
    // e.g. "Qwen/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q4_k_m.gguf"
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
        // The local_path tells us the model_id for loading
        if (event.local_path) {
          // Re-read registry to find the model_id
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

    // Stream may close cleanly when aborted (done: true) rather than throwing AbortError
    if (state.installAbortController?.signal.aborted) {
      state.postMessage({ command: 'installComplete', modelName });
      return;
    }

    // Auto-load after successful pull
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

/**
 * Load or unload a Kickstand model from the chat UI.
 * Exported so webview message handlers can call them directly.
 */
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

// ---------------------------------------------------------------------------
// Ollama pull
// ---------------------------------------------------------------------------

/**
 * Run `ollama pull` against a resolved pull name. This is the plain-vanilla
 * path used for both direct Ollama library models and GGUF HuggingFace repos
 * (after `pickGGUFFile` has resolved the user's quantization choice).
 */
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
