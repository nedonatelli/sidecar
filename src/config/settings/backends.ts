// ---------------------------------------------------------------------------
// Backend profiles — one-click switching between Ollama / Anthropic /
// Kickstand / OpenAI / OpenRouter / Groq / Fireworks without hand-editing
// four separate settings.
//
// Also home to the URL-pattern-matching provider detectors (`isLocalOllama`
// / `isAnthropic` / `isKickstand` / ...) and the router that picks the
// runtime provider when the user leaves `sidecar.provider` on `auto`.
// ---------------------------------------------------------------------------

import { workspace } from 'vscode';
import { getSecretContext, storeActiveApiKey } from './secrets.js';
import { invalidateConfigCache } from '../settings.js';

export interface BackendProfile {
  /** Stable identifier used in messages and SecretStorage keys. */
  id: string;
  /** Human-readable label shown in the chat menu. */
  name: string;
  /** Provider type the client will instantiate. */
  provider: 'ollama' | 'anthropic' | 'openai' | 'kickstand' | 'openrouter' | 'groq' | 'fireworks';
  /** API base URL to bake into sidecar.baseUrl. */
  baseUrl: string;
  /** Default model to select when switching to this profile. */
  defaultModel: string;
  /** SecretStorage key for this profile's API key. `null` means no key (local Ollama). */
  secretKey: string | null;
  /** Short description shown in the menu under the name. */
  description: string;
}

/** Shipped default model (Ollama). Also used as a sentinel: when `sidecar.model`
 *  still matches this string, the user hasn't picked a model yet, so `readConfig`
 *  is free to substitute a provider-appropriate default. */
export const OLLAMA_DEFAULT_MODEL = 'qwen3-coder:30b';

/** Default model when the resolved provider is Anthropic and no explicit
 *  model has been set. Haiku is chosen over Sonnet/Opus for cost. */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5';

export const BUILT_IN_BACKEND_PROFILES: readonly BackendProfile[] = [
  {
    id: 'local-ollama',
    name: 'Local Ollama',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    defaultModel: 'qwen2.5-coder:7b',
    secretKey: null,
    description: 'Self-hosted models via Ollama (free, private, no API key required)',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    secretKey: 'sidecar.profileKey.anthropic',
    description: 'Claude via the Anthropic API (pay-per-token, requires API key from platform.claude.com)',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com',
    defaultModel: 'gpt-4o',
    secretKey: 'sidecar.profileKey.openai',
    description: 'GPT models via the OpenAI API (pay-per-token, requires API key from platform.openai.com)',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    secretKey: 'sidecar.profileKey.openrouter',
    description:
      'One key unlocks hundreds of models across providers (Anthropic, OpenAI, Google, Mistral, Meta, and more). Requires an API key from openrouter.ai/keys. Per-model pricing pulled live from their catalog.',
  },
  {
    id: 'groq',
    name: 'Groq',
    provider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    secretKey: 'sidecar.profileKey.groq',
    description:
      'Groq LPU inference — thousands of tokens/sec on open-weight models like Llama 3.3, Mixtral, DeepSeek R1 distills. Free tier with rate limits; paid tier for higher throughput. Requires an API key from console.groq.com.',
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    provider: 'fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/qwen2p5-coder-32b-instruct',
    secretKey: 'sidecar.profileKey.fireworks',
    description:
      'Fireworks serves open-weight models (DeepSeek V3, Qwen 2.5 Coder, Llama 3.3, Mixtral) via a fast OpenAI-compatible endpoint. Cheaper than OpenAI for comparable capability. Requires an API key from fireworks.ai.',
  },
  {
    id: 'kickstand',
    name: 'Kickstand',
    provider: 'kickstand',
    baseUrl: 'http://localhost:11435',
    defaultModel: '',
    secretKey: null,
    description:
      'Self-hosted Kickstand LLM client backend — manage, load, and run GGUF and MLX models locally with GPU acceleration. No API key required; SideCar reads the auto-generated token automatically.',
  },
] as const;

/** Match the current baseUrl against a built-in profile, if any. */
export function detectActiveProfile(baseUrl: string): BackendProfile | null {
  return BUILT_IN_BACKEND_PROFILES.find((p) => p.baseUrl === baseUrl) ?? null;
}

