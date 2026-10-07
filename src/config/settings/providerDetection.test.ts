import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectProvider,
  identifyOllamaServer,
  ollamaApiRoot,
  onOllamaPort,
  __resetOllamaProbesForTests,
} from './backends.js';

// An Ollama server anywhere but localhost:11434 was driven as generic OpenAI.
describe('Ollama detection beyond localhost:11434', () => {
  afterEach(() => {
    __resetOllamaProbesForTests();
    vi.unstubAllGlobals();
  });

  it("treats Ollama's port on any host as Ollama", () => {
    expect(onOllamaPort('http://gpu-box:11434')).toBe(true);
    expect(detectProvider('http://192.168.1.20:11434', 'auto')).toBe('ollama');
    expect(detectProvider('http://localhost:11435', 'auto')).toBe('kickstand'); // unchanged
    expect(detectProvider('http://gpu-box:11434', 'openai')).toBe('openai'); // explicit wins
  });

  it('identifies Ollama on another port by /api/version', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ version: '0.12.3' }) }));
    vi.stubGlobal('fetch', fetchMock);
    expect(detectProvider('http://localhost:8080', 'auto')).toBe('openai');
    await identifyOllamaServer('http://localhost:8080/v1', 'auto');
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8080/api/version', expect.anything());
    expect(detectProvider('http://localhost:8080', 'auto')).toBe('ollama');
    await identifyOllamaServer('http://localhost:8080', 'auto');
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached per URL
  });

  it('leaves an OpenAI-compatible server (404 on /api/version) as openai', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    await identifyOllamaServer('http://localhost:1234', 'auto');
    expect(detectProvider('http://localhost:1234', 'auto')).toBe('openai');
  });

  it('never probes with an explicit provider, a recognized URL, or a cloud host', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await identifyOllamaServer('http://localhost:8080', 'openai');
    await identifyOllamaServer('https://api.anthropic.com', 'auto');
    await identifyOllamaServer('https://api.openai.com/v1', 'auto');
    await identifyOllamaServer('http://localhost:11434', 'auto');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('roots the native API without a trailing /v1', () => {
    expect(ollamaApiRoot('http://gpu-box:11434/v1/')).toBe('http://gpu-box:11434');
    expect(ollamaApiRoot('http://gpu-box:11434')).toBe('http://gpu-box:11434');
  });
});
