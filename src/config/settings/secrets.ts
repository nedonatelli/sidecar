// ---------------------------------------------------------------------------
// SecretStorage for API keys.
//
// Keys live in VS Code's SecretStorage instead of plaintext settings.json.
// On first activation we migrate any plaintext value into SecretStorage
// and clear it from settings. The cached-key getters let `readConfig()`
// in settings.ts pull the current value synchronously without awaiting
// the SecretStorage read on every request.
// ---------------------------------------------------------------------------

import { workspace, type ExtensionContext } from 'vscode';
import { invalidateConfigCache } from '../settings.js';

const SECRET_KEY_API = 'sidecar.apiKey';
const SECRET_KEY_FALLBACK_API = 'sidecar.fallbackApiKey';
const SECRET_KEY_HF_TOKEN = 'sidecar.huggingfaceToken';

let _secretContext: ExtensionContext | null = null;
let _cachedApiKey: string | null = null;
let _cachedFallbackApiKey: string | null = null;

const apiKeyListeners = new Set<() => void>();
const apiKeyChanged = {
  fire(): void {
    for (const l of [...apiKeyListeners]) l();
  },
};
/**
 * Called when the cached API key changes: secrets loaded at activation, a key
 * set in this window, or one stored by another window. Long-lived clients
 * (inline completions, adaptive paste) rebuild on it; built before the
 * secrets loaded, they kept the placeholder key.
 */
export function onApiKeyChanged(listener: () => void): { dispose(): void } {
  apiKeyListeners.add(listener);
  return { dispose: () => apiKeyListeners.delete(listener) };
}

/** Internal accessor for settings.ts to read the cached API key. */
export function getCachedApiKey(): string | null {
  return _cachedApiKey;
}

/** Internal accessor for settings.ts to read the cached fallback API key. */
export function getCachedFallbackApiKey(): string | null {
  return _cachedFallbackApiKey;
}

/**
 * Initialize SecretStorage from extension context. Reads existing secrets,
 * migrates any plaintext values from settings.json into SecretStorage,
 * and caches them for synchronous access via getConfig().
 */
export async function initSecrets(context: ExtensionContext): Promise<void> {
  _secretContext = context;
  const cfg = workspace.getConfiguration('sidecar');

  // Migrate apiKey: if the USER's own plaintext value exists, move it. Only
  // the global value: a workspace value comes from the repository and must not
  // be copied into the user's global SecretStorage (it would then be sent to
  // every provider in every window).
  const existing = await context.secrets.get(SECRET_KEY_API);
  if (existing) {
    _cachedApiKey = existing;
  } else {
    const plaintext = cfg.inspect<string>('apiKey')?.globalValue ?? 'ollama';
    if (plaintext && plaintext !== 'ollama') {
      await context.secrets.store(SECRET_KEY_API, plaintext);
      _cachedApiKey = plaintext;
      // Clear plaintext value
      await cfg.update('apiKey', undefined, true).then(undefined, () => undefined);
    } else {
      _cachedApiKey = plaintext;
    }
  }

  // Migrate fallbackApiKey similarly
  const existingFb = await context.secrets.get(SECRET_KEY_FALLBACK_API);
  if (existingFb) {
    _cachedFallbackApiKey = existingFb;
  } else {
    const plaintextFb = cfg.inspect<string>('fallbackApiKey')?.globalValue ?? '';
    if (plaintextFb) {
      await context.secrets.store(SECRET_KEY_FALLBACK_API, plaintextFb);
      _cachedFallbackApiKey = plaintextFb;
      await cfg.update('fallbackApiKey', undefined, true).then(undefined, () => undefined);
    } else {
      _cachedFallbackApiKey = plaintextFb;
    }
  }

  invalidateConfigCache(); // pick up the secrets on next getConfig()

  // SecretStorage is shared by every window. A key stored in another window
  // (a backend switch there) must replace this window's cached one, or this
  // window sends the old provider's key to the new provider's host.
  context.subscriptions.push(
    context.secrets.onDidChange(async (e) => {
      if (e.key === SECRET_KEY_API) _cachedApiKey = (await context.secrets.get(SECRET_KEY_API)) ?? 'ollama';
      else if (e.key === SECRET_KEY_FALLBACK_API)
        _cachedFallbackApiKey = (await context.secrets.get(SECRET_KEY_FALLBACK_API)) ?? '';
      else return;
      invalidateConfigCache();
      apiKeyChanged.fire();
    }),
  );
  apiKeyChanged.fire();
}

/** Update the API key in SecretStorage and refresh the cache. Used by the "Set API Key" command. */
export async function setApiKeySecret(value: string): Promise<void> {
  if (!_secretContext) throw new Error('SecretStorage not initialized');
  await _secretContext.secrets.store(SECRET_KEY_API, value);
  _cachedApiKey = value;
  invalidateConfigCache();
  apiKeyChanged.fire();
}

/** Update the fallback API key in SecretStorage and refresh the cache. */
export async function setFallbackApiKeySecret(value: string): Promise<void> {
  if (!_secretContext) throw new Error('SecretStorage not initialized');
  await _secretContext.secrets.store(SECRET_KEY_FALLBACK_API, value);
  _cachedFallbackApiKey = value;
  invalidateConfigCache();
}

/**
 * Fetch the HuggingFace token from SecretStorage. Used by the safetensors
 * import flow to authenticate downloads of gated models (Llama, Gemma, etc.).
 * Returns undefined if no token has been set.
 */
export async function getHuggingFaceToken(): Promise<string | undefined> {
  if (!_secretContext) return undefined;
  return (await _secretContext.secrets.get(SECRET_KEY_HF_TOKEN)) ?? undefined;
}

/** Store the HuggingFace token in SecretStorage. */
export async function setHuggingFaceToken(value: string): Promise<void> {
  if (!_secretContext) throw new Error('SecretStorage not initialized');
  await _secretContext.secrets.store(SECRET_KEY_HF_TOKEN, value);
}

/** Remove the HuggingFace token from SecretStorage. */
export async function clearHuggingFaceToken(): Promise<void> {
  if (!_secretContext) return;
  await _secretContext.secrets.delete(SECRET_KEY_HF_TOKEN);
}

/** Raw access to the ExtensionContext for profile-keyed secret paths (backends.ts). */
export function getSecretContext(): ExtensionContext | null {
  return _secretContext;
}

/**
 * Profile-switch helper: write a key into the active slot and refresh
 * the cache in one step. Used by `applyBackendProfile` / `setProfileApiKey`
 * when copying a per-profile stored key into the currently-active slot.
 */
export async function storeActiveApiKey(value: string): Promise<void> {
  if (!_secretContext) throw new Error('SecretStorage not initialized');
  await _secretContext.secrets.store(SECRET_KEY_API, value);
  _cachedApiKey = value;
  invalidateConfigCache();
  apiKeyChanged.fire();
}

/** Drop cached keys and context — used by test setup. */
export function _resetSecretsForTests(): void {
  _secretContext = null;
  _cachedApiKey = null;
  _cachedFallbackApiKey = null;
}
