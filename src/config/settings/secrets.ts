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

  // Migrate apiKey: if a non-default plaintext value exists, move it
  const existing = await context.secrets.get(SECRET_KEY_API);
  if (existing) {
    _cachedApiKey = existing;
  } else {
    const plaintext = cfg.get<string>('apiKey', 'ollama');
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
    const plaintextFb = cfg.get<string>('fallbackApiKey', '');
    if (plaintextFb) {
      await context.secrets.store(SECRET_KEY_FALLBACK_API, plaintextFb);
      _cachedFallbackApiKey = plaintextFb;
      await cfg.update('fallbackApiKey', undefined, true).then(undefined, () => undefined);
    } else {
      _cachedFallbackApiKey = plaintextFb;
    }
  }

  invalidateConfigCache(); // pick up the secrets on next getConfig()
}

/** Update the API key in SecretStorage and refresh the cache. Used by the "Set API Key" command. */
export async function setApiKeySecret(value: string): Promise<void> {
  if (!_secretContext) throw new Error('SecretStorage not initialized');
  await _secretContext.secrets.store(SECRET_KEY_API, value);
  _cachedApiKey = value;
  invalidateConfigCache();
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
}

/** Drop cached keys and context — used by test setup. */
export function _resetSecretsForTests(): void {
  _secretContext = null;
  _cachedApiKey = null;
  _cachedFallbackApiKey = null;
}
