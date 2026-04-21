import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getConfig, type SideCarConfig } from './settings.js';

/**
 * Read the auto-generated Kickstand bearer token for reachability probes.
 * Duplicated from kickstandBackend.ts to avoid a circular dependency
 * (providerReachability is imported by settings consumers, not backend modules).
 */
function readKickstandTokenForProbe(): string {
  try {
    const tokenPath = path.join(os.homedir(), '.config', 'kickstand', 'token');
    if (fs.existsSync(tokenPath)) {
      return fs.readFileSync(tokenPath, 'utf-8').trim();
    }
  } catch {
    // Token file not found or unreadable
  }
  return '';
}

/**
 * Check whether the configured LLM provider is reachable.
 * Uses the appropriate health/list endpoint for each provider type.
 *
 * "Reachable" means the server responded to an HTTP request at all. A
 * 401/403 counts as reachable — the server is up, the key just needs
 * fixing, and the actual chat request will surface a specific auth
 * error that's more useful than a generic "cannot reach API". Only
 * network errors and timeouts return false.
 */
export async function isProviderReachable(
  providerType: 'ollama' | 'anthropic' | 'openai' | 'kickstand' | 'openrouter' | 'groq' | 'fireworks',
  config?: SideCarConfig,
): Promise<boolean> {
  const cfg = config || getConfig();
  try {
    let checkUrl: string;
    const headers: Record<string, string> = {};

    switch (providerType) {
      case 'ollama':
        checkUrl = `${cfg.baseUrl}/api/tags`;
        break;
      case 'anthropic':
        // Anthropic returns 404/405 on the bare root, so probe the real
        // models-list endpoint. Same auth headers as the Messages API.
        checkUrl = `${cfg.baseUrl}/v1/models`;
        headers['x-api-key'] = cfg.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        break;
      case 'kickstand': {
        // Kickstand's /v1/models (OAI-compatible) is unprotected, so we
        // can probe it without auth. But use the health endpoint for a
        // cleaner signal.
        checkUrl = `${cfg.baseUrl}/api/v1/health`;
        const token = readKickstandTokenForProbe();
        if (token) headers['Authorization'] = `Bearer ${token}`;
        break;
      }
      case 'openrouter':
        // OpenRouter's /v1/models endpoint is public and doesn't need
        // auth to list the catalog, so this probes connectivity without
        // a round-trip to the slower chat endpoint. If a key is set we
        // still include it so the request counts as authenticated
        // (helps pinpoint bad keys via the returned error).
        checkUrl = `${cfg.baseUrl}/v1/models`;
        if (cfg.apiKey) {
          headers['Authorization'] = `Bearer ${cfg.apiKey}`;
        }
        break;
      case 'groq':
        // Groq is OpenAI-compatible; /openai/v1/models is the catalog
        // endpoint. Requires auth — probing without a key returns 401
        // which we count as reachable (bad key, but the server is up).
        checkUrl = `${cfg.baseUrl}/models`;
        if (cfg.apiKey && cfg.apiKey !== 'ollama') {
          headers['Authorization'] = `Bearer ${cfg.apiKey}`;
        }
        break;
      case 'fireworks':
        // Fireworks serves /v1/models the same way other OpenAI-compatible
        // providers do. Requires auth; 401 counts as reachable.
        checkUrl = `${cfg.baseUrl}/models`;
        if (cfg.apiKey && cfg.apiKey !== 'ollama') {
          headers['Authorization'] = `Bearer ${cfg.apiKey}`;
        }
        break;
      case 'openai':
        checkUrl = `${cfg.baseUrl}/v1/models`;
        if (cfg.apiKey && cfg.apiKey !== 'ollama') {
          headers['Authorization'] = `Bearer ${cfg.apiKey}`;
        }
        break;
    }

    const response = await fetch(checkUrl, { headers, signal: AbortSignal.timeout(1500) });
    // Local Ollama has no auth, so only 2xx counts. Remote providers
    // treat any response (including 401) as "reachable, auth is a
    // separate problem" so a bad key doesn't masquerade as an outage.
    if (providerType === 'ollama') return response.ok;
    return response.status < 500;
  } catch {
    return false;
  }
}

/**
 * Attempt to start Ollama if it isn't already running.
 * Spawns `ollama serve` as a detached child process and polls until
 * the API responds or the 15-second timeout expires.
 *
 * Returns true if Ollama is reachable after the attempt.
 */
export async function ensureOllamaRunning(baseUrl = 'http://localhost:11434'): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(1500) });
    if (resp.ok) return true;
  } catch {
    // Not running — try to start it
  }

  try {
    const { spawn } = await import('child_process');
    const child = spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // `ollama` not on PATH — can't auto-start
    return false;
  }

  // Poll for up to 15 seconds
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const resp = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(1000) });
      if (resp.ok) return true;
    } catch {
      // Keep polling
    }
  }

  return false;
}

/**
 * Attempt to start a Kickstand server if one isn't already running.
 * Spawns `kick serve` as a detached child process and polls the health
 * endpoint until it responds or the timeout expires.
 *
 * Returns true if the server is reachable after the attempt.
 */
export async function ensureKickstandRunning(baseUrl = 'http://localhost:11435'): Promise<boolean> {
  // Already running?
  try {
    const resp = await fetch(`${baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(1500) });
    if (resp.ok) return true;
  } catch {
    // Not running — try to start it
  }

  try {
    const { spawn } = await import('child_process');
    const child = spawn('kick', ['serve'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // `kick` not on PATH — can't auto-start
    return false;
  }

  // Poll health endpoint for up to 15 seconds
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const resp = await fetch(`${baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
      if (resp.ok) return true;
    } catch {
      // Keep polling
    }
  }

  return false;
}
