import { getConfig, type SideCarConfig } from './settings.js';

/**
 * Check whether the configured LLM provider is reachable.
 * Uses the appropriate health/list endpoint for each provider type.
 */
export async function isProviderReachable(
  providerType: 'ollama' | 'anthropic' | 'openai' | 'kickstand',
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
        checkUrl = cfg.baseUrl;
        headers['x-api-key'] = cfg.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        break;
      case 'kickstand':
        checkUrl = `${cfg.baseUrl}/v1/models`;
        headers['Authorization'] = `Bearer ${cfg.apiKey}`;
        break;
      case 'openai':
        checkUrl = `${cfg.baseUrl}/v1/models`;
        if (cfg.apiKey && cfg.apiKey !== 'ollama') {
          headers['Authorization'] = `Bearer ${cfg.apiKey}`;
        }
        break;
    }

    const response = await fetch(checkUrl, { headers, signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}
