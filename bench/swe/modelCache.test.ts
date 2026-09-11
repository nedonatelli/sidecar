import { describe, it, expect } from 'vitest';
import { unloadModelRequest } from './modelCache.js';

describe('unloadModelRequest', () => {
  it('targets /api/generate on the given host', () => {
    expect(unloadModelRequest('http://localhost:11434', 'gemma4:e4b').url).toBe('http://localhost:11434/api/generate');
  });

  it('tolerates a trailing slash on the host', () => {
    // OLLAMA_HOST is user-supplied; a double slash is the kind of thing that
    // works on one server and 404s on another.
    expect(unloadModelRequest('http://localhost:11434/', 'gemma4:e4b').url).toBe('http://localhost:11434/api/generate');
  });

  it('asks Ollama to evict the model and generates nothing', () => {
    // keep_alive: 0 is the eviction. The whole point is a COLD cache for the
    // next real request, so this one must not itself populate the cache with a
    // prompt.
    const body = JSON.parse(unloadModelRequest('http://h', 'gemma4:e4b').body);
    expect(body).toEqual({ model: 'gemma4:e4b', keep_alive: 0 });
    expect(body).not.toHaveProperty('prompt');
  });
});
