import { SideCarClient } from './client.js';
import { getModel, getBaseUrl, getApiKey } from '../config/settings.js';

/**
 * Create a SideCarClient using the current workspace configuration.
 * Use this instead of manually reading settings and calling `new SideCarClient(...)`.
 */
export function createClient(modelOverride?: string): SideCarClient {
  const model = modelOverride || getModel();
  const baseUrl = getBaseUrl();
  const apiKey = getApiKey();
  return new SideCarClient(model, baseUrl, apiKey);
}
