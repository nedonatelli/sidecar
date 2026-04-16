/**
 * HuggingFace model URL parsing and repo classification.
 *
 * Converts HuggingFace URLs to Ollama's `hf.co/org/repo[:file]` pull syntax
 * and inspects HF repos to decide how the extension should install them:
 *
 *   - GGUF repos → direct `ollama pull hf.co/org/repo:file` (fastest, Ollama-native)
 *   - Safetensors repos with a supported architecture → download weights and
 *     run `ollama create` locally, which invokes llama.cpp's converter and
 *     produces a quantized GGUF
 *   - Anything else → explain why and suggest a community GGUF mirror
 */

/** Result of parsing a HuggingFace URL. */
export interface HFModelRef {
  org: string;
  repo: string;
  /** Full Ollama pull name: `hf.co/org/repo` */
  ollamaName: string;
  /**
   * True when the input explicitly identified HuggingFace (full URL or
   * `hf.co/` shorthand). False for bare `org/repo` inputs, which could
   * also be a legit Ollama community model — when HF says 404 we should
   * fall through to a plain `ollama pull` rather than reporting an error.
   */
  isExplicit: boolean;
}

/** A GGUF file available for download from a HuggingFace repo. */
export interface GGUFFile {
  /** Filename, e.g. `model-Q4_K_M.gguf` */
  filename: string;
  /** File size in bytes. */
  size: number;
  /** Ollama pull name including the file: `hf.co/org/repo:file` */
  ollamaName: string;
}

/** A file that must be downloaded to reconstruct a Safetensors model locally. */
export interface SafetensorsAsset {
  /** Repo-relative filename (`model-00001-of-00004.safetensors`, `config.json`, ...). */
  filename: string;
  /** File size in bytes, or 0 if HF didn't report it. */
  size: number;
}

/** Safetensors-format model with everything needed for `ollama create`. */
export interface SafetensorsRepo {
  /** The `.safetensors` shard files (one or many). */
  weightFiles: SafetensorsAsset[];
  /** Tokenizer, config, and other small metadata files required by the converter. */
  metadataFiles: SafetensorsAsset[];
  /** Sum of all file sizes in bytes — used for disk-space preflight and progress totals. */
  totalBytes: number;
  /** Architecture string from `config.json`, e.g. `LlamaForCausalLM`. */
  architecture: string;
  /** True if HF marks the repo as gated (requires an access token to download). */
  gated: boolean;
}

/**
 * Outcome of {@link inspectHFRepo}. The variants are kept distinct so the
 * caller can surface an accurate error or branch into the right install flow.
 *
 * `gated-auth-required` is the "you're looking at a locked door" result:
 * the sibling list shows safetensors weights and HF marks the repo as gated,
 * but we couldn't read config.json to verify the architecture because we
 * don't have a token yet. The handler should prompt for a token and re-run
 * the inspection, which will then resolve to `safetensors` or
 * `unsupported-arch` once auth is in place.
 */
export type HFRepoInspection =
  | { kind: 'gguf'; files: GGUFFile[] }
  | { kind: 'safetensors'; repo: SafetensorsRepo }
  | { kind: 'gated-auth-required' }
  | { kind: 'unsupported-arch'; architecture: string }
  | { kind: 'no-weights' }
  | { kind: 'not-found' }
  | { kind: 'network-error'; message: string };

const HF_URL_PATTERN = /^https?:\/\/huggingface\.co\/([^/]+)\/([^/]+)\/?$/;
const HF_SHORT_PATTERN = /^hf\.co\/([^/]+)\/([^/:]+)/;

/**
 * Architectures that llama.cpp's `convert_hf_to_gguf.py` can convert —
 * which is what `ollama create` calls under the hood. Anything outside
 * this list will fail mid-convert, so we refuse it up front with a clear
 * message instead of downloading tens of gigabytes first.
 *
 * Sourced from llama.cpp's `convert_hf_to_gguf.py` Model registry. Keep in
 * sync manually when upstream adds support for new families — Ollama pins
 * a specific llama.cpp revision per release so we can't query it.
 */
