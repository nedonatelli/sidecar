import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseHuggingFaceRef,
  isHuggingFaceRef,
  formatSize,
  inspectHFRepo,
  checkKnownGGUFIssues,
} from './huggingface.js';

describe('parseHuggingFaceRef', () => {
  it('parses full HTTPS URL', () => {
    const ref = parseHuggingFaceRef('https://huggingface.co/bartowski/Qwen3-Coder-GGUF');
    expect(ref).not.toBeNull();
    expect(ref!.org).toBe('bartowski');
    expect(ref!.repo).toBe('Qwen3-Coder-GGUF');
    expect(ref!.ollamaName).toBe('hf.co/bartowski/Qwen3-Coder-GGUF');
  });

  it('parses URL without protocol', () => {
    const ref = parseHuggingFaceRef('huggingface.co/TheBloke/Llama-2-7B-GGUF');
    expect(ref).not.toBeNull();
    expect(ref!.org).toBe('TheBloke');
    expect(ref!.repo).toBe('Llama-2-7B-GGUF');
  });

  it('parses hf.co shorthand', () => {
    const ref = parseHuggingFaceRef('hf.co/mistralai/Mistral-7B-v0.1');
    expect(ref).not.toBeNull();
    expect(ref!.org).toBe('mistralai');
    expect(ref!.repo).toBe('Mistral-7B-v0.1');
    expect(ref!.ollamaName).toBe('hf.co/mistralai/Mistral-7B-v0.1');
    expect(ref!.isExplicit).toBe(true);
  });

  it('parses bare org/repo as a non-explicit HF ref', () => {
    const ref = parseHuggingFaceRef('meta-llama/Llama-3.2-3B-Instruct');
    expect(ref).not.toBeNull();
    expect(ref!.org).toBe('meta-llama');
    expect(ref!.repo).toBe('Llama-3.2-3B-Instruct');
    expect(ref!.ollamaName).toBe('hf.co/meta-llama/Llama-3.2-3B-Instruct');
    expect(ref!.isExplicit).toBe(false);
  });

  it('does not match Ollama tag syntax (colon) as a bare HF ref', () => {
    expect(parseHuggingFaceRef('llama3:latest')).toBeNull();
    expect(parseHuggingFaceRef('user/model:tag')).toBeNull();
  });

  it('handles trailing slash', () => {
    const ref = parseHuggingFaceRef('https://huggingface.co/org/repo/');
    expect(ref).not.toBeNull();
    expect(ref!.org).toBe('org');
    expect(ref!.repo).toBe('repo');
  });

  it('returns null for inputs that are neither HF URLs nor bare org/repo', () => {
    expect(parseHuggingFaceRef('https://github.com/org/repo')).toBeNull();
    expect(parseHuggingFaceRef('just a string')).toBeNull();
    expect(parseHuggingFaceRef('')).toBeNull();
    expect(parseHuggingFaceRef('llama3')).toBeNull(); // no slash
    expect(parseHuggingFaceRef('llama3:latest')).toBeNull(); // tag syntax
  });

  it('handles whitespace', () => {
    const ref = parseHuggingFaceRef('  https://huggingface.co/org/repo  ');
    expect(ref).not.toBeNull();
    expect(ref!.org).toBe('org');
  });
});

describe('isHuggingFaceRef', () => {
  it('returns true for HF URLs', () => {
    expect(isHuggingFaceRef('https://huggingface.co/org/repo')).toBe(true);
    expect(isHuggingFaceRef('hf.co/org/repo')).toBe(true);
  });

  it('returns false for non-HF strings', () => {
    expect(isHuggingFaceRef('llama3')).toBe(false);
    expect(isHuggingFaceRef('https://github.com/org/repo')).toBe(false);
  });
});

