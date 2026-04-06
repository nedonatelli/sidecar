import { SideCarClient } from './client.js';
import { getConfig } from '../config/settings.js';

/**
 * Create a SideCarClient using the current workspace configuration.
 * Use this instead of manually reading settings and calling `new SideCarClient(...)`.
 */
export function createClient(modelOverride?: string): SideCarClient {
  const config = getConfig();
  return new SideCarClient(modelOverride || config.model, config.baseUrl, config.apiKey);
}
