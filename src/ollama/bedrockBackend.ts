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
import { agentOutputCap, supportsTemperature, repairDanglingToolUses, toAnthropicWire } from './anthropicBackend.js';
import { translateAnthropicStream } from './anthropicStreamTranslate.js';
import { signRequest, canonicalizePath, type AwsCredentials, canonicalizeQuery } from './awsSigV4.js';
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
 * Auth has two paths: a **Bedrock API key** (bearer token) — from the SideCar-
 * stored key or `AWS_BEARER_TOKEN_BEDROCK` — takes precedence and sends
 * `Authorization: Bearer <key>`; otherwise it falls back to **SigV4 signing**
 * with IAM credentials (env vars, then `~/.aws/credentials`). Model IDs are
 * Bedrock model / inference-profile IDs, e.g. `us.anthropic.claude-sonnet-5-5`
 * or `global.anthropic.claude-opus-5-5` (Claude 5 ids carry no date suffix).
 *
 * Prompt caching (`cache_control`) is intentionally NOT sent here — Bedrock
 * gates it per-account and rejects unknown fields, so v1 sends plain blocks.
 */
/**
 * Bedrock runtime host for a region. FIPS mode uses the `-fips` host
 * (`bedrock-runtime-fips.<region>.amazonaws.com`), which is required for some
 * connections — notably AWS GovCloud (`us-gov-east-1` / `us-gov-west-1`).
 * GovCloud regions are on the standard `amazonaws.com` domain, so the only
 * difference is the FIPS service-name segment.
 */
export function bedrockRuntimeOrigin(region: string, fips = false): string {
  return `https://bedrock-runtime${fips ? '-fips' : ''}.${checkedRegion(region)}.amazonaws.com`;
}

/** Bedrock control-plane host (model discovery) for a region, FIPS-aware. */
export function bedrockControlOrigin(region: string, fips = false): string {
  return `https://bedrock${fips ? '-fips' : ''}.${checkedRegion(region)}.amazonaws.com`;
}

/**
 * The region becomes part of the host that receives the user's AWS
 * credentials, so it must be a region name (`us-east-1`, `us-gov-west-1`)
 * and nothing that could change the URL's authority (`@`, `/`, `:`).
 */
function checkedRegion(region: string): string {
  if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) {
    throw new Error(`Invalid Bedrock region "${region}". Set sidecar.bedrock.region to a name such as us-east-1.`);
  }
  return region;
}

/**
 * The error for a failed Bedrock model request: AWS's own message, kept whole,
 * plus what to do for the failures that read as SideCar problems but are not.
 * Both seen on us-east-1, 2026-10-23, with valid credentials:
 * - 404 "This model version has reached the end of its life": a retired model,
 *   still offered by its inference profile.
 * - 400 "Error 002: Access to Bedrock models is not allowed for this account":
 *   the account may not invoke models. The credentials were accepted (the
 *   control plane listed models with them), so re-entering a key will not help.
 */
export function bedrockErrorMessage(
  status: number,
  statusText: string,
  body: string,
  model: string,
  region: string,
): string {
  const base = `Bedrock request failed: ${status} ${statusText}${body ? ` — ${body}` : ''}`;
  if (/end of its life/i.test(body)) {
    return `${base}\nThe model "${model}" is retired on Bedrock. Choose another model; SideCar no longer lists retired models when it can read the account's model list.`;
  }
  if (/access to bedrock models is not allowed for this account/i.test(body)) {
    return (
      `${base}\nAWS accepted the credentials but does not let this account invoke Bedrock models in ${region}. ` +
      "This is an AWS account setting, not a SideCar or key problem: check the account's Bedrock model access in the AWS console for that region."
    );
  }
  return base;
}

export class BedrockBackend implements ApiBackend {
  private rateLimits: RateLimitStore;

  constructor(
    private region: string,
    private auth: { bearerToken?: string; credentials?: AwsCredentials } = {},
    rateLimits?: RateLimitStore,
    private useFips = false,
  ) {
    this.rateLimits = rateLimits ?? new RateLimitStore();
  }

  getRateLimits(): RateLimitStore {
    return this.rateLimits;
  }

  private get origin(): string {
    return bedrockRuntimeOrigin(this.region, this.useFips);
  }

