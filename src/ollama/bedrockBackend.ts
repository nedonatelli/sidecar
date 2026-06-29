import type { ApiBackend, ResponseFormat } from './backend.js';
import { logger } from '../system/logger.js';
import type { ChatMessage, ToolDefinition, AnthropicResponse, AnthropicStreamEvent, StreamEvent } from './types.js';
import { getConfig } from '../config/settings.js';
import { abortableRead } from './streamUtils.js';
import { RateLimitStore } from './rateLimitState.js';
import { sidecarFetch } from './sidecarFetch.js';
import { spendTracker } from './spendTracker.js';
import { prunePrompt, formatPruneStats } from './promptPruner.js';
import { charsToTokens } from '../config/tokenEstimation.js';
import { maxOutputTokensForModel, supportsTemperature } from './anthropicBackend.js';
import { translateAnthropicStream } from './anthropicStreamTranslate.js';
import { signRequest, type AwsCredentials } from './awsSigV4.js';
import { resolveAwsCredentials } from './awsCredentials.js';
import { streamBedrockChunks } from './awsEventStream.js';

/**
 * AWS Bedrock backend for Claude models. Bedrock accepts the **native Anthropic
 * Messages payload** (with `anthropic_version: bedrock-2023-05-31` and the model
 * in the URL instead of the body), so this backend reuses the Anthropic message
 * shape, the output-token clamp, and the shared stream-event translator — the
 * only Bedrock-specific parts are SigV4 request signing and the AWS event-stream
 * response framing.
 *
 * Auth uses the standard AWS credential resolution (env vars, then
 * `~/.aws/credentials`), not a SideCar API key — so the provider profile's
 * `secretKey` is null, like Kickstand. Model IDs are Bedrock model / inference-
 * profile IDs, e.g. `anthropic.claude-3-5-sonnet-20241022-v2:0` or
 * `us.anthropic.claude-sonnet-4-20250514-v1:0`.
 *
 * Prompt caching (`cache_control`) is intentionally NOT sent here — Bedrock
 * gates it per-account and rejects unknown fields, so v1 sends plain blocks.
 */
export class BedrockBackend implements ApiBackend {
  constructor(
    private region: string,
    private credentialsOverride?: AwsCredentials,
    private rateLimits: RateLimitStore = new RateLimitStore(),
  ) {}

  getRateLimits(): RateLimitStore {
    return this.rateLimits;
  }

  private get origin(): string {
    return `https://bedrock-runtime.${this.region}.amazonaws.com`;
  }

  private credentials(): AwsCredentials {
    const creds = this.credentialsOverride ?? resolveAwsCredentials();
    if (!creds) {
      throw new Error(
        'AWS credentials not found for Bedrock. Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY ' +
          '(and AWS_SESSION_TOKEN if using temporary creds), or configure ~/.aws/credentials, then reload the window.',
      );
    }
    return creds;
  }

  /** Strip SideCar-internal tool fields Bedrock would reject. */
  private cleanTools(tools?: ToolDefinition[]): ToolDefinition[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((tool) => {
      const { nondeterministicOutput: _nd, ...apiTool } = tool;
      return apiTool as ToolDefinition;
    });
  }

  private signedFetch(rawPath: string, bodyStr: string, signal: AbortSignal | undefined, estimatedTokens: number) {
    const signed = signRequest({
      method: 'POST',
      origin: this.origin,
      rawPath,
      region: this.region,
      service: 'bedrock',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr,
      credentials: this.credentials(),
      date: new Date(),
    });
    return sidecarFetch(
      signed.url,
      { method: 'POST', headers: signed.headers, body: bodyStr, signal },
      { rateLimits: this.rateLimits, estimatedTokens, label: 'bedrock' },
    );
  }

  async *streamChat(
    model: string,
    systemPrompt: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    const cfg = getConfig();
    const dedupExemptTools = tools
      ? new Set(tools.filter((t) => t.nondeterministicOutput).map((t) => t.name))
      : undefined;
    const pruned = prunePrompt(systemPrompt, messages, {
      enabled: cfg.promptPruningEnabled,
      maxToolResultTokens: cfg.promptPruningMaxToolResultTokens,
      dedupExemptTools,
    });
    const pruneLog = formatPruneStats(pruned.stats);
    if (pruneLog) logger.info(`[SideCar] ${pruneLog}`);

    const maxOutputTokens = Math.min(cfg.agentMaxTokens, maxOutputTokensForModel(model));
    const body: Record<string, unknown> = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxOutputTokens,
      messages: pruned.messages,
      ...(supportsTemperature(model) ? { temperature: cfg.agentTemperature } : {}),
    };
    if (pruned.systemPrompt) body.system = pruned.systemPrompt;
    const cleanTools = this.cleanTools(tools);
    if (cleanTools) body.tools = cleanTools;

    const bodyStr = JSON.stringify(body);
    const response = await this.signedFetch(
      `/model/${model}/invoke-with-response-stream`,
      bodyStr,
      signal,
      charsToTokens(bodyStr.length) + maxOutputTokens,
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Bedrock request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`);
    }
    if (!response.body) throw new Error('Bedrock returned an empty response body');

    const reader = response.body.getReader();
    const events = streamBedrockChunks(reader, (r) => abortableRead(r, signal)) as AsyncGenerator<AnthropicStreamEvent>;
    yield* translateAnthropicStream(events, model);
  }

  async complete(
    model: string,
    systemPrompt: string,
    messages: ChatMessage[],
    maxTokens: number = 256,
    signal?: AbortSignal,
    _responseFormat?: ResponseFormat,
  ): Promise<string> {
    const cfg = getConfig();
    const pruned = prunePrompt(systemPrompt, messages, {
      enabled: cfg.promptPruningEnabled,
      maxToolResultTokens: cfg.promptPruningMaxToolResultTokens,
    });

    const body: Record<string, unknown> = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      messages: pruned.messages,
    };
    if (pruned.systemPrompt) body.system = pruned.systemPrompt;

    const bodyStr = JSON.stringify(body);
    const response = await this.signedFetch(
      `/model/${model}/invoke`,
      bodyStr,
      signal,
      charsToTokens(bodyStr.length) + maxTokens,
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Bedrock request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    if (data.usage) {
      spendTracker.record(model, {
        inputTokens: data.usage.input_tokens ?? 0,
        outputTokens: data.usage.output_tokens ?? 0,
        cacheCreationInputTokens: data.usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: data.usage.cache_read_input_tokens ?? 0,
      });
    }
    return data.content.find((b) => b.type === 'text')?.text ?? '';
  }
}
