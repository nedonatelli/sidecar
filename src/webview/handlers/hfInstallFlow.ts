import { window, commands } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatState } from '../chatState.js';
import { getConfig, getHuggingFaceToken } from '../../config/settings.js';
import { probeModelToolSupport } from '../../ollama/ollamaBackend.js';
import {
  inspectHFRepo,
  formatSize,
  checkKnownGGUFIssues,
  type HFModelRef,
  type SafetensorsRepo,
} from '../../ollama/huggingface.js';
import { importSafetensorsModel, type ImportProgress, type Quantization } from '../../ollama/hfSafetensorsImport.js';
import { formatContextLength, loadModels } from './modelLoader.js';

const QUANT_OPTIONS: Array<{ label: Quantization; description: string; sizeMultiplier: number }> = [
  { label: 'q4_K_M', description: 'Recommended — ~4x smaller, minimal quality loss', sizeMultiplier: 0.3 },
  { label: 'q5_K_M', description: 'Slightly larger, slightly better quality', sizeMultiplier: 0.36 },
  { label: 'q6_K', description: 'Near-lossless quality, larger file', sizeMultiplier: 0.42 },
  { label: 'q8_0', description: 'Almost full quality, ~half the original size', sizeMultiplier: 0.55 },
  { label: 'f16', description: 'No quantization — full original weights', sizeMultiplier: 1.0 },
];

export interface HFInstallResult {
  shouldFallThroughToPull: boolean;
  pullName: string;
}

/**
 * Handle the HuggingFace-specific part of an install: classify the repo,
 * show any quick-pick UI, and either delegate to the safetensors import
 * flow (returning `shouldFallThroughToPull: false`) or return a resolved
 * `pullName` that the plain pull flow will consume.
 */
export async function handleHuggingFaceInstall(
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
          content: `Model installation cancelled. Try \`ollama pull gemma4:e4b\` from the terminal for the official library version.\n\n`,
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

async function runSafetensorsImport(
  state: ChatState,
  hfRef: HFModelRef,
  repo: SafetensorsRepo,
  hfToken: string | undefined,
): Promise<void> {
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
  await fs.promises.mkdir(stagingDir, { recursive: true });

  // Disk-space preflight: converters typically write a temp buffer roughly
  // the same size as the weights, so require 2x.
  try {
    const stat = await fs.promises.statfs(stagingDir);
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
    // `statfs` may fail on unusual filesystems — skip the preflight silently.
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
