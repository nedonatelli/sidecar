import * as vscode from 'vscode';
import type { SideCarClient } from '../ollama/client.js';

/**
 * Command-palette actions for backend-native capabilities (v0.63.1).
 *
 * Today this covers Kickstand's lifecycle endpoints — `load` and
 * `unload` — so users can hot-swap which model is loaded without
 * leaving VS Code. The handlers read the active backend's
 * `BackendCapabilities` via `SideCarClient.getBackendCapabilities()`
 * and gate on the lifecycle surface being advertised. Backends
 * without lifecycle (Ollama, Anthropic, OpenAI, etc.) show a clear
 * "not supported" notice instead of a silent failure.
 *
 * v0.64 will surface these same capabilities in a chat-UI model
 * browser; until then command-palette is the only entry point.
 */

/**
 * Register all backend-native command handlers with the VS Code
 * extension host. Called from `extension.ts` on activation alongside
 * the other command registrations.
 */
export function registerBackendCommands(context: vscode.ExtensionContext, getClient: () => SideCarClient): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sidecar.kickstand.loadModel', () => runLoadModel(getClient())),
    vscode.commands.registerCommand('sidecar.kickstand.unloadModel', () => runUnloadModel(getClient())),
    vscode.commands.registerCommand('sidecar.kickstand.loadAdapter', () => runLoadAdapter(getClient())),
    vscode.commands.registerCommand('sidecar.kickstand.unloadAdapter', () => runUnloadAdapter(getClient())),
    vscode.commands.registerCommand('sidecar.modelBrowser', () => runModelBrowser(getClient())),
  );
}

async function runLoadModel(client: SideCarClient): Promise<void> {
  const caps = client.getBackendCapabilities();
  if (!caps?.lifecycle) {
    vscode.window.showInformationMessage(
      'Active backend does not support model lifecycle commands. Switch to Kickstand to load or unload models.',
    );
    return;
  }

  const modelId = await pickModelId(caps.lifecycle, 'load');
  if (!modelId) return; // user cancelled

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Loading ${modelId}…`,
      cancellable: false,
    },
    async () => {
      try {
        const summary = await caps.lifecycle!.loadModel(modelId);
        vscode.window.showInformationMessage(summary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to load ${modelId}: ${msg}`);
      }
    },
  );
}

async function runUnloadModel(client: SideCarClient): Promise<void> {
  const caps = client.getBackendCapabilities();
  if (!caps?.lifecycle) {
    vscode.window.showInformationMessage(
      'Active backend does not support model lifecycle commands. Switch to Kickstand to load or unload models.',
    );
    return;
  }

  const modelId = await pickModelId(caps.lifecycle, 'unload');
  if (!modelId) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Unloading ${modelId}…`,
      cancellable: false,
    },
    async () => {
      try {
        const summary = await caps.lifecycle!.unloadModel(modelId);
        vscode.window.showInformationMessage(summary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to unload ${modelId}: ${msg}`);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// LoRA adapter commands (v0.65.2)
// ---------------------------------------------------------------------------

async function runLoadAdapter(client: SideCarClient): Promise<void> {
  const caps = client.getBackendCapabilities();
  if (!caps?.loraAdapters || !caps?.lifecycle) {
    vscode.window.showInformationMessage(
      'Active backend does not support LoRA adapters. Switch to Kickstand with a loaded model.',
    );
    return;
  }

  // Pick a loaded model first
  const modelId = await pickModelId(caps.lifecycle, 'unload'); // 'unload' filter = loaded models
  if (!modelId) return;

  // Ask for adapter path
  const adapterPath = await vscode.window.showInputBox({
    prompt: 'Path to LoRA adapter file (GGUF)',
    placeHolder: '/path/to/adapter.gguf',
    validateInput: (v) => (v.trim().length === 0 ? 'Path cannot be empty' : undefined),
  });
  if (!adapterPath) return;

  const scaleStr = await vscode.window.showInputBox({
    prompt: 'Adapter scale (0.0–2.0)',
    value: '1.0',
    validateInput: (v) => {
      const n = parseFloat(v);
      return isNaN(n) || n < 0 || n > 2 ? 'Enter a number between 0 and 2' : undefined;
    },
  });
  if (!scaleStr) return;
  const scale = parseFloat(scaleStr);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Loading LoRA adapter…`, cancellable: false },
    async () => {
      try {
        const summary = await caps.loraAdapters!.loadAdapter(modelId, adapterPath, scale);
        vscode.window.showInformationMessage(summary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to load adapter: ${msg}`);
      }
    },
  );
}

async function runUnloadAdapter(client: SideCarClient): Promise<void> {
  const caps = client.getBackendCapabilities();
  if (!caps?.loraAdapters || !caps?.lifecycle) {
    vscode.window.showInformationMessage('Active backend does not support LoRA adapters.');
    return;
  }

  // Pick a loaded model
  const modelId = await pickModelId(caps.lifecycle, 'unload');
  if (!modelId) return;

  // List adapters on that model
  try {
    const adapters = await caps.loraAdapters.listAdapters(modelId);
    if (adapters.length === 0) {
      vscode.window.showInformationMessage(`No LoRA adapters loaded on ${modelId}.`);
      return;
    }

    const pick = await vscode.window.showQuickPick(
      adapters.map((a) => ({
        label: a.id,
        description: `scale: ${a.scale}`,
        detail: a.path,
      })),
      { placeHolder: 'Select adapter to unload' },
    );
    if (!pick) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Unloading LoRA ${pick.label}…`, cancellable: false },
      async () => {
        try {
          const summary = await caps.loraAdapters!.unloadAdapter(modelId, pick.label);
          vscode.window.showInformationMessage(summary);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Failed to unload adapter: ${msg}`);
        }
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to list adapters: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Model browser command (v0.65.2)
// ---------------------------------------------------------------------------

