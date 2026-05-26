import { describe, it, expect } from 'vitest';
import { lookupDraftModel, DRAFT_MODEL_MAP } from './constants.js';

describe('lookupDraftModel', () => {
  it('returns the draft for an exact match', () => {
    expect(lookupDraftModel('qwen2.5-coder:32b')).toBe('qwen2.5-coder:0.5b');
    expect(lookupDraftModel('codellama:34b')).toBe('codellama:7b-code');
    expect(lookupDraftModel('qwen3:30b')).toBe('qwen3:1.7b');
  });

  it('returns the draft for a variant with a dash suffix (quant/instruct tags)', () => {
    expect(lookupDraftModel('qwen2.5-coder:32b-instruct')).toBe('qwen2.5-coder:0.5b');
    expect(lookupDraftModel('qwen2.5-coder:32b-instruct-q4_k_m')).toBe('qwen2.5-coder:0.5b');
    expect(lookupDraftModel('codellama:34b-code-q5_k_m')).toBe('codellama:7b-code');
  });

  it('returns undefined for a model not in the map', () => {
    expect(lookupDraftModel('llama3:8b')).toBeUndefined();
    expect(lookupDraftModel('mistral:7b')).toBeUndefined();
    expect(lookupDraftModel('')).toBeUndefined();
  });

  it('all map keys resolve to themselves via exact lookup', () => {
    for (const key of Object.keys(DRAFT_MODEL_MAP)) {
      expect(lookupDraftModel(key)).toBe(DRAFT_MODEL_MAP[key]);
    }
  });

  it('does not match a model that merely starts with the key base name without a separator', () => {
    // 'qwen2.5-coder:32b' should not match 'qwen2.5-coder:32bXXX' (no dash/underscore separator)
    expect(lookupDraftModel('qwen2.5-coder:32bXXX')).toBeUndefined();
  });
});