/**
 * Apply a backend profile: write baseUrl / provider / model into workspace
 * config and copy the profile's stored secret (if any) into the active
 * `sidecar.apiKey` secret so runtime picks it up. Returns a status hint
 * the caller can surface to the user.
 */
export async function applyBackendProfile(
  profile: BackendProfile,
): Promise<{ status: 'applied' | 'missing-key'; message: string }> {
  const ctx = getSecretContext();
  if (!ctx) throw new Error('SecretStorage not initialized');
  const cfg = workspace.getConfiguration('sidecar');

  await cfg.update('provider', profile.provider, true);
  await cfg.update('baseUrl', profile.baseUrl, true);
  if (profile.defaultModel) {
    await cfg.update('model', profile.defaultModel, true);
  }

  if (profile.secretKey) {
    const stored = await ctx.secrets.get(profile.secretKey);
    if (!stored) {
      invalidateConfigCache();
      return {
        status: 'missing-key',
        message: `Switched to ${profile.name}, but no API key is stored for this profile yet. Run "SideCar: Set API Key" to set it, then switch again.`,
      };
    }
    await storeActiveApiKey(stored);
  } else {
    // Local profiles with no key — reset to the harmless default string
    await storeActiveApiKey('ollama');
  }

  return { status: 'applied', message: `Switched to ${profile.name} (${profile.defaultModel || 'no default model'})` };
}

/**
 * Save an API key for a specific profile. Used by the "Set API Key" flow
 * when the user is currently on a profile with a non-null `secretKey`.
 * Also copies it into the active slot so it takes effect immediately.
 */
export async function setProfileApiKey(profile: BackendProfile, value: string): Promise<void> {
  const ctx = getSecretContext();
  if (!ctx) throw new Error('SecretStorage not initialized');
  if (!profile.secretKey) return;
  await ctx.secrets.store(profile.secretKey, value);
  await storeActiveApiKey(value);
}

// ---------------------------------------------------------------------------
// Provider URL pattern matching
// ---------------------------------------------------------------------------

/** Check whether a base URL points to a local Ollama instance. */
export function isLocalOllama(baseUrl: string): boolean {
  return baseUrl.includes('localhost:11434') || baseUrl.includes('127.0.0.1:11434');
}

export function isAnthropic(baseUrl: string): boolean {
  return baseUrl.includes('anthropic.com');
}

export function isKickstand(baseUrl: string): boolean {
  return baseUrl.includes('localhost:11435') || baseUrl.includes('127.0.0.1:11435');
}

/**
 * Check whether a base URL points at OpenRouter. Matches both the
 * canonical `openrouter.ai` host and any user-supplied proxy that
 * contains `openrouter` in the hostname.
 */
export function isOpenRouter(baseUrl: string): boolean {
  return baseUrl.includes('openrouter.ai');
}

/**
 * Check whether a base URL points at Groq. Matches `api.groq.com`
 * and any user-supplied proxy containing `groq.com`.
 */
export function isGroq(baseUrl: string): boolean {
  return baseUrl.includes('groq.com');
}

/**
 * Check whether a base URL points at Fireworks. Matches
 * `api.fireworks.ai` and any proxy containing `fireworks.ai`.
 */
export function isFireworks(baseUrl: string): boolean {
  return baseUrl.includes('fireworks.ai');
}

/** Determine which backend provider to use based on URL and explicit setting. */
export function detectProvider(
  baseUrl: string,
  provider: 'auto' | 'ollama' | 'anthropic' | 'openai' | 'kickstand' | 'openrouter' | 'groq' | 'fireworks',
): 'ollama' | 'anthropic' | 'openai' | 'kickstand' | 'openrouter' | 'groq' | 'fireworks' {
  if (provider !== 'auto') return provider;
  if (isLocalOllama(baseUrl)) return 'ollama';
  if (isAnthropic(baseUrl)) return 'anthropic';
  if (isKickstand(baseUrl)) return 'kickstand';
  if (isOpenRouter(baseUrl)) return 'openrouter';
  if (isGroq(baseUrl)) return 'groq';
  if (isFireworks(baseUrl)) return 'fireworks';
  return 'openai';
}
