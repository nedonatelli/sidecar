import type { ChatState } from '../chatState.js';
import { getConfig } from '../../config/settings.js';
import { isProviderReachable } from '../../config/providerReachability.js';

// ---------------------------------------------------------------------------
// Provider connection
// ---------------------------------------------------------------------------

export async function ensureProviderRunning(state: ChatState): Promise<boolean> {
  if (await isProviderReachable(state.client.getProviderType())) return true;

  // Auto-start Kickstand if the provider is kickstand
  if (state.client.getProviderType() === 'kickstand') {
    const { ensureKickstandRunning } = await import('../../config/providerReachability.js');
    return ensureKickstandRunning(getConfig().baseUrl);
  }

  if (!state.client.isLocalOllama()) return false;

  try {
    const { spawn } = await import('child_process');
    const child = spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    return false;
  }

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isProviderReachable(state.client.getProviderType())) return true;
  }

  return false;
}

export async function connectWithRetry(state: ChatState): Promise<boolean> {
  state.postMessage({ command: 'typingStatus', content: 'Connecting to model...' });
  let started = await ensureProviderRunning(state);
  if (started) return true;

  const retryDelays = [2000, 4000, 8000];
  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    state.postMessage({
      command: 'typingStatus',
      content: `Connection failed — retrying (${attempt + 1}/${retryDelays.length})...`,
    });
    await new Promise((r) => setTimeout(r, retryDelays[attempt]));
    if (state.abortController?.signal.aborted) return false;
    started = await isProviderReachable(state.client.getProviderType());
    if (started) return true;
  }
  return false;
}

export async function handleRestartOllama(state: ChatState): Promise<void> {
  if (!state.client.isLocalOllama()) return;

  state.postMessage({ command: 'typingStatus', content: 'Restarting Ollama...' });
  state.postMessage({ command: 'setLoading', isLoading: true });

  try {
    const { execSync } = await import('child_process');
    // Kill any running Ollama process (best-effort — ignore failures)
    try {
      execSync('pkill -x ollama', { stdio: 'ignore' });
    } catch {
      /* not running */
    }
    await new Promise((r) => setTimeout(r, 1500));
  } catch {
    /* ignore */
  }

  const started = await ensureProviderRunning(state);
  state.postMessage({ command: 'setLoading', isLoading: false });

  if (started) {
    const { loadModels } = await import('./modelLoader.js');
    await loadModels(state);
    state.postMessage({ command: 'assistantMessage', content: 'Ollama restarted successfully.\n' });
    state.postMessage({ command: 'done' });
  } else {
    state.postMessage({
      command: 'error',
      content: 'Could not restart Ollama. Make sure it is installed and in your PATH.',
      errorType: 'connection',
      errorAction: 'Retry',
      errorActionCommand: 'restartOllama',
    });
  }
}
