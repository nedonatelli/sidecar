/**
 * Vision tools — Screenshot-in-the-Loop visual verification.
 *
 * screenshot_page      — capture a URL as PNG via Playwright headless Chromium.
 * analyze_screenshot   — cheap heuristic pre-filter + VLM vision verdict.
 * open_in_browser      — open a URL in VS Code's Simple Browser panel.
 * run_playwright_code  — execute arbitrary Playwright TypeScript (always requires approval).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import { commands, Uri, env } from 'vscode';
import { getConfig } from '../../config/settings.js';
import { getRoot } from './shared.js';
import { checkWorkspaceConfigTrust } from '../../config/workspaceTrust.js';
import type { RegisteredTool, ToolExecutorContext } from './shared.js';
import type { ImageContentBlock } from '../../ollama/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve and ensure the screenshots directory exists. Returns the absolute path. */
async function ensureScreenshotsDir(context?: import('./shared.js').ToolExecutorContext): Promise<string> {
  const config = context?.config ?? getConfig();
  const base = config.visualVerifyScreenshotsDir || '.sidecar/screenshots';
  const dir = path.isAbsolute(base) ? base : path.join(getRoot(), base);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

/** Slugify a URL for use in a filename. */
function urlSlug(url: string): string {
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
// Image resolution cap — pure-Node PNG resizer (no native deps)
// ---------------------------------------------------------------------------

/** Max pixels sent to VLM (~1440p equivalent). Above this the image is downsampled. */
const MAX_VLM_PIXELS = 2_073_600; // 1920×1080
/** Max viewport dimensions clamped in screenshot_page. */
const MAX_VIEWPORT_WIDTH = 2048;
const MAX_VIEWPORT_HEIGHT = 1440;
/** Max characters for the criteria parameter in analyze_screenshot. */
const MAX_CRITERIA_LENGTH = 2000;
/** Confidence threshold below which the verdict is flagged as uncertain. */
const BORDERLINE_CONFIDENCE = 0.6;

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function computeCrc32(buf: Buffer): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildPngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(computeCrc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

/**
 * Encode raw pixel data as a minimal PNG (IHDR + single IDAT + IEND).
 * Uses filter type 0 (None) for every row — simpler and fast for downsampled output.
 * Only supports 8-bit RGB (colorType 2) and 8-bit RGBA (colorType 6).
 */
function encodePng(pixels: Buffer, width: number, height: number, colorType: number): Buffer {
  const channels = colorType === 6 ? 4 : 3;
  // One filter byte (0) per row + pixel data.
  const stride = 1 + width * channels;
  const rawData = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    rawData[y * stride] = 0; // filter None
    pixels.copy(rawData, y * stride + 1, y * width * channels, (y + 1) * width * channels);
  }
  const compressed = zlib.deflateSync(rawData);

  const ihdrData = Buffer.allocUnsafe(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = colorType;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    PNG_SIG,
    buildPngChunk('IHDR', ihdrData),
    buildPngChunk('IDAT', compressed),
    buildPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Resize a PNG buffer so total pixel count ≤ maxPixels, using nearest-neighbor
 * sampling. Handles 8-bit non-interlaced RGB (color type 2) and RGBA (color type 6).
 * Returns the original buffer unchanged for unsupported formats or if already small.
 * Uses only Node.js built-ins: Buffer + zlib.
 */
export function resizePngBuffer(buf: Buffer, maxPixels: number): Buffer {
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) return buf;

  // IHDR is always the first chunk, starting at offset 8.
  if (buf.length < 33) return buf;
  const ihdrLen = buf.readUInt32BE(8);
  if (ihdrLen !== 13 || buf.slice(12, 16).toString('ascii') !== 'IHDR') return buf;

  const srcWidth = buf.readUInt32BE(16);
  const srcHeight = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  // IHDR data: width(4)+height(4)+bitDepth(1)+colorType(1)+compression(1)+filter(1)+interlace(1)
  // File offsets: 16+4+4+1+1+1+1 = offset 28 for interlace (29 would be first CRC byte).
  const interlace = buf[28];

  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) return buf;
  if (srcWidth === 0 || srcHeight === 0) return buf;
  if (srcWidth * srcHeight <= maxPixels) return buf;

  // Collect all IDAT chunks.
  const idatParts: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const chunkLen = buf.readUInt32BE(offset);
    const chunkType = buf.slice(offset + 4, offset + 8).toString('ascii');
    if (chunkType === 'IDAT' && offset + 8 + chunkLen <= buf.length) {
      idatParts.push(buf.slice(offset + 8, offset + 8 + chunkLen));
    }
    if (chunkType === 'IEND') break;
    offset += 12 + chunkLen;
  }
  if (idatParts.length === 0) return buf;

  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idatParts));
  } catch {
    return buf;
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = 1 + srcWidth * channels;
  if (raw.length < srcHeight * stride) return buf;

  // Reconstruct pixel rows (undo PNG per-row filters).
  const pixels = Buffer.alloc(srcWidth * srcHeight * channels);
  for (let y = 0; y < srcHeight; y++) {
    const filter = raw[y * stride];
    const rowIn = y * stride + 1;
    const rowOut = y * srcWidth * channels;
    const prevOut = (y - 1) * srcWidth * channels;
    for (let x = 0; x < srcWidth * channels; x++) {
      const filt = raw[rowIn + x];
      const a = x >= channels ? pixels[rowOut + x - channels] : 0;
      const b = y > 0 ? pixels[prevOut + x] : 0;
      const c = y > 0 && x >= channels ? pixels[prevOut + x - channels] : 0;
      let recon: number;
      switch (filter) {
        case 1:
          recon = (filt + a) & 0xff;
          break;
        case 2:
          recon = (filt + b) & 0xff;
          break;
        case 3:
          recon = (filt + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4:
          recon = (filt + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          recon = filt; // filter 0 (None) or unknown
      }
      pixels[rowOut + x] = recon;
    }
  }

  // Compute target dimensions maintaining aspect ratio.
  const scale = Math.sqrt(maxPixels / (srcWidth * srcHeight));
  const dstWidth = Math.max(1, Math.floor(srcWidth * scale));
  const dstHeight = Math.max(1, Math.floor(srcHeight * scale));

  // Nearest-neighbor downsample.
  const dstPixels = Buffer.alloc(dstWidth * dstHeight * channels);
  for (let dy = 0; dy < dstHeight; dy++) {
    const sy = Math.floor((dy / dstHeight) * srcHeight);
    for (let dx = 0; dx < dstWidth; dx++) {
      const sx = Math.floor((dx / dstWidth) * srcWidth);
      const si = (sy * srcWidth + sx) * channels;
      const di = (dy * dstWidth + dx) * channels;
      for (let ch = 0; ch < channels; ch++) dstPixels[di + ch] = pixels[si + ch];
    }
  }

  return encodePng(dstPixels, dstWidth, dstHeight, colorType);
}

// ---------------------------------------------------------------------------
// Rate limiter — sliding-window, process-scoped
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_SCREENSHOT = 20;
const RATE_LIMIT_ANALYZE = 10;
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

// ---------------------------------------------------------------------------
// screenshot_page
// ---------------------------------------------------------------------------

async function screenshotPage(input: Record<string, unknown>, _context?: ToolExecutorContext): Promise<string> {
  const url = input.url as string | undefined;
  if (!url) return 'Error: url is required';

  const rateLimitErr = checkVisionRateLimit('screenshot_page', RATE_LIMIT_SCREENSHOT);
  if (rateLimitErr) return rateLimitErr;

  const cfg = _context?.config ?? getConfig();
  const urlError = validateScreenshotUrl(url, cfg.visualVerifyAllowedDomains);
  if (urlError) return urlError;

  const selector = input.selector as string | undefined;
  const waitForRaw = (input.wait_for as string | undefined) ?? 'load';
  const viewportRaw = input.viewport as { width?: number; height?: number } | undefined;

  // Validate selectors before launching the browser so we fail fast on bad input.
  if (selector) {
    const selErr = validateCssSelector(selector);
    if (selErr) return selErr;
  }
  if (waitForRaw.startsWith('selector:')) {
    const selErr = validateCssSelector(waitForRaw.slice('selector:'.length));
    if (selErr) return selErr;
  }

  // Dynamic require — playwright-core is an optional external dep excluded from
  // the bundle. Using require() rather than import() avoids the compile-time
  // module-resolution check that fires even with `as any` on dynamic imports.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let playwright: any;
  try {
    playwright = require('playwright-core') as unknown;
  } catch {
    return 'Error: playwright-core is not installed. Run `npm install playwright-core` in your extension host environment, then restart VS Code.';
  }

  const screenshotsDir = await ensureScreenshotsDir(_context);
  const timestamp = Date.now();
  const slug = urlSlug(url);
  const outputPath = path.join(screenshotsDir, `${timestamp}-${slug}.png`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any;

  try {
    try {
      browser = await playwright.chromium.launch({ headless: true });
    } catch (launchErr) {
      return `Error: failed to launch browser: ${launchErr instanceof Error ? launchErr.message : String(launchErr)}. Ensure a Chromium browser is installed and playwright-core is set up correctly.`;
    }
    page = await browser.newPage();

    const width = Math.min(viewportRaw?.width ?? 1280, MAX_VIEWPORT_WIDTH);
    const height = Math.min(viewportRaw?.height ?? 800, MAX_VIEWPORT_HEIGHT);
    await page.setViewportSize({ width, height });

    // Determine waitUntil strategy
    let waitUntil: string = 'load';
    let extraWaitMs = 0;
    if (waitForRaw === 'networkidle') {
      waitUntil = 'networkidle';
    } else if (waitForRaw === 'domcontentloaded') {
      waitUntil = 'domcontentloaded';
    } else if (/^\d+$/.test(waitForRaw)) {
      extraWaitMs = Math.min(parseInt(waitForRaw, 10), 30_000);
    }
    // selector:<css> handled below after navigation

    await page.goto(url, { waitUntil, timeout: 30000 });

    if (extraWaitMs > 0) {
      await page.waitForTimeout(extraWaitMs);
    }

    if (waitForRaw.startsWith('selector:')) {
      const sel = waitForRaw.slice('selector:'.length);
      await page.waitForSelector(sel, { timeout: 10000 });
    }

    if (selector) {
      await page.locator(selector).screenshot({ path: outputPath });
    } else {
      await page.screenshot({ path: outputPath, fullPage: false });
    }
  } finally {
    try {
      await page?.close();
    } catch {
      /* ignore */
    }
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }

  return `Screenshot saved: ${outputPath}`;
}

// ---------------------------------------------------------------------------
// analyze_screenshot
// ---------------------------------------------------------------------------

async function analyzeScreenshot(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const rawPath = input.image_path as string | undefined;
  const criteria = input.criteria as string | undefined;
  if (!rawPath) return 'Error: image_path is required';
  if (!criteria) return 'Error: criteria is required';
  if (criteria.length > MAX_CRITERIA_LENGTH) {
    return `Error: criteria exceeds ${MAX_CRITERIA_LENGTH}-character limit (got ${criteria.length}). Split into multiple analyze_screenshot calls.`;
  }

  const rateLimitErr = checkVisionRateLimit('analyze_screenshot', RATE_LIMIT_ANALYZE);
  if (rateLimitErr) return rateLimitErr;

  const config = context?.config ?? getConfig();

  // Reject absolute paths — same guard as read_file.
  if (path.isAbsolute(rawPath)) {
    return `Error: absolute paths are not allowed for image_path. Use a workspace-relative path (e.g. ".sidecar/screenshots/file.png").`;
  }
  const root = getRoot();
  if (!root) {
    return 'Error: no workspace is open. Open a project folder before using analyze_screenshot.';
  }
  const imagePath = path.resolve(root, rawPath);
  // Containment check: resolved path must stay inside the workspace root.
  if (!imagePath.startsWith(root + path.sep) && imagePath !== root) {
    return `Error: image_path resolves outside the workspace root (${imagePath}). Use a path within the project directory.`;
  }

  if (config.visualVerifyCheapChecksOnly) {
    const preFilterResult = await cheapScreenshotChecks(imagePath);
    if (preFilterResult) {
      return `Visual check failed (pre-filter): ${preFilterResult}\n\n{"pass":false,"issues":["${preFilterResult.replace(/"/g, '\\"')}"]}`;
    }
    return `Pre-filter passed (cheap checks only — VLM analysis skipped).\n\n{"pass":true,"issues":[]}`;
  }

  // Run cheap pre-filter first — fail fast without a VLM call.
  const preFilterFailure = await cheapScreenshotChecks(imagePath);
  if (preFilterFailure) {
    return `Visual check failed (pre-filter, no VLM call): ${preFilterFailure}\n\n{"pass":false,"issues":["${preFilterFailure.replace(/"/g, '\\"')}"]}`;
  }

  // Determine which model to use for vision analysis.
  const modelOverride = (input.model as string | undefined) || config.visualVerifyVlm || undefined;
  const activeModel = modelOverride ?? config.model;

  if (!hasVisionSupport(activeModel)) {
    return (
      `Error: the current model "${activeModel}" does not appear to support vision. ` +
      `Set sidecar.visualVerify.vlm to a vision-capable model (e.g. "claude-sonnet-4-6", "gpt-4o", "llava") ` +
      `or switch to a vision-capable backend.`
    );
  }

  // Read the image, resize if over the VLM pixel budget, then encode as base64.
  let imageData: string;
  try {
    const raw = await fs.promises.readFile(imagePath);
    const resized = resizePngBuffer(raw, MAX_VLM_PIXELS);
    imageData = resized.toString('base64');
  } catch (err) {
    return `Error reading image file: ${String(err)}`;
  }

  // Determine media type from extension.
  const ext = path.extname(imagePath).toLowerCase();
  const mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' =
    ext === '.jpg' || ext === '.jpeg'
      ? 'image/jpeg'
      : ext === '.webp'
        ? 'image/webp'
        : ext === '.gif'
          ? 'image/gif'
          : 'image/png';

  const imageBlock: ImageContentBlock = {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: imageData },
  };

  const systemPrompt =
    'You are a visual verification assistant. Analyze the provided screenshot against the stated criteria. ' +
    'Respond ONLY with a JSON object: { "pass": boolean, "confidence": number, "issues": string[] }. ' +
    '"pass" is true when all criteria are met. ' +
    '"confidence" is a number 0.0–1.0: 1.0 = completely certain, 0.5 = borderline/ambiguous, 0.0 = completely uncertain. ' +
    '"issues" is an empty array when pass is true, ' +
    'or a list of specific, actionable problem descriptions when pass is false. ' +
    'Be precise: name the exact visual element that fails and describe what is wrong.';

  const userPrompt = `Criteria to verify:\n${criteria}`;

  // Use the client from context if available, otherwise fall back to the
  // process-wide client. We make a direct vision call like criticHook does.
  const client = context?.client;
  if (!client) {
    return 'Error: no SideCarClient available in tool context. This tool requires an active agent session.';
  }

  let raw: string;
  try {
    raw = await client.completeWithOverrides(
      systemPrompt,
      [{ role: 'user', content: [imageBlock, { type: 'text', text: userPrompt }] }],
      modelOverride,
      512,
      context?.signal ?? new AbortController().signal,
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return 'Analysis aborted.';
    return `Error calling VLM for vision analysis: ${String(err)}`;
  }

  // Parse the verdict. The model should return JSON but may wrap it in markdown.
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return `VLM response could not be parsed as JSON. Raw response:\n${raw}`;
  }

  let verdict: { pass: boolean; confidence: number; issues: string[] };
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { pass: boolean; confidence: unknown; issues: unknown };
    // Normalise issues: the model occasionally returns a plain string.
    const rawIssues = parsed.issues;
    const issues: string[] = Array.isArray(rawIssues)
      ? (rawIssues as unknown[]).map(String)
      : typeof rawIssues === 'string'
        ? [rawIssues]
        : [];
    // confidence defaults to 0.9 when the model omits it (pre-prompt models).
    const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.9;
    verdict = { pass: Boolean(parsed.pass), confidence, issues };
  } catch {
    return `VLM response JSON parse error. Raw response:\n${raw}`;
  }

  const lowConfidenceTag =
    verdict.confidence < BORDERLINE_CONFIDENCE
      ? ` ⚠ low confidence (${verdict.confidence.toFixed(2)}) — verify manually`
      : '';

  const summary = verdict.pass
    ? `✓ Visual check passed${lowConfidenceTag}.`
    : `✗ Visual check failed${lowConfidenceTag} — ${verdict.issues.length} issue${verdict.issues.length === 1 ? '' : 's'}:\n${verdict.issues.map((i) => `  • ${i}`).join('\n')}`;

  return `${summary}\n\n${JSON.stringify(verdict)}`;
}

// ---------------------------------------------------------------------------
// open_in_browser
// ---------------------------------------------------------------------------

async function openInBrowser(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const url = input.url as string | undefined;
  if (!url) return 'Error: url is required';

  const cfg = context?.config ?? getConfig();
  const urlError = validateScreenshotUrl(url, cfg.visualVerifyAllowedDomains);
  if (urlError) return urlError;

  const uri = Uri.parse(url);
  try {
    // VS Code Simple Browser is available in VS Code 1.60+.
    await commands.executeCommand('simpleBrowser.show', uri);
    return `Opened in VS Code Simple Browser: ${url}`;
  } catch {
    // Fallback: open in the system browser via vscode.env.openExternal.
    try {
      await env.openExternal(uri);
      return `Opened in external browser: ${url}`;
    } catch (err) {
      return `Error opening URL: ${String(err)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// run_playwright_code
// ---------------------------------------------------------------------------

async function runPlaywrightCode(input: Record<string, unknown>): Promise<string> {
  const script = input.script as string | undefined;
  const timeoutMs = typeof input.timeout_ms === 'number' ? Math.min(input.timeout_ms, 120_000) : 30_000;
  if (!script) return 'Error: script is required';

  // Workspace trust gate — same pattern as shell hooks and MCP servers.
  const trusted = await checkWorkspaceConfigTrust(
    'run_playwright_code',
    'run_playwright_code executes arbitrary Playwright scripts in a Node.js child process. Grant trust only for workspaces you own.',
  );
  if (trusted !== 'trusted')
    return 'Error: workspace is not trusted. Grant trust in the SideCar trust prompt to run Playwright scripts.';

  // Write script to a temp file.
  const tmpDir = path.join(os.tmpdir(), 'sidecar-playwright');
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const scriptPath = path.join(tmpDir, `script-${Date.now()}.mjs`);

  try {
    await fs.promises.writeFile(scriptPath, script, 'utf-8');
  } catch (err) {
    return `Error writing script to temp file: ${String(err)}`;
  }

  // Transpile TypeScript to ESM with esbuild's transform API (already bundled).
  try {
    type EsbuildTransformer = { transform(src: string, opts: Record<string, unknown>): Promise<{ code: string }> };
    const esbuild = (await import('esbuild')) as unknown as EsbuildTransformer;
    const result = await esbuild.transform(script, { loader: 'ts', format: 'esm', target: 'node18' });
    await fs.promises.writeFile(scriptPath, result.code, 'utf-8');
  } catch {
    // If esbuild isn't available as a module (shouldn't happen since it's
    // used for bundling), fall through and try running the raw script.
  }

  return new Promise((resolve) => {
    const { spawn } = require('child_process') as typeof import('child_process');

    // Whitelist safe env vars — never expose API keys or credentials to
    // LLM-generated scripts. Only the vars needed to locate binaries and
    // temporary directories are forwarded.
    const safeEnvKeys = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'TERM', 'LANG', 'LC_ALL'];
    const childEnv: Record<string, string> = {};
    for (const key of safeEnvKeys) {
      const val = process.env[key];
      if (val !== undefined) childEnv[key] = val;
    }

    const ac = new AbortController();
    const killTimer = setTimeout(() => ac.abort(), timeoutMs);

    const child = spawn(process.execPath, [scriptPath], {
      env: childEnv,
      signal: ac.signal,
    });

    const chunks: string[] = [];
    const errChunks: string[] = [];
    child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.stderr?.on('data', (d: Buffer) => errChunks.push(d.toString()));

    child.on('close', (code: number | null, signal: string | null) => {
      clearTimeout(killTimer);
      const stdout = chunks.join('');
      const stderr = errChunks.join('');
      let result: string;
      if (signal === 'SIGTERM' || ac.signal.aborted) {
        result = `Script timed out after ${timeoutMs}ms.`;
      } else if (code !== 0) {
        result = `Script exited with code ${code}.\nstderr:\n${stderr}\nstdout:\n${stdout}`;
      } else {
        result = stdout || '(script completed with no stdout output)';
      }
      void fs.promises
        .unlink(scriptPath)
        .catch(() => {})
        .then(() => resolve(result));
    });

    child.on('error', (err: Error) => {
      clearTimeout(killTimer);
      void fs.promises.unlink(scriptPath).catch(() => {});
      resolve(`Error executing script: ${err.message}`);
    });
  });
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export const visionTools: RegisteredTool[] = [
  {
    definition: {
      name: 'screenshot_page',
      description:
        'Capture a screenshot of a URL using a headless Chromium browser (via playwright-core). ' +
        'Saves the PNG to .sidecar/screenshots/ and returns the absolute file path. ' +
        'Chain with analyze_screenshot to get a visual verdict. ' +
        'Requires playwright-core to be installed in the extension host environment. ' +
        'Example: `screenshot_page(url="http://localhost:5173", wait_for="networkidle")` → "/workspace/.sidecar/screenshots/1234-localhost.png".',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to capture (http://, https://, or file://)' },
          selector: {
            type: 'string',
            description: 'Optional CSS selector — screenshot only the matching element instead of the full viewport',
          },
          wait_for: {
            type: 'string',
            description:
              'Readiness condition before capturing. Options: "load" (default), "networkidle", "domcontentloaded", "selector:<css>" (wait for element), or a number of milliseconds.',
          },
          viewport: {
            type: 'object',
            description: 'Viewport size (default: 1280×800)',
            properties: {
              width: { type: 'number' },
              height: { type: 'number' },
            },
          },
        },
        required: ['url'],
      },
    },
    executor: screenshotPage,
    requiresApproval: false,
  },
  {
    definition: {
      name: 'analyze_screenshot',
      description:
        'Analyze a screenshot against stated visual criteria using a vision-capable model. ' +
        'Runs a fast heuristic pre-filter (blank canvas, edge clipping) before calling the VLM. ' +
        'Returns a structured verdict: { pass: boolean, issues: string[] }. ' +
        'Works on any local PNG/JPEG file — use after screenshot_page or after running a script that generates an image. ' +
        'Example: `analyze_screenshot(image_path="output.png", criteria="axes are labeled, no clipping, -3dB near 1kHz")`. ' +
        'Requires a vision-capable model (Claude 3+, GPT-4o, or an Ollama vision model like llava).',
      input_schema: {
        type: 'object',
        properties: {
          image_path: {
            type: 'string',
            description: 'Workspace-relative path to the image file (e.g. ".sidecar/screenshots/file.png")',
          },
          criteria: {
            type: 'string',
            description: 'Human-readable description of what the image should show (the success criteria)',
          },
          model: {
            type: 'string',
            description: 'Optional vision model override. Defaults to sidecar.visualVerify.vlm or the active model.',
          },
        },
        required: ['image_path', 'criteria'],
      },
    },
    executor: analyzeScreenshot,
    requiresApproval: false,
  },
  {
    definition: {
      name: 'open_in_browser',
      description:
        "Open a URL in VS Code's built-in Simple Browser panel so the user can see what the agent is looking at. " +
        'Falls back to the system browser if Simple Browser is unavailable. ' +
        'Use after screenshot_page for user transparency — show the same page the agent just captured. ' +
        'Example: `open_in_browser(url="http://localhost:5173")`.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open (http://, https://, or file://)' },
        },
        required: ['url'],
      },
    },
    executor: openInBrowser,
    requiresApproval: false,
  },
  {
    definition: {
      name: 'run_playwright_code',
      description:
        'Execute a Playwright TypeScript script for complex browser interactions: clicking buttons, filling forms, ' +
        'waiting for animations, then capturing screenshots. ' +
        'The script runs in a Node.js child process with playwright-core available. ' +
        'Returns stdout from the script. ' +
        'ALWAYS requires user approval regardless of agent mode — this is a code-execution tool. ' +
        'Example script: `import { chromium } from "playwright-core"; const b = await chromium.launch(); const p = await b.newPage(); await p.goto("http://localhost:5173"); await p.click("#submit"); await p.screenshot({ path: "result.png" }); await b.close();`',
      input_schema: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'Playwright TypeScript script to execute. Use playwright-core imports.',
          },
          timeout_ms: {
            type: 'number',
            description: 'Script execution timeout in milliseconds (default: 30000, max: 120000)',
          },
        },
        required: ['script'],
      },
    },
    executor: runPlaywrightCode,
    requiresApproval: true,
    alwaysRequireApproval: true,
  },
];
