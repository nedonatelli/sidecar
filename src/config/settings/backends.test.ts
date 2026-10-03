import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  detectActiveProfile,
  detectActiveProfileId,
  CUSTOM_ENDPOINT_ENTRY,
  isLoopbackUrl,
  isLocalOpenAiCompatible,
  contextLengthFromModelsList,
  isLocalOllama,
  isAnthropic,
  isKickstand,
  isOpenRouter,
  isGroq,
  isFireworks,
  detectProvider,
  openAiApiRoot,
  providerDisplayLabel,
  BUILT_IN_BACKEND_PROFILES,
  OLLAMA_DEFAULT_MODEL,
  ANTHROPIC_DEFAULT_MODEL,
} from './backends.js';

describe('detectActiveProfile', () => {
  it('returns the matching built-in profile for a known URL', () => {
    const profile = detectActiveProfile('http://localhost:11434');
    expect(profile).not.toBeNull();
    expect(profile!.id).toBe('local-ollama');
  });

  it('returns null for an unknown URL', () => {
    expect(detectActiveProfile('http://custom.example.com')).toBeNull();
  });

  it('returns the anthropic profile for the Anthropic base URL', () => {
    const profile = detectActiveProfile('https://api.anthropic.com');
    expect(profile?.provider).toBe('anthropic');
  });
});

describe('detectActiveProfileId', () => {
  it('prefers a built-in profile whose URL matches', () => {
    expect(detectActiveProfileId('http://localhost:11434', 'auto')).toBe('local-ollama');
  });

  it('marks the custom-endpoint entry active for an unmatched openai-compat URL', () => {
    expect(detectActiveProfileId('http://gpu-box:8000/v1', 'openai-compat')).toBe(CUSTOM_ENDPOINT_ENTRY.id);
  });

  it('returns null for an unmatched URL under any other provider', () => {
    expect(detectActiveProfileId('http://gpu-box:8000/v1', 'openai')).toBeNull();
  });
});

describe('isLoopbackUrl', () => {
  it('matches this machine', () => {
    for (const u of [
      'http://localhost:8000',
      'http://127.0.0.1:1234/v1',
      'http://127.1.2.3',
      'http://[::1]:8000',
      'http://0.0.0.0:8000',
    ])
      expect(isLoopbackUrl(u), u).toBe(true);
  });
  it('rejects other hosts and junk', () => {
    for (const u of ['http://192.168.1.20:8000', 'https://api.openai.com', 'http://localhost.example.com', 'not a url'])
      expect(isLoopbackUrl(u), u).toBe(false);
  });
});

describe('isLocalOpenAiCompatible', () => {
  it('is true for an OpenAI-compatible server on loopback, chosen or auto-detected', () => {
    expect(isLocalOpenAiCompatible('http://localhost:8000/v1', 'openai-compat')).toBe(true);
    expect(isLocalOpenAiCompatible('http://localhost:8000', 'auto')).toBe(true); // auto → openai
  });
  it('is false for a remote server or a non-OpenAI-compatible provider', () => {
    expect(isLocalOpenAiCompatible('http://192.168.1.20:8000', 'openai-compat')).toBe(false);
    expect(isLocalOpenAiCompatible('http://localhost:11434', 'auto')).toBe(false); // Ollama has its own path
    expect(isLocalOpenAiCompatible('http://localhost:8000', 'anthropic')).toBe(false);
  });
});

describe('contextLengthFromModelsList', () => {
  it("reads vLLM's max_model_len, then context_length, then context_window", () => {
    expect(contextLengthFromModelsList({ data: [{ id: 'm', max_model_len: 32768 }] }, 'm')).toBe(32768);
    expect(contextLengthFromModelsList({ data: [{ id: 'm', context_length: 8192 }] }, 'm')).toBe(8192);
    expect(contextLengthFromModelsList({ data: [{ id: 'm', context_window: 4096 }] }, 'm')).toBe(4096);
  });
  it('only reads the requested model', () => {
    const data = {
      data: [
        { id: 'a', max_model_len: 1000 },
        { id: 'b', max_model_len: 2000 },
      ],
    };
    expect(contextLengthFromModelsList(data, 'b')).toBe(2000);
    expect(contextLengthFromModelsList(data, 'c')).toBeNull();
  });
  it("ignores llama.cpp's training context and malformed values", () => {
    expect(contextLengthFromModelsList({ data: [{ id: 'm', meta: { n_ctx_train: 131072 } }] }, 'm')).toBeNull();
    expect(contextLengthFromModelsList({ data: [{ id: 'm', max_model_len: 0 }] }, 'm')).toBeNull();
    expect(contextLengthFromModelsList({ data: [{ id: 'm', max_model_len: '4096' }] }, 'm')).toBeNull();
    expect(contextLengthFromModelsList(null, 'm')).toBeNull();
    expect(contextLengthFromModelsList({ object: 'list' }, 'm')).toBeNull();
  });
});