  /**
   * A Bedrock API key (bearer token) — from the SideCar-stored key (passed in as
   * `bearerToken`) or the AWS-standard `AWS_BEARER_TOKEN_BEDROCK` env var. When
   * present, auth is `Authorization: Bearer <key>` and SigV4 is skipped. `'ollama'`
   * is SideCar's no-key placeholder default and is ignored.
   */
  private bearer(): string | undefined {
    const t = this.auth.bearerToken;
    if (t && t !== 'ollama') return t;
    return process.env.AWS_BEARER_TOKEN_BEDROCK || undefined;
  }

  private credentials(): AwsCredentials {
    const creds = this.auth.credentials ?? resolveAwsCredentials();
    if (!creds) {
      throw new Error(
        'No Bedrock credentials. Either set a Bedrock API key (SideCar: Set / Refresh API Key, or AWS_BEARER_TOKEN_BEDROCK), ' +
          'or provide IAM credentials (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or ~/.aws/credentials), then reload the window.',
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

  /** POST to Bedrock with bearer-token auth if available, else SigV4 signing. */
  private authedFetch(rawPath: string, bodyStr: string, signal: AbortSignal | undefined, estimatedTokens: number) {
    const fetchOpts = { rateLimits: this.rateLimits, estimatedTokens, label: 'bedrock' };
    const bearer = this.bearer();
    if (bearer) {
      const url = `${this.origin}${canonicalizePath(rawPath)}`;
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` };
      return sidecarFetch(url, { method: 'POST', headers, body: bodyStr, signal }, fetchOpts);
    }
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
    return sidecarFetch(signed.url, { method: 'POST', headers: signed.headers, body: bodyStr, signal }, fetchOpts);
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

    const maxOutputTokens = agentOutputCap(model, cfg.maxOutputTokens);
    const body: Record<string, unknown> = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxOutputTokens,
      messages: repairDanglingToolUses(toAnthropicWire(pruned.messages)),
      ...(supportsTemperature(model) ? { temperature: cfg.agentTemperature } : {}),
    };
    if (pruned.systemPrompt) body.system = pruned.systemPrompt;
    const cleanTools = this.cleanTools(tools);
    if (cleanTools) body.tools = cleanTools;

    const bodyStr = JSON.stringify(body);
    const response = await this.authedFetch(
      `/model/${model}/invoke-with-response-stream`,
      bodyStr,
      signal,
      charsToTokens(bodyStr.length) + maxOutputTokens,
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(bedrockErrorMessage(response.status, response.statusText, errorText, model, this.region));
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
      messages: toAnthropicWire(pruned.messages),
    };
    if (pruned.systemPrompt) body.system = pruned.systemPrompt;

    const bodyStr = JSON.stringify(body);
    const response = await this.authedFetch(
      `/model/${model}/invoke`,
      bodyStr,
      signal,
      charsToTokens(bodyStr.length) + maxTokens,
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(bedrockErrorMessage(response.status, response.statusText, errorText, model, this.region));
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

  /**
   * List Claude (Anthropic) models invocable on this account + region, by
   * querying the Bedrock **control plane** (`bedrock.<region>.amazonaws.com`,
   * distinct from the runtime host): cross-region inference profiles
   * (`us.anthropic.…` — required for newer Claude) plus on-demand foundation
   * models (older Claude, invocable by base id). Only Anthropic models are
   * returned because this backend speaks the Anthropic payload.
   *
   * Returns `[]` when the control plane is unreachable or the credentials lack
   * `bedrock:ListFoundationModels` / `ListInferenceProfiles` (a Bedrock API key
   * scoped only to InvokeModel will hit this) — the caller falls back to a
   * static list. GovCloud works unchanged (the host is region-derived).
   */
  async listAnthropicModels(signal?: AbortSignal, now: Date = new Date()): Promise<string[]> {
    const ids = new Set<string>();
    // Profile id -> the base model ids it routes to (from each summary's `models` ARNs).
    const profileModels = new Map<string, string[]>();

    // ListInferenceProfiles is PAGINATED. Accounts carry dozens of
    // system-defined profiles across all providers, so reading only the
    // first page silently dropped every Anthropic profile past it (dogfood:
    // "the Bedrock backend doesn't show all available models"). Follow
    // nextToken to exhaustion, bounded to 10 pages of 1000 as a runaway stop.
    let nextToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const query: Record<string, string> = { maxResults: '1000' };
      if (nextToken) query.nextToken = nextToken;
      const profiles = (await this.controlGet('/inference-profiles', signal, query).catch(() => null)) as {
        inferenceProfileSummaries?: { inferenceProfileId?: string; models?: { modelArn?: string }[] }[];
        nextToken?: string;
      } | null;
      for (const p of profiles?.inferenceProfileSummaries ?? []) {
        if (typeof p.inferenceProfileId === 'string' && /anthropic/i.test(p.inferenceProfileId)) {
          ids.add(p.inferenceProfileId);
          const bases = (p.models ?? [])
            .map((m) => (typeof m.modelArn === 'string' ? m.modelArn.split('/').pop() : undefined))
            .filter((b): b is string => !!b);
          if (bases.length > 0) profileModels.set(p.inferenceProfileId, bases);
        }
      }
      nextToken = profiles?.nextToken;
      if (!nextToken) break;
    }

    const fm = (await this.controlGet('/foundation-models', signal).catch(() => null)) as {
      modelSummaries?: {
        modelId?: string;
        providerName?: string;
        inferenceTypesSupported?: string[];
        outputModalities?: string[];
        modelLifecycle?: { endOfLifeTime?: string | null };
      }[];
    } | null;
    // Anthropic foundation models that can still be invoked: listed, and not
    // past their end of life. LEGACY models stay: they keep working until then.
    const live = new Set<string>();
    // The foundation list loaded and named Anthropic models at all. Not `live`:
    // every listed model can be past its end of life, and that is evidence too.
    let foundationListed = false;
    for (const m of fm?.modelSummaries ?? []) {
      if (m.providerName !== 'Anthropic' || typeof m.modelId !== 'string') continue;
      foundationListed = true;
      const eol = m.modelLifecycle?.endOfLifeTime ? Date.parse(m.modelLifecycle.endOfLifeTime) : NaN;
      if (!Number.isNaN(eol) && eol <= now.getTime()) continue;
      live.add(m.modelId);
      if ((m.inferenceTypesSupported ?? []).includes('ON_DEMAND') && (m.outputModalities ?? []).includes('TEXT')) {
        ids.add(m.modelId);
      }
    }

    // A retired model's inference profile is still listed, status ACTIVE: on
    // us-east-1 (2026-10-23) `us.anthropic.claude-3-haiku-20240307-v1:0` and
    // `…claude-3-sonnet-…` were offered, and invoking one returned 404 "This model
    // version has reached the end of its life". Their base models are gone from
    // ListFoundationModels, which is the signal. Drop a profile only on that
    // evidence: it names its models, the foundation list loaded, and none of
    // them is live. Without either list, nothing is filtered.
    if (foundationListed) {
      for (const [profile, bases] of profileModels) {
        if (!bases.some((b) => live.has(b))) ids.delete(profile);
      }
    }

    return [...ids].sort();
  }

  /** Signed/bearer GET against the Bedrock control-plane endpoint. */
  private async controlGet(rawPath: string, signal?: AbortSignal, query?: Record<string, string>): Promise<unknown> {
    const origin = bedrockControlOrigin(this.region, this.useFips);
    const bearer = this.bearer();
    let url: string;
    let headers: Record<string, string>;
    if (bearer) {
      const qs = canonicalizeQuery(query);
      url = `${origin}${canonicalizePath(rawPath)}${qs ? `?${qs}` : ''}`;
      headers = { Authorization: `Bearer ${bearer}` };
    } else {
      const signed = signRequest({
        method: 'GET',
        origin,
        rawPath,
        region: this.region,
        service: 'bedrock',
        headers: {},
        body: '',
        credentials: this.credentials(),
        date: new Date(),
        query,
      });
      url = signed.url;
      headers = signed.headers;
    }
    const res = await sidecarFetch(url, { method: 'GET', headers, signal }, { label: 'bedrock' });
    if (!res.ok) throw new Error(`Bedrock control plane ${res.status}`);
    return res.json();
  }
}