describe('formatSize', () => {
  it('formats bytes to GB', () => {
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
    expect(formatSize(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });

  it('formats bytes to MB', () => {
    expect(formatSize(500 * 1024 * 1024)).toBe('500 MB');
    expect(formatSize(100 * 1024 * 1024)).toBe('100 MB');
  });

  it('returns unknown size for 0', () => {
    expect(formatSize(0)).toBe('unknown size');
  });
});

describe('checkKnownGGUFIssues', () => {
  it('returns a warning for Qwen3.5 GGUF repos', () => {
    expect(checkKnownGGUFIssues('Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-GGUF')).not.toBeNull();
    expect(checkKnownGGUFIssues('qwen3.5-4b-code-forged-GGUF')).not.toBeNull();
    expect(checkKnownGGUFIssues('Qwen3_5-9B-Uncensored')).not.toBeNull();
    expect(checkKnownGGUFIssues('Qwen35-Something-GGUF')).not.toBeNull();
  });

  it('returns null for non-problematic repos', () => {
    expect(checkKnownGGUFIssues('Llama-3.2-3B-Instruct-GGUF')).toBeNull();
    expect(checkKnownGGUFIssues('Qwen2.5-7B-Instruct-GGUF')).toBeNull();
    expect(checkKnownGGUFIssues('Qwen3-Coder-30B-GGUF')).toBeNull();
    expect(checkKnownGGUFIssues('Mistral-7B-v0.1-GGUF')).toBeNull();
  });
});

describe('inspectHFRepo', () => {
  const ref = { org: 'someone', repo: 'some-model', ollamaName: 'hf.co/someone/some-model', isExplicit: true };
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Helper: mock the HF model-info endpoint response. */
  function mockModelInfo(siblings: Array<{ rfilename: string; size?: number }>, gated = false) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ siblings, gated }),
    });
  }

  /** Helper: mock the config.json raw-file endpoint response. */
  function mockConfigJson(architecture: string | null) {
    if (architecture === null) {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' });
    } else {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ architectures: [architecture] }),
      });
    }
  }

  /**
   * Helper: mock the HF tree endpoint (used by `fetchHFTreeSizes`) with
   * a `path → size` map. Safetensors inspection fires this *after* the
   * gated short-circuit but *before* the config.json fetch.
   */
  function mockHFTree(entries: Array<{ path: string; size: number; lfs?: boolean }>) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () =>
        entries.map((e) => ({
          type: 'file',
          path: e.path,
          size: e.lfs ? undefined : e.size,
          lfs: e.lfs ? { size: e.size } : undefined,
        })),
    });
  }

  it('returns gguf when repo has GGUF files, sorted by size', async () => {
    mockModelInfo([
      { rfilename: 'model-Q8_0.gguf', size: 8_000_000_000 },
      { rfilename: 'README.md', size: 2000 },
      { rfilename: 'model-Q4_K_M.gguf', size: 4_000_000_000 },
    ]);

    const result = await inspectHFRepo(ref);
    expect(result.kind).toBe('gguf');
    if (result.kind !== 'gguf') return;
    expect(result.files).toHaveLength(2);
    expect(result.files[0].filename).toBe('model-Q4_K_M.gguf');
    expect(result.files[0].ollamaName).toBe('hf.co/someone/some-model:model-Q4_K_M.gguf');
    expect(result.files[1].filename).toBe('model-Q8_0.gguf');
  });

  it('returns safetensors for supported architectures', async () => {
    // Simulate the real-world case where HF's /api/models/{} siblings
    // array has no sizes (LFS files report undefined), and the tree
    // endpoint supplies them via the `lfs.size` field.
    mockModelInfo([
      { rfilename: 'model-00001-of-00002.safetensors' },
      { rfilename: 'model-00002-of-00002.safetensors' },
      { rfilename: 'model.safetensors.index.json' },
      { rfilename: 'config.json' },
      { rfilename: 'tokenizer.json' },
      { rfilename: 'tokenizer_config.json' },
    ]);
    mockHFTree([
      { path: 'model-00001-of-00002.safetensors', size: 10_000_000_000, lfs: true },
      { path: 'model-00002-of-00002.safetensors', size: 10_000_000_000, lfs: true },
      { path: 'model.safetensors.index.json', size: 20_000 },
      { path: 'config.json', size: 1_000 },
      { path: 'tokenizer.json', size: 500_000 },
      { path: 'tokenizer_config.json', size: 2_000 },
    ]);
    mockConfigJson('LlamaForCausalLM');

    const result = await inspectHFRepo(ref);
    expect(result.kind).toBe('safetensors');
    if (result.kind !== 'safetensors') return;
    expect(result.repo.architecture).toBe('LlamaForCausalLM');
    expect(result.repo.weightFiles).toHaveLength(2);
    expect(result.repo.weightFiles[0].size).toBe(10_000_000_000);
    expect(result.repo.metadataFiles.map((f) => f.filename)).toEqual(
      expect.arrayContaining([
        'config.json',
        'tokenizer.json',
        'tokenizer_config.json',
        'model.safetensors.index.json',
      ]),
    );
    expect(result.repo.totalBytes).toBe(20_000_000_000 + 20_000 + 1_000 + 500_000 + 2_000);
    expect(result.repo.gated).toBe(false);
  });

  it('falls back to sibling sizes when the tree endpoint is unavailable', async () => {
    mockModelInfo([
      { rfilename: 'model.safetensors', size: 14_000_000_000 },
      { rfilename: 'config.json', size: 1_000 },
    ]);
    // Tree endpoint 503s — classifier should keep going with whatever
    // sizes the sibling metadata reported.
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' });
    mockConfigJson('LlamaForCausalLM');

    const result = await inspectHFRepo(ref);
    expect(result.kind).toBe('safetensors');
    if (result.kind !== 'safetensors') return;
    expect(result.repo.totalBytes).toBe(14_000_001_000);
  });

  it('returns safetensors with gated=true when HF marks the repo gated and a token is provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        siblings: [{ rfilename: 'model.safetensors' }, { rfilename: 'config.json' }],
        gated: 'manual',
      }),
    });
    mockHFTree([
      { path: 'model.safetensors', size: 14_000_000_000, lfs: true },
      { path: 'config.json', size: 1_000 },
    ]);
    mockConfigJson('GemmaForCausalLM');

    const result = await inspectHFRepo(ref, { hfToken: 'hf_valid' });
    expect(result.kind).toBe('safetensors');
    if (result.kind !== 'safetensors') return;
    expect(result.repo.gated).toBe(true);
    expect(result.repo.totalBytes).toBe(14_000_001_000);
  });

  it('returns gated-auth-required when repo is gated and no token is provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        siblings: [
          { rfilename: 'model.safetensors', size: 14_000_000_000 },
          { rfilename: 'config.json', size: 1_000 },
        ],
        gated: 'manual',
      }),
    });

    const result = await inspectHFRepo(ref);
    expect(result.kind).toBe('gated-auth-required');
    // Must not have fetched config.json — that's the whole point of the
    // short-circuit (it would 401 and surface a confusing error).
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns unsupported-arch when architecture is not in the allowlist', async () => {
    mockModelInfo([
      { rfilename: 'model.safetensors', size: 14_000_000_000 },
      { rfilename: 'config.json', size: 1_000 },
    ]);
    mockHFTree([
      { path: 'model.safetensors', size: 14_000_000_000, lfs: true },
      { path: 'config.json', size: 1_000 },
    ]);
    mockConfigJson('MambaForCausalLM');

    const result = await inspectHFRepo(ref);
    expect(result.kind).toBe('unsupported-arch');
    if (result.kind !== 'unsupported-arch') return;
    expect(result.architecture).toBe('MambaForCausalLM');
  });

  it('returns no-weights when repo has neither GGUF nor safetensors', async () => {
    mockModelInfo([
      { rfilename: 'README.md', size: 2000 },
      { rfilename: 'pytorch_model.bin', size: 14_000_000_000 },
    ]);

    const result = await inspectHFRepo(ref);
    expect(result.kind).toBe('no-weights');
  });

  it('returns network-error when config.json is missing for a safetensors repo', async () => {
    mockModelInfo([
      { rfilename: 'model.safetensors', size: 14_000_000_000 },
      { rfilename: 'config.json', size: 1_000 },
    ]);
    mockHFTree([
      { path: 'model.safetensors', size: 14_000_000_000, lfs: true },
      { path: 'config.json', size: 1_000 },
    ]);
    mockConfigJson(null);

    const result = await inspectHFRepo(ref);
    expect(result.kind).toBe('network-error');
  });

  it('returns not-found when HF API returns 404', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const result = await inspectHFRepo(ref);
    expect(result.kind).toBe('not-found');
  });

  it('returns network-error for non-404 HTTP failures', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    const result = await inspectHFRepo(ref);
    expect(result.kind).toBe('network-error');
    if (result.kind !== 'network-error') return;
    expect(result.message).toContain('503');
  });

  it('returns network-error when fetch throws (timeout / DNS)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connect Timeout'));

    const result = await inspectHFRepo(ref);
    expect(result.kind).toBe('network-error');
    if (result.kind !== 'network-error') return;
    expect(result.message).toBe('Connect Timeout');
  });

  it('sends Authorization header when a token is provided', async () => {
    mockModelInfo([{ rfilename: 'model-Q4.gguf', size: 4_000_000_000 }]);

    await inspectHFRepo(ref, { hfToken: 'hf_testtoken' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://huggingface.co/api/models/someone/some-model',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer hf_testtoken' }),
      }),
    );
  });
});