async function runModelBrowser(client: SideCarClient): Promise<void> {
  const caps = client.getBackendCapabilities();
  if (!caps?.modelBrowser || !caps?.lifecycle) {
    vscode.window.showInformationMessage('Active backend does not support model browsing. Switch to Kickstand.');
    return;
  }

  const repo = await vscode.window.showInputBox({
    prompt: 'HuggingFace repo to browse',
    placeHolder: 'e.g. bartowski/Meta-Llama-3-8B-Instruct-GGUF',
    validateInput: (v) => (v.trim().length === 0 ? 'Repo cannot be empty' : undefined),
  });
  if (!repo) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Browsing ${repo}…`, cancellable: false },
    async () => {
      try {
        const files = await caps.modelBrowser!.browseRepo(repo);
        if (files.length === 0) {
          vscode.window.showInformationMessage(`No GGUF/MLX files found in ${repo}.`);
          return;
        }

        const pick = await vscode.window.showQuickPick(
          files.map((f) => ({
            label: f.filename,
            description: `${formatBytes(f.sizeBytes)}${f.quant ? ` · ${f.quant}` : ''} · ${f.format}`,
            format: f.format,
          })),
          { placeHolder: 'Select a file to pull' },
        );
        if (!pick) return;

        // Pull the selected file via Kickstand's pull endpoint.
        // For MLX repos the "filename" is a display sentinel — pass undefined
        // so Kickstand triggers the full-repo snapshot_download path.
        const { kickstandPullModel, normalizeHfRepo } = await import('../ollama/kickstandBackend.js');
        const { getConfig } = await import('../config/settings.js');
        const baseUrl = getConfig().baseUrl;
        const isMlx = pick.format === 'mlx';
        const pullFilename = isMlx ? undefined : pick.label;
        const progressTitle = isMlx ? `Pulling ${repo} (MLX)…` : `Pulling ${pick.label}…`;
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: progressTitle, cancellable: true },
          async (_progress, token) => {
            const abortController = new AbortController();
            token.onCancellationRequested(() => abortController.abort());
            try {
              for await (const event of kickstandPullModel(
                baseUrl,
                normalizeHfRepo(repo),
                pullFilename,
                undefined,
                abortController.signal,
              )) {
                if (event.status === 'error') {
                  vscode.window.showErrorMessage(`Pull failed: ${event.message}`);
                  return;
                }
              }
              const successLabel = isMlx ? repo : pick.label;
              vscode.window.showInformationMessage(`Pulled ${successLabel} from ${repo}.`);
            } catch (err) {
              if (!token.isCancellationRequested) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Pull failed: ${msg}`);
              }
            }
          },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Browse failed: ${msg}`);
      }
    },
  );
}

/**
 * Prompt the user for a model ID. When the backend exposes
 * `listLoadable`, show a QuickPick filtered by load state (loaded
 * models can be unloaded; unloaded models can be loaded). Falls back
 * to free-text input when `listLoadable` isn't available or the
 * registry fetch fails.
 */
async function pickModelId(
  lifecycle: NonNullable<NonNullable<ReturnType<SideCarClient['getBackendCapabilities']>>['lifecycle']>,
  action: 'load' | 'unload',
): Promise<string | undefined> {
  if (lifecycle.listLoadable) {
    try {
      const loadable = await lifecycle.listLoadable();
      // Filter by the action's intent: for `load`, show models that
      // aren't currently loaded; for `unload`, show only loaded ones.
      const candidates = loadable.filter((m) => (action === 'load' ? !m.loaded : m.loaded));
      if (candidates.length > 0) {
        const pick = await vscode.window.showQuickPick(
          candidates.map((m) => ({
            label: m.id,
            description: m.sizeBytes ? formatBytes(m.sizeBytes) : undefined,
          })),
          {
            placeHolder: `Select a model to ${action}`,
          },
        );
        return pick?.label;
      }
      // No candidates from the registry — fall through to free-text
      // input so the user can still type an ID (useful when the
      // registry is stale or the user knows an ID the backend
      // doesn't advertise).
    } catch {
      // Registry fetch failed; silently fall through.
    }
  }

  return vscode.window.showInputBox({
    prompt: `Model ID to ${action}`,
    placeHolder: 'e.g. qwen3-coder:30b',
    validateInput: (value) => (value.trim().length === 0 ? 'Model ID cannot be empty' : undefined),
  });
}

/**
 * Format a byte count as a human-readable string for the QuickPick
 * description field. Exported for tests.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)}MB`;
  return `${(mb / 1024).toFixed(1)}GB`;
}
