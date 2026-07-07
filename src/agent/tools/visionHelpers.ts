/**
 * Vision-tool helpers — pure/near-pure utilities shared by the screenshot and
 * analyze executors in vision.ts: screenshots-dir resolution, URL/selector
 * SSRF guards, a cheap pre-VLM image heuristic, vision-model detection, tunable
 * caps, and a process-scoped sliding-window rate limiter.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../../config/settings.js';
import { getRoot } from './shared.js';
import type { ToolExecutorContext } from './shared.js';

/** Resolve and ensure the screenshots directory exists. Returns the absolute path. */
export async function ensureScreenshotsDir(context?: ToolExecutorContext): Promise<string> {
  const config = context?.config ?? getConfig();
  const base = config.visualVerifyScreenshotsDir || '.sidecar/screenshots';
  const dir = path.isAbsolute(base) ? base : path.join(getRoot(), base);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

/** Slugify a URL for use in a filename. */
export function urlSlug(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 60);
}

/**
 * Reject CSS selectors that could exploit Playwright's XPath engine or inject
 * unexpected input into the browser context.
 *
 * Blocked patterns:
 *   /  or  //  — XPath selectors (Playwright evaluates these as XPath, not CSS)
 *   <          — HTML-injection attempt; not valid CSS
 *   null bytes / C0 control chars — unexpected in any legitimate selector
 *
 * Returns an error string if the selector is invalid, or null if it is allowed.
 */
export function validateCssSelector(sel: string): string | null {
  if (!sel || sel.trim().length === 0) return 'Error: selector must not be empty.';
  if (sel.length > 2000) return 'Error: selector exceeds maximum allowed length.';
  if (sel.startsWith('/')) {
    return 'Error: XPath selectors (starting with "/") are not allowed. Use a CSS selector instead.';
  }
  if (sel.startsWith('<')) {
    return 'Error: selector must not start with "<". Use a CSS selector instead.';
  }
  // Null bytes and C0 control chars (except tab/newline which CSS allows)
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(sel)) {
    return 'Error: selector contains invalid control characters.';
  }
  return null;
}

/**
 * Reject URLs that could be used for SSRF: file://, non-http(s) schemes,
 * loopback addresses, link-local (169.254.x.x), and RFC 1918 private ranges.
 * Returns an error string if the URL is blocked, or null if it is allowed.
 */
export function validateScreenshotUrl(rawUrl: string, allowedDomains?: string[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `Error: invalid URL: ${rawUrl}`;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Error: only http:// and https:// URLs are allowed (got "${parsed.protocol}").`;
  }

  const host = parsed.hostname.toLowerCase();

  // Loopback
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) {
    if (allowedDomains?.includes(host)) return null;
    return `Error: loopback URLs are blocked (${host}). Add to sidecar.visualVerify.allowedDomains to permit.`;
  }

  // Link-local (169.254.x.x) — AWS/GCP metadata endpoint lives here
  if (/^169\.254\./.test(host)) {
    return `Error: link-local URLs are blocked (${host}).`;
  }

  // RFC 1918 private ranges
  if (/^10\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) || /^192\.168\./.test(host)) {
    if (allowedDomains?.some((d) => host === d || host.endsWith(`.${d}`))) return null;
    return `Error: private network URLs are blocked (${host}). Add to sidecar.visualVerify.allowedDomains to permit.`;
  }

  return null;
}

/**
 * Cheap heuristic pre-filter before calling the VLM.
 * Returns a failure reason string if an obvious problem is detected, or null if the
 * image looks worth sending to the VLM.
 *
 * Uses only Node.js Buffer reads — no extra dependencies.
 */
