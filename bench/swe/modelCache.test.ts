import { describe, it, expect } from 'vitest';
import { unloadModelRequest, coldStartPerTask } from './modelCache.js';

describe('coldStartPerTask', () => {
  it('unloads before each task on Ollama unless SIDECAR_SWE_WARM_MODEL=1', () => {
    expect(coldStartPerTask('ollama', undefined)).toBe(true);
    expect(coldStartPerTask('ollama', '0')).toBe(true);
    expect(coldStartPerTask('ollama', '1')).toBe(false);
  });

  it('never sends the Ollama-native unload to another backend (vLLM, OpenAI-compatible, hosted)', () => {
    for (const backend of ['openai-compat', 'openai', 'kickstand', 'anthropic', 'openrouter']) {
      expect(coldStartPerTask(backend, undefined)).toBe(false);
    }
  });
});

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
