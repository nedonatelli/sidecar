import { describe, it, expect } from 'vitest';
import { detectModelFamily, parseParamSizeB, buildCapabilityProfile } from './modelCapability.js';

describe('detectModelFamily', () => {
  it('detects cloud families', () => {
    expect(detectModelFamily('claude-opus-4-8')).toBe('claude');
    expect(detectModelFamily('gpt-4o')).toBe('gpt');
    expect(detectModelFamily('o3-mini')).toBe('gpt');
    expect(detectModelFamily('gemini-1.5-pro')).toBe('gemini');
  });

  it('detects local families and disambiguates codellama before llama', () => {
    expect(detectModelFamily('qwen3:30b')).toBe('qwen');
    expect(detectModelFamily('codellama:34b')).toBe('codellama');
    expect(detectModelFamily('llama-3.3-70b-versatile')).toBe('llama');
    expect(detectModelFamily('gemma2:9b')).toBe('gemma');
    expect(detectModelFamily('deepseek-coder:33b')).toBe('deepseek');
    expect(detectModelFamily('mixtral:8x7b')).toBe('mistral');
    expect(detectModelFamily('phi3:mini')).toBe('phi');
  });

  it('returns unknown for unrecognized names', () => {
    expect(detectModelFamily('some-custom-model')).toBe('unknown');
  });
});

describe('parseParamSizeB', () => {
  it('parses common size suffixes', () => {
    expect(parseParamSizeB('qwen3:30b')).toBe(30);
    expect(parseParamSizeB('llama-3.3-70b-versatile')).toBe(70);
    expect(parseParamSizeB('qwen2.5-coder:0.5b')).toBe(0.5);
    expect(parseParamSizeB('mixtral:8x7b')).toBe(7);
  });

  it('returns null when no size is present', () => {
    expect(parseParamSizeB('claude-opus-4-8')).toBeNull();
    expect(parseParamSizeB('phi3:mini')).toBeNull();
  });
});

describe('buildCapabilityProfile — tier', () => {
  it('rates frontier cloud families strong regardless of other signals', () => {
    expect(buildCapabilityProfile('claude-opus-4-8').tier).toBe('strong');
    expect(buildCapabilityProfile('gpt-4o', { supportsTools: false }).tier).toBe('strong');
  });

  it('lets eval pass rate override heuristics', () => {
    expect(buildCapabilityProfile('qwen3:30b', { evalPassRate: 0.9 }).tier).toBe('strong');
    expect(buildCapabilityProfile('qwen3:30b', { evalPassRate: 0.6 }).tier).toBe('medium');
    expect(buildCapabilityProfile('qwen3:30b', { evalPassRate: 0.3 }).tier).toBe('weak');
  });

  it('rates a no-tool-support local model weak', () => {
    expect(buildCapabilityProfile('llama2:13b', { supportsTools: false }).tier).toBe('weak');
  });

  it('rates large local models medium and small ones weak', () => {
    expect(buildCapabilityProfile('qwen3:30b').tier).toBe('medium');
    expect(buildCapabilityProfile('llama3.1:70b').tier).toBe('medium');
    expect(buildCapabilityProfile('llama3.2:3b').tier).toBe('weak');
    expect(buildCapabilityProfile('qwen2.5-coder:7b').tier).toBe('weak');
  });

  it('defaults an unknown-size local model to weak (conservative — more scaffolding)', () => {
    const p = buildCapabilityProfile('some-local-model');
    expect(p.tier).toBe('weak');
    expect(p.reasons.join(' ')).toContain('conservative');
  });

  it('carries the resolved signals through', () => {
    const p = buildCapabilityProfile('qwen3:30b', { contextWindow: 32768, supportsTools: true });
    expect(p).toMatchObject({ family: 'qwen', paramsB: 30, contextWindow: 32768, supportsTools: true });
  });
});