export async function cheapScreenshotChecks(imagePath: string): Promise<string | null> {
  let size: number;
  try {
    size = (await fs.promises.stat(imagePath)).size;
  } catch {
    return 'File not found or not readable.';
  }

  // Blank canvas heuristic: a valid screenshot of any content should be
  // larger than 2 KB. PNGs with solid fills compress extremely well and
  // come in under this threshold reliably.
  if (size < 2048) {
    return `Image appears to be blank (file size ${size} bytes < 2 KB). The rendered output may be empty or failed to load.`;
  }

  // Edge-clipping heuristic: read the PNG header bytes to check for
  // solid-color fills without needing to decode the image.
  let buf: Buffer;
  try {
    const fh = await fs.promises.open(imagePath, 'r');
    try {
      const readBuf = Buffer.alloc(Math.min(size, 65536));
      const { bytesRead } = await fh.read(readBuf, 0, readBuf.length, 0);
      buf = readBuf.slice(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return null; // can't read — let the VLM decide
  }

  // PNG magic bytes: 0x89 0x50 0x4e 0x47 0x0d 0x0a 0x1a 0x0a
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (buf[i] !== PNG_MAGIC[i]) return null; // not a PNG; skip clipping check
  }

  // Scan the first 512 bytes after the PNG header for a run of identical
  // high-value bytes that would suggest the border is solid (clipped output).
  // This is a proxy for the border-pixel check without decoding the image.
  const sample = buf.slice(8, Math.min(buf.length, 520));
  let runByte = -1;
  let runLen = 0;
  let maxRun = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === runByte) {
      runLen++;
      if (runLen > maxRun) maxRun = runLen;
    } else {
      runByte = b;
      runLen = 1;
    }
  }

  // If more than 80% of the header sample bytes are identical and in the
  // extreme range (>200 or <20), flag as possibly clipped.
  const ratio = maxRun / sample.length;
  if (ratio > 0.8 && (runByte > 200 || runByte < 20)) {
    return `Image may be clipped or contain a solid-color border (${Math.round(ratio * 100)}% homogeneous header bytes). The plot or component may be rendering outside its canvas.`;
  }

  return null;
}

/**
 * Detect whether the currently configured backend supports vision.
 * Covers Anthropic Claude 3+ models, GPT-4o family, and common Ollama
 * vision models (LLaVA, BakLLaVA, MiniCPM-V, Moondream).
 */
export function hasVisionSupport(model: string): boolean {
  const m = model.toLowerCase();
  // Anthropic Claude 3+ all support vision
  if (/claude-3|claude-opus|claude-sonnet|claude-haiku/.test(m)) return true;
  // OpenAI GPT-4o family
  if (/gpt-4o|gpt-4-vision/.test(m)) return true;
  // Common Ollama vision models
  if (/llava|bakllava|moondream|minicpm-v/.test(m)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Image resolution cap — resizePngBuffer imported from pngUtils.ts by vision.ts
// ---------------------------------------------------------------------------

/** Max pixels sent to VLM (~1440p equivalent). Above this the image is downsampled. */
export const MAX_VLM_PIXELS = 2_073_600; // 1920×1080
/** Max viewport dimensions clamped in screenshot_page. */
export const MAX_VIEWPORT_WIDTH = 2048;
export const MAX_VIEWPORT_HEIGHT = 1440;
/** Max characters for the criteria parameter in analyze_screenshot. */
export const MAX_CRITERIA_LENGTH = 2000;
/** Confidence threshold below which the verdict is flagged as uncertain. */
export const BORDERLINE_CONFIDENCE = 0.6;

// ---------------------------------------------------------------------------
// Rate limiter — sliding-window, process-scoped
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 60_000;
export const RATE_LIMIT_SCREENSHOT = 20;
export const RATE_LIMIT_ANALYZE = 10;
const _rateLimitTimestamps = new Map<string, number[]>();

/** Returns an error string when the rate limit is exceeded, or null to allow. */
export function checkVisionRateLimit(tool: string, maxPerMinute: number): string | null {
  const now = Date.now();
  const timestamps = _rateLimitTimestamps.get(tool) ?? [];
  const fresh = timestamps.filter((ts) => now - ts < RATE_WINDOW_MS);
  if (fresh.length >= maxPerMinute) {
    const retryMs = RATE_WINDOW_MS - (now - fresh[0]);
    return `Rate limit: ${tool} allows ${maxPerMinute} calls/min. Retry in ${Math.ceil(retryMs / 1000)}s.`;
  }
  fresh.push(now);
  _rateLimitTimestamps.set(tool, fresh);
  return null;
}

/** Reset all rate-limit state. Call in test afterEach to prevent cross-test bleed. */
export function resetVisionRateLimits(): void {
  _rateLimitTimestamps.clear();
}
