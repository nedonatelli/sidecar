import { getContentText } from '../ollama/types.js';
import type { ChatMessage } from '../ollama/types.js';

// ---------------------------------------------------------------------------
// Script-type-aware token estimation.
//
// The flat CHARS_PER_TOKEN = 4 constant under-estimates tokens for CJK text
// (each ideograph is ~1 token regardless of byte width) and over-estimates
// for code (identifiers and operators pack more tightly than prose).
//
// This module provides a sampled estimator that classifies the dominant
// content type of a message history and picks the appropriate ratio:
//   - CJK-dominant (>30% CJK codepoints): ~1.5 chars/token
//   - Code-dense (>10% code-punctuation density): ~2.5 chars/token
//   - English prose (default): ~4.0 chars/token
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN_CJK = 1.5;
const CHARS_PER_TOKEN_CODE = 2.5;
const CHARS_PER_TOKEN_EN = 4.0;

function charsPerTokenForSample(sample: string): number {
  const len = sample.length;
  if (len === 0) return CHARS_PER_TOKEN_EN;

  let cjk = 0;
  let code = 0;
  for (let i = 0; i < len; i++) {
    const cp = sample.charCodeAt(i);
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
      (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
      (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
      (cp >= 0x3400 && cp <= 0x4dbf) // CJK Extension A
    ) {
      cjk++;
    } else if (
      cp === 0x7b || // {
      cp === 0x7d || // }
      cp === 0x3b || // ;
      cp === 0x3d || // =
      cp === 0x28 || // (
      cp === 0x29 || // )
      cp === 0x3e || // >
      cp === 0x3c // <
    ) {
      code++;
    }
  }

  if (cjk / len > 0.3) return CHARS_PER_TOKEN_CJK;
  if (code / len > 0.1) return CHARS_PER_TOKEN_CODE;
  return CHARS_PER_TOKEN_EN;
}

/**
 * Estimate token count from the accumulated character total, using a
 * script-type-aware ratio derived from sampling the last 5 messages.
 *
 * Falls back to flat 4 chars/token when the message list is empty.
 */
export function estimateTokensFromState(totalChars: number, messages: ChatMessage[]): number {
  if (totalChars === 0) return 0;

  const parts: string[] = [];
  for (const msg of messages.slice(-5)) {
    parts.push(getContentText(msg.content).slice(0, 300));
    if (parts.join('').length >= 1500) break;
  }

  const sample = parts.join('');
  const ratio = charsPerTokenForSample(sample);
  return Math.ceil(totalChars / ratio);
}

/**
 * Estimate token count for a standalone text string.
 * Used when the full message history is not available.
 */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  const sample = text.length > 2000 ? text.slice(0, 2000) : text;
  return Math.ceil(text.length / charsPerTokenForSample(sample));
}

/**
 * Convert a pre-computed character count to tokens using the conservative
 * English ratio. Use when the original text is unavailable.
 */
export function charsToTokens(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN_EN);
}

/**
 * Convert a token budget to a conservative character limit.
 * Use when sizing char-based buffers from a token limit.
 */
export function tokensToChars(tokens: number): number {
  return Math.floor(tokens * CHARS_PER_TOKEN_EN);
}