const SUPPORTED_ARCHITECTURES = new Set<string>([
  'LlamaForCausalLM',
  'MistralForCausalLM',
  'MixtralForCausalLM',
  'GemmaForCausalLM',
  'Gemma2ForCausalLM',
  'Gemma3ForCausalLM',
  'PhiForCausalLM',
  'Phi3ForCausalLM',
  'Qwen2ForCausalLM',
  'Qwen2MoeForCausalLM',
  'Qwen3ForCausalLM',
  'Qwen3MoeForCausalLM',
  'StableLmForCausalLM',
  'FalconForCausalLM',
  'StarCoder2ForCausalLM',
  'DeepseekV2ForCausalLM',
  'DeepseekV3ForCausalLM',
  'CohereForCausalLM',
  'InternLM2ForCausalLM',
]);

/** File patterns required to run `ollama create` from a Safetensors dir. */
const METADATA_FILENAMES = new Set<string>([
  'config.json',
  'tokenizer.json',
  'tokenizer.model',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'generation_config.json',
  'added_tokens.json',
  'vocab.json',
  'merges.txt',
  'chat_template.json',
  'params.json',
]);

/**
 * Parse a HuggingFace URL or `hf.co/` shorthand into org/repo components.
 * Returns null if the input doesn't match.
 *
 * Accepted formats:
 * - `https://huggingface.co/bartowski/Qwen3-Coder-480B-A35B-Instruct-GGUF`
 * - `huggingface.co/bartowski/Qwen3-Coder-480B-A35B-Instruct-GGUF`
 * - `hf.co/bartowski/Qwen3-Coder-480B-A35B-Instruct-GGUF`
 */
