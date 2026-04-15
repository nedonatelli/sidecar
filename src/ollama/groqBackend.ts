import { OpenAIBackend } from './openaiBackend.js';

/**
 * Backend for Groq (https://groq.com).
 *
 * Groq's chat completions API is byte-identical to OpenAI's `/v1/chat/
 * completions` dialect — same request shape, same SSE framing, same
 * `tool_calls` delta format, same `stream_options.include_usage`
 * support. The only practical difference is speed: Groq's LPU chips
 * serve most models at thousands of tokens/second, which makes the
 * agent loop feel dramatically more responsive than the same model
 * on traditional GPU inference.
 *
 * Because the wire protocol matches, this subclass exists purely so:
 *   - `detectProvider()` can route Groq URLs to a named backend
 *   - the circuit breaker and rate-limit store are isolated per provider
 *   - the settings UI has a first-class profile entry
 *   - future Groq-specific polish (e.g. free-tier detection, on-demand
 *     rate-limit header parsing) has somewhere to live
 *
 * All streaming, tool-call handling, rate limiting, and request
 * building inherit from `OpenAIBackend` unchanged. See F.1 in the
 * v0.54 release for the anticorruption-layer payoff: this entire
 * subclass is ~10 useful lines because `streamOpenAiSse` and the
 * OpenAIBackend request path already handle everything.
 */
export class GroqBackend extends OpenAIBackend {}
