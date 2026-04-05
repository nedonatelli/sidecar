import { describe, it, expect } from 'vitest';
import { createClient } from './factory.js';

describe('createClient', () => {
  it('returns a SideCarClient instance', () => {
    const client = createClient();
    expect(client).toBeDefined();
    expect(typeof client.isLocalOllama).toBe('function');
    expect(typeof client.updateModel).toBe('function');
  });

  it('uses default config (local Ollama)', () => {
    const client = createClient();
    // The mock workspace.getConfiguration returns defaults,
    // which is baseUrl=localhost:11434
    expect(client.isLocalOllama()).toBe(true);
  });

  it('accepts a model override', () => {
    const client = createClient('custom-model');
    // Client was created successfully with override
    expect(client).toBeDefined();
  });
});
