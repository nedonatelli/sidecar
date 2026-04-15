import { OpenAIBackend } from './openaiBackend.js';

/**
 * Backend for Fireworks (https://fireworks.ai).
 *
 * Fireworks serves open-weight models (DeepSeek V3, Qwen 2.5 Coder,
 * Llama 3.3, Mixtral, and more) through an OpenAI-compatible
 * `/v1/chat/completions` endpoint. Same request shape, same SSE
 * framing, same tool_call delta format as OpenAI itself — no
 * protocol quirks to work around.
 *
 * Model ids are fully qualified (`accounts/fireworks/models/<slug>`)
 * which is longer than typical but otherwise works identically with
 * the existing model selection UI. Pricing is generally much cheaper
 * than OpenAI for comparable capability, making Fireworks a good
 * option for users who want frontier open-weight models without
 * running them locally.
 *
 * Like GroqBackend, the subclass body is empty — it exists purely so
 * detectProvider, the circuit breaker, and the settings UI can treat
 * Fireworks as a distinct provider. All streaming, request building,
 * and tool handling inherit from OpenAIBackend unchanged.
 */
export class FireworksBackend extends OpenAIBackend {}