describe('URL detector helpers', () => {
  describe('isLocalOllama', () => {
    it('returns true for localhost:11434', () => {
      expect(isLocalOllama('http://localhost:11434')).toBe(true);
    });
    it('returns true for 127.0.0.1:11434', () => {
      expect(isLocalOllama('http://127.0.0.1:11434')).toBe(true);
    });
    it('returns false for a remote URL', () => {
      expect(isLocalOllama('https://api.anthropic.com')).toBe(false);
    });
  });

  describe('isAnthropic', () => {
    it('returns true for anthropic.com', () => {
      expect(isAnthropic('https://api.anthropic.com')).toBe(true);
    });
    it('returns false for ollama', () => {
      expect(isAnthropic('http://localhost:11434')).toBe(false);
    });
  });

  describe('isKickstand', () => {
    it('returns true for localhost:11435', () => {
      expect(isKickstand('http://localhost:11435')).toBe(true);
    });
    it('returns true for 127.0.0.1:11435', () => {
      expect(isKickstand('http://127.0.0.1:11435')).toBe(true);
    });
    it('returns false for ollama port', () => {
      expect(isKickstand('http://localhost:11434')).toBe(false);
    });
  });

  describe('isOpenRouter', () => {
    it('returns true for openrouter.ai', () => {
      expect(isOpenRouter('https://openrouter.ai/api/v1')).toBe(true);
    });
    it('returns false for openai.com', () => {
      expect(isOpenRouter('https://api.openai.com')).toBe(false);
    });
  });

  describe('isGroq', () => {
    it('returns true for groq.com', () => {
      expect(isGroq('https://api.groq.com')).toBe(true);
    });
    it('returns false for openai.com', () => {
      expect(isGroq('https://api.openai.com')).toBe(false);
    });
  });

  describe('isFireworks', () => {
    it('returns true for fireworks.ai', () => {
      expect(isFireworks('https://api.fireworks.ai/inference/v1')).toBe(true);
    });
    it('returns false for openai.com', () => {
      expect(isFireworks('https://api.openai.com')).toBe(false);
    });
  });
});

describe('detectProvider', () => {
  it('returns provider directly when not auto', () => {
    expect(detectProvider('http://localhost:11434', 'anthropic')).toBe('anthropic');
  });

  it('detects ollama from URL', () => {
    expect(detectProvider('http://localhost:11434', 'auto')).toBe('ollama');
  });

  it('detects anthropic from URL', () => {
    expect(detectProvider('https://api.anthropic.com', 'auto')).toBe('anthropic');
  });

  it('detects kickstand from URL', () => {
    expect(detectProvider('http://localhost:11435', 'auto')).toBe('kickstand');
  });

  it('detects openrouter from URL', () => {
    expect(detectProvider('https://openrouter.ai/api/v1', 'auto')).toBe('openrouter');
  });

  it('detects groq from URL', () => {
    expect(detectProvider('https://api.groq.com', 'auto')).toBe('groq');
  });

  it('detects fireworks from URL', () => {
    expect(detectProvider('https://api.fireworks.ai/inference/v1', 'auto')).toBe('fireworks');
  });

  it('defaults to openai for unknown URLs', () => {
    expect(detectProvider('https://custom.example.com', 'auto')).toBe('openai');
  });
});

describe('BUILT_IN_BACKEND_PROFILES', () => {
  it('has no duplicate IDs', () => {
    const ids = BUILT_IN_BACKEND_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every profile has required fields', () => {
    for (const p of BUILT_IN_BACKEND_PROFILES) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.baseUrl).toBeTruthy();
    }
  });
});

describe('default model constants', () => {
  it('OLLAMA_DEFAULT_MODEL is defined', () => {
    expect(OLLAMA_DEFAULT_MODEL).toBeTruthy();
  });
  it('ANTHROPIC_DEFAULT_MODEL is defined', () => {
    expect(ANTHROPIC_DEFAULT_MODEL).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// `openai-compat`: a self-hosted or gateway endpoint as a first-class choice.
//
// It was reachable before only by setting provider='openai' and hoping the URL
// sniffing did not reclassify the host — and the chat URL appended `/v1`
// unconditionally, so pasting the endpoint a provider documents
// (`https://bedrock-mantle.us-gov-west-1.api.aws/v1`) produced
// `/v1/v1/chat/completions` and a 404 that reads like a wrong host.
// ---------------------------------------------------------------------------
describe('openAiApiRoot', () => {
  it('appends /v1 when the base URL omits it', () => {
    expect(openAiApiRoot('https://api.openai.com')).toBe('https://api.openai.com/v1');
  });

  it('does NOT double-append when the base URL already ends in /v1', () => {
    expect(openAiApiRoot('https://bedrock-mantle.us-gov-west-1.api.aws/v1')).toBe(
      'https://bedrock-mantle.us-gov-west-1.api.aws/v1',
    );
  });

  it('absorbs a trailing slash in either form', () => {
    expect(openAiApiRoot('https://host/')).toBe('https://host/v1');
    expect(openAiApiRoot('https://host/v1/')).toBe('https://host/v1');
  });

  it('leaves a path-prefixed gateway intact', () => {
    expect(openAiApiRoot('https://gw.internal/llm/v1')).toBe('https://gw.internal/llm/v1');
    expect(openAiApiRoot('https://gw.internal/llm')).toBe('https://gw.internal/llm/v1');
  });
});

describe('openai-compat provider', () => {
  it('is honoured explicitly and never reclassified by URL sniffing', () => {
    // The whole point: an arbitrary host must stay openai-compat even though it
    // matches none of the known-provider patterns.
    expect(detectProvider('https://bedrock-mantle.us-gov-west-1.api.aws/v1', 'openai-compat')).toBe('openai-compat');
    expect(detectProvider('http://localhost:11434', 'openai-compat')).toBe('openai-compat');
  });

  it('has an honest display label', () => {
    expect(providerDisplayLabel('openai-compat')).toBe('OpenAI-compatible');
  });

  it('is offered in the settings UI', async () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((b: never) => (b as { properties?: object }).properties ?? {}),
    );
    expect(props['sidecar.provider'].enum).toContain('openai-compat');
  });
});
