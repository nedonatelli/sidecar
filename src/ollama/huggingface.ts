/**
 * HuggingFace model URL parsing and GGUF file discovery.
 *
 * Converts HuggingFace URLs to Ollama's `hf.co/org/repo[:file]` pull syntax
 * and fetches available GGUF quantization options from the HF API.
 */

/** Result of parsing a HuggingFace URL. */
export interface HFModelRef {
  org: string;
  repo: string;
  /** Full Ollama pull name: `hf.co/org/repo` */
  ollamaName: string;
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

const HF_URL_PATTERN = /^https?:\/\/huggingface\.co\/([^/]+)\/([^/]+)\/?$/;
const HF_SHORT_PATTERN = /^hf\.co\/([^/]+)\/([^/:]+)/;

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

  // Full URL: https://huggingface.co/org/repo
  const urlMatch = trimmed.match(HF_URL_PATTERN);
  if (urlMatch) {
    return {
      org: urlMatch[1],
      repo: urlMatch[2],
      ollamaName: `hf.co/${urlMatch[1]}/${urlMatch[2]}`,
    };
  }

  // Shorthand without protocol: huggingface.co/org/repo
  const noProtocol = trimmed.replace(/^https?:\/\//, '');
  const hfDomain = noProtocol.match(/^huggingface\.co\/([^/]+)\/([^/]+)\/?$/);
  if (hfDomain) {
    return {
      org: hfDomain[1],
      repo: hfDomain[2],
      ollamaName: `hf.co/${hfDomain[1]}/${hfDomain[2]}`,
    };
  }

  // Already in hf.co shorthand
  const shortMatch = trimmed.match(HF_SHORT_PATTERN);
  if (shortMatch) {
    return {
      org: shortMatch[1],
      repo: shortMatch[2],
      ollamaName: `hf.co/${shortMatch[1]}/${shortMatch[2]}`,
    };
  }

  return null;
}

/**
 * Check whether an input string looks like a HuggingFace reference.
 */
export function isHuggingFaceRef(input: string): boolean {
  return parseHuggingFaceRef(input) !== null;
}

/**
 * Fetch available GGUF files from a HuggingFace repo.
 * Uses the HF API to list repo files and filters for `.gguf` extensions.
 *
 * Returns an empty array if the repo doesn't exist, has no GGUF files,
 * or the API is unreachable.
 */
export async function listGGUFFiles(ref: HFModelRef): Promise<GGUFFile[]> {
  try {
    const response = await fetch(`https://huggingface.co/api/models/${ref.org}/${ref.repo}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return [];

    const data = (await response.json()) as {
      siblings?: Array<{ rfilename: string; size?: number }>;
    };

    if (!data.siblings) return [];

    return data.siblings
      .filter((f) => f.rfilename.endsWith('.gguf'))
      .map((f) => ({
        filename: f.rfilename,
        size: f.size ?? 0,
        ollamaName: `hf.co/${ref.org}/${ref.repo}:${f.rfilename}`,
      }))
      .sort((a, b) => a.size - b.size);
  } catch {
    return [];
  }
}

/**
 * Format a file size in bytes to a human-readable string.
 */
export function formatSize(bytes: number): string {
  if (bytes === 0) return 'unknown size';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}
