import { getConfig, type SideCarConfig } from './settings.js';

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
  providerType: 'ollama' | 'anthropic' | 'openai' | 'kickstand' | 'openrouter',
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
      case 'kickstand':
        checkUrl = `${cfg.baseUrl}/v1/models`;
        headers['Authorization'] = `Bearer ${cfg.apiKey}`;
        break;
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