export function parseHuggingFaceRef(input: string): HFModelRef | null {
  const trimmed = input.trim();

  const urlMatch = trimmed.match(HF_URL_PATTERN);
  if (urlMatch) {
    return {
      org: urlMatch[1],
      repo: urlMatch[2],
      ollamaName: `hf.co/${urlMatch[1]}/${urlMatch[2]}`,
      isExplicit: true,
    };
  }

  const noProtocol = trimmed.replace(/^https?:\/\//, '');
  const hfDomain = noProtocol.match(/^huggingface\.co\/([^/]+)\/([^/]+)\/?$/);
  if (hfDomain) {
    return {
      org: hfDomain[1],
      repo: hfDomain[2],
      ollamaName: `hf.co/${hfDomain[1]}/${hfDomain[2]}`,
      isExplicit: true,
    };
  }

  const shortMatch = trimmed.match(HF_SHORT_PATTERN);
  if (shortMatch) {
    return {
      org: shortMatch[1],
      repo: shortMatch[2],
      ollamaName: `hf.co/${shortMatch[1]}/${shortMatch[2]}`,
      isExplicit: true,
    };
  }

  // Bare `org/repo` form — what you get when you copy-paste a model name
  // from a HuggingFace page title. We mark these as non-explicit so the
  // caller can fall through to a plain `ollama pull` if HF returns 404
  // (the same string might be a legit Ollama community model like
  // `hhao/qwen2.5-coder`). Requires exactly one slash, no colons (which
  // would indicate an Ollama tag like `llama3:latest`), and characters
  // that are valid in both HF repo names and Ollama model names.
  const bareMatch = trimmed.match(/^([a-zA-Z0-9][\w.-]*)\/([a-zA-Z0-9][\w.-]*)$/);
  if (bareMatch) {
    return {
      org: bareMatch[1],
      repo: bareMatch[2],
      ollamaName: `hf.co/${bareMatch[1]}/${bareMatch[2]}`,
      isExplicit: false,
    };
  }

  return null;
}

/** Check whether an input string looks like a HuggingFace reference. */
export function isHuggingFaceRef(input: string): boolean {
  return parseHuggingFaceRef(input) !== null;
}

interface HFModelInfo {
  siblings?: Array<{ rfilename: string; size?: number }>;
  gated?: boolean | string;
}

/**
 * Fetch the HF model metadata endpoint. Split out from {@link inspectHFRepo}
 * so the classifier stays readable and network error handling is centralized.
 */
async function fetchHFModelInfo(
  ref: HFModelRef,
  token: string | undefined,
): Promise<
  { status: 'ok'; data: HFModelInfo } | { status: 'not-found' } | { status: 'network-error'; message: string }
> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`https://huggingface.co/api/models/${ref.org}/${ref.repo}`, {
      signal: AbortSignal.timeout(10000),
      headers,
    });
  } catch (err) {
    return { status: 'network-error', message: err instanceof Error ? err.message : String(err) };
  }

  if (response.status === 404) return { status: 'not-found' };
  if (!response.ok) {
    return { status: 'network-error', message: `HTTP ${response.status} ${response.statusText}` };
  }

  try {
    const data = (await response.json()) as HFModelInfo;
    return { status: 'ok', data };
  } catch (err) {
    return {
      status: 'network-error',
      message: `Invalid JSON from HuggingFace: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Fetch accurate file sizes from HF's tree endpoint. The `/api/models/{}`
 * `siblings` array is the metadata we use for classification, but its
 * `size` field is unreliable for LFS-backed files — safetensors shards
 * live in LFS and their sizes come back as `undefined`, which means the
 * install progress bar would display `5.99GB / 0.00GB` partway through
 * a 6GB download. The tree endpoint `/api/models/{}/tree/main?recursive=true`
 * returns the real LFS blob sizes so we can show a correct denominator.
 *
 * Returns a map of `filename → size in bytes`. On network failure we
 * return an empty map and the caller falls back to whatever sizes the
 * `siblings` array reported — a wrong total is better than crashing.
 */
async function fetchHFTreeSizes(ref: HFModelRef, token: string | undefined): Promise<Map<string, number>> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetch(`https://huggingface.co/api/models/${ref.org}/${ref.repo}/tree/main?recursive=true`, {
      signal: AbortSignal.timeout(10000),
      headers,
    });
    if (!response.ok) return new Map();
    const entries = (await response.json()) as Array<{
      type: string;
      path: string;
      size?: number;
      lfs?: { size: number };
    }>;
    const map = new Map<string, number>();
    for (const entry of entries) {
      if (entry.type !== 'file') continue;
      // LFS files report their real size under `lfs.size`; regular files
      // under top-level `size`. Either way, fall back to 0 if missing.
      const size = entry.lfs?.size ?? entry.size ?? 0;
      if (size > 0) map.set(entry.path, size);
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Fetch the `config.json` of an HF repo and return `architectures[0]`.
 * We need this to decide whether a Safetensors repo is convertible *before*
 * downloading tens of gigabytes of weights.
 */
async function fetchArchitecture(ref: HFModelRef, token: string | undefined): Promise<string | null> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetch(`https://huggingface.co/${ref.org}/${ref.repo}/raw/main/config.json`, {
      signal: AbortSignal.timeout(10000),
      headers,
    });
    if (!response.ok) return null;
    const config = (await response.json()) as { architectures?: string[] };
    return config.architectures?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Inspect a HuggingFace repo and classify what kind of install flow it needs.
 *
 * Resolution order:
 *   1. If any `.gguf` files are present → `gguf` (use Ollama's native pull)
 *   2. Else if `.safetensors` files are present:
 *      - Fetch config.json, read `architectures[0]`
 *      - If the architecture is in our allowlist → `safetensors` (convert locally)
 *      - Else → `unsupported-arch`
 *   3. Else → `no-weights` (nothing we know how to install)
 */
export async function inspectHFRepo(ref: HFModelRef, options: { hfToken?: string } = {}): Promise<HFRepoInspection> {
  const info = await fetchHFModelInfo(ref, options.hfToken);
  if (info.status === 'not-found') return { kind: 'not-found' };
  if (info.status === 'network-error') return { kind: 'network-error', message: info.message };

  const siblings = info.data.siblings ?? [];
  const gated = Boolean(info.data.gated) && info.data.gated !== 'false';

  const ggufFiles = siblings
    .filter((f) => f.rfilename.endsWith('.gguf'))
    .map((f) => ({
      filename: f.rfilename,
      size: f.size ?? 0,
      ollamaName: `hf.co/${ref.org}/${ref.repo}:${f.rfilename}`,
    }))
    .sort((a, b) => a.size - b.size);

  if (ggufFiles.length > 0) {
    return { kind: 'gguf', files: ggufFiles };
  }

  const hasSafetensors = siblings.some((f) => f.rfilename.endsWith('.safetensors'));
  if (!hasSafetensors) {
    return { kind: 'no-weights' };
  }

  // Short-circuit gated repos with no token *before* the tree + config.json
  // fetches — both would 401, the tree would return an empty size map, and
  // the config fetch would surface a misleading "could not read config.json"
  // error. Tell the handler to prompt for a token first, then re-run the
  // inspection with the token in hand.
  if (gated && !options.hfToken) {
    return { kind: 'gated-auth-required' };
  }

  // Pull accurate sizes from the tree endpoint. Sibling metadata leaves
  // LFS-backed safetensors shards with `size: undefined`, so without
  // this the progress bar denominator would be 0 for the real payload.
  const treeSizes = await fetchHFTreeSizes(ref, options.hfToken);
  const sizeFor = (filename: string, fallback: number | undefined) => treeSizes.get(filename) ?? fallback ?? 0;

  const weightFiles: SafetensorsAsset[] = siblings
    .filter((f) => f.rfilename.endsWith('.safetensors'))
    .map((f) => ({ filename: f.rfilename, size: sizeFor(f.rfilename, f.size) }));

  const metadataFiles: SafetensorsAsset[] = siblings
    .filter((f) => {
      const base = f.rfilename.split('/').pop() ?? f.rfilename;
      return METADATA_FILENAMES.has(base) || base === 'model.safetensors.index.json';
    })
    .map((f) => ({ filename: f.rfilename, size: sizeFor(f.rfilename, f.size) }));

  const architecture = await fetchArchitecture(ref, options.hfToken);
  if (!architecture) {
    return {
      kind: 'network-error',
      message: gated
        ? 'Could not read config.json — your HuggingFace token may be invalid or lack access to this gated repo.'
        : 'Could not read config.json — repo may be private or malformed.',
    };
  }

  if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
    return { kind: 'unsupported-arch', architecture };
  }

  const totalBytes = [...weightFiles, ...metadataFiles].reduce((sum, f) => sum + f.size, 0);

  return {
    kind: 'safetensors',
    repo: { weightFiles, metadataFiles, totalBytes, architecture, gated },
  };
}

/**
 * Repo-name patterns for GGUF models that Ollama can pull from HuggingFace
 * but cannot actually *load* due to metadata incompatibilities between the
 * community GGUF and Ollama's Go engine. Each entry maps a regex to an
 * actionable suggestion so the user isn't left staring at a cryptic 500.
 *
 * These are HF-import-specific — the same architecture works fine when
 * installed from the official Ollama library (`ollama pull qwen3.5`).
 */
const KNOWN_HF_GGUF_ISSUES: Array<{ pattern: RegExp; warning: string }> = [
  {
    pattern: /qwen3[\.\-_]?5/i,
    warning:
      'HuggingFace-sourced Qwen3.5 GGUFs are known to fail in Ollama due to a metadata incompatibility ' +
      '(the Go engine expects `head_count_kv` as an array but community GGUFs encode it as a scalar). ' +
      'The official Ollama library model works fine — try `ollama pull qwen3.5` instead, or use a ' +
      'specific size like `qwen3.5:27b`.',
  },
];

/**
 * Check whether a GGUF repo is known to have load-time issues with Ollama.
 * Returns a warning string if so, or null if the repo is fine to pull.
 */
export function checkKnownGGUFIssues(repoName: string): string | null {
  for (const { pattern, warning } of KNOWN_HF_GGUF_ISSUES) {
    if (pattern.test(repoName)) return warning;
  }
  return null;
}

/** Format a file size in bytes to a human-readable string. */
export function formatSize(bytes: number): string {
  if (bytes === 0) return 'unknown size';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}
