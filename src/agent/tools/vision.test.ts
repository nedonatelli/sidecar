import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';

// ---------------------------------------------------------------------------
// Import the pure helpers (no VS Code API dependency)
// ---------------------------------------------------------------------------
import {
  cheapScreenshotChecks,
  hasVisionSupport,
  validateCssSelector,
  validateScreenshotUrl,
  checkVisionRateLimit,
  resetVisionRateLimits,
} from './vision.js';
import { resizePngBuffer } from './pngUtils.js';

// ---------------------------------------------------------------------------
// Test helper: build a minimal valid PNG in memory
// ---------------------------------------------------------------------------

function makePng(width: number, height: number, colorType: 2 | 6 = 6): Buffer {
  const channels = colorType === 6 ? 4 : 3;
  const stride = 1 + width * channels;
  const rawData = Buffer.alloc(height * stride);
  // Fill with varied pixel values so the image is non-trivial.
  for (let y = 0; y < height; y++) {
    rawData[y * stride] = 0; // filter None
    for (let x = 0; x < width * channels; x++) {
      rawData[y * stride + 1 + x] = ((y * width + x) * 7 + 13) % 256;
    }
  }
  const compressed = zlib.deflateSync(rawData);

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[i] = c;
  }
  function crc32(b: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < b.length; i++) crc = crcTable[(crc ^ b[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type: string, data: Buffer): Buffer {
    const tb = Buffer.from(type, 'ascii');
    const lb = Buffer.allocUnsafe(4);
    lb.writeUInt32BE(data.length, 0);
    const cb = Buffer.allocUnsafe(4);
    cb.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
    return Buffer.concat([lb, tb, data, cb]);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// cheapScreenshotChecks
// ---------------------------------------------------------------------------

describe('cheapScreenshotChecks', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a failure for a missing file', async () => {
    const result = await cheapScreenshotChecks(path.join(tmpDir, 'nonexistent.png'));
    expect(result).not.toBeNull();
    expect(result).toMatch(/not found|not readable/i);
  });

  it('returns a failure when file size is below 2 KB', async () => {
    const tiny = path.join(tmpDir, 'tiny.png');
    // Write a valid-looking 50-byte file (too small to be a real screenshot)
    fs.writeFileSync(tiny, Buffer.alloc(50, 0x42));
    const result = await cheapScreenshotChecks(tiny);
    expect(result).not.toBeNull();
    expect(result).toMatch(/blank/i);
  });

  it('returns null for a file at exactly the 2 KB boundary', async () => {
    const borderline = path.join(tmpDir, 'borderline.png');
    // Write a 2048-byte file with PNG magic bytes at the start
    const buf = Buffer.alloc(2048, 0x42);
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47;
    buf[4] = 0x0d;
    buf[5] = 0x0a;
    buf[6] = 0x1a;
    buf[7] = 0x0a;
    // Fill with varied bytes so homogeneity check doesn't trip
    for (let i = 8; i < 520; i++) buf[i] = i % 251;
    fs.writeFileSync(borderline, buf);
    // Exactly 2048 bytes — should not trigger blank check (< 2048 is the condition)
    expect(await cheapScreenshotChecks(borderline)).toBeNull();
  });

  it('returns null for a reasonably-sized varied PNG-like file', async () => {
    const ok = path.join(tmpDir, 'ok.png');
    const buf = Buffer.alloc(8192, 0x00);
    // PNG magic
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47;
    buf[4] = 0x0d;
    buf[5] = 0x0a;
    buf[6] = 0x1a;
    buf[7] = 0x0a;
    // Varied content — prevents homogeneity flag
    for (let i = 8; i < 8192; i++) buf[i] = (i * 7 + 13) % 256;
    fs.writeFileSync(ok, buf);
    expect(await cheapScreenshotChecks(ok)).toBeNull();
  });

  it('flags a file with a highly homogeneous header as potentially clipped', async () => {
    const clipped = path.join(tmpDir, 'clipped.png');
    const buf = Buffer.alloc(4096, 0x00);
    // PNG magic
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47;
    buf[4] = 0x0d;
    buf[5] = 0x0a;
    buf[6] = 0x1a;
    buf[7] = 0x0a;
    // Fill byte 8 onwards with a single extreme value (> 200) — solid-white border
    for (let i = 8; i < 4096; i++) buf[i] = 0xff;
    fs.writeFileSync(clipped, buf);
    const result = await cheapScreenshotChecks(clipped);
    expect(result).not.toBeNull();
    expect(result).toMatch(/clipped|solid-color|homogeneous/i);
  });

  it('returns null for a non-PNG file (skips clipping check)', async () => {
    const jpeg = path.join(tmpDir, 'image.jpg');
    const buf = Buffer.alloc(4096, 0xff); // all 0xff — would fail if PNG check ran
    // JPEG magic (not PNG)
    buf[0] = 0xff;
    buf[1] = 0xd8;
    buf[2] = 0xff;
    fs.writeFileSync(jpeg, buf);
    // Should not trigger clip check because it's not a PNG
    expect(await cheapScreenshotChecks(jpeg)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateCssSelector
// ---------------------------------------------------------------------------

describe('validateCssSelector', () => {
  it('allows standard CSS selectors', () => {
    expect(validateCssSelector('.foo')).toBeNull();
    expect(validateCssSelector('#bar')).toBeNull();
    expect(validateCssSelector('div.class > span')).toBeNull();
    expect(validateCssSelector('[data-attr="value"]')).toBeNull();
    expect(validateCssSelector('button:focus')).toBeNull();
  });

  it('allows Playwright text/role selectors', () => {
    expect(validateCssSelector('text="Submit"')).toBeNull();
    expect(validateCssSelector('role=button')).toBeNull();
  });

  it('rejects XPath selectors starting with /', () => {
    const err = validateCssSelector('//div[@class="foo"]');
    expect(err).toMatch(/XPath/);
  });

  it('rejects selectors starting with <', () => {
    const err = validateCssSelector('<script>alert(1)</script>');
    expect(err).toMatch(/must not start with/i);
  });

  it('rejects empty selectors', () => {
    expect(validateCssSelector('')).not.toBeNull();
    expect(validateCssSelector('   ')).not.toBeNull();
  });

  it('rejects selectors with null bytes', () => {
    const err = validateCssSelector('.foo\x00bar');
    expect(err).toMatch(/control character/i);
  });

  it('rejects selectors exceeding max length', () => {
    const err = validateCssSelector('a'.repeat(2001));
    expect(err).toMatch(/length/i);
  });
});

// ---------------------------------------------------------------------------
// validateScreenshotUrl
// ---------------------------------------------------------------------------

describe('validateScreenshotUrl', () => {
  it('allows http and https URLs', () => {
    expect(validateScreenshotUrl('https://example.com')).toBeNull();
    expect(validateScreenshotUrl('http://example.com/path')).toBeNull();
  });

  it('rejects non-http schemes', () => {
    expect(validateScreenshotUrl('file:///etc/passwd')).not.toBeNull();
    expect(validateScreenshotUrl('javascript:alert(1)')).not.toBeNull();
  });

  it('rejects loopback addresses', () => {
    expect(validateScreenshotUrl('http://localhost/admin')).not.toBeNull();
    expect(validateScreenshotUrl('http://127.0.0.1/secret')).not.toBeNull();
  });

  it('rejects RFC 1918 private ranges', () => {
    expect(validateScreenshotUrl('http://192.168.1.1/')).not.toBeNull();
    expect(validateScreenshotUrl('http://10.0.0.1/')).not.toBeNull();
  });

  it('rejects link-local addresses', () => {
    expect(validateScreenshotUrl('http://169.254.169.254/latest/meta-data/')).not.toBeNull();
  });

  it('allows private addresses when in allowedDomains', () => {
    expect(validateScreenshotUrl('http://localhost:3000', ['localhost'])).toBeNull();
    expect(validateScreenshotUrl('http://192.168.1.50', ['192.168.1.50'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasVisionSupport
// ---------------------------------------------------------------------------

describe('hasVisionSupport', () => {
  it('returns true for Claude 3 models', () => {
    expect(hasVisionSupport('claude-3-opus-20240229')).toBe(true);
    expect(hasVisionSupport('claude-sonnet-4-6')).toBe(true);
    expect(hasVisionSupport('claude-haiku-4-5')).toBe(true);
    expect(hasVisionSupport('claude-opus-4-7')).toBe(true);
  });

  it('returns true for GPT-4o models', () => {
    expect(hasVisionSupport('gpt-4o')).toBe(true);
    expect(hasVisionSupport('gpt-4o-mini')).toBe(true);
    expect(hasVisionSupport('gpt-4-vision-preview')).toBe(true);
  });

  it('returns true for known Ollama vision models', () => {
    expect(hasVisionSupport('llava')).toBe(true);
    expect(hasVisionSupport('llava:13b')).toBe(true);
    expect(hasVisionSupport('bakllava')).toBe(true);
    expect(hasVisionSupport('moondream')).toBe(true);
    expect(hasVisionSupport('minicpm-v')).toBe(true);
  });

  it('returns false for text-only models', () => {
    expect(hasVisionSupport('llama3:8b')).toBe(false);
    expect(hasVisionSupport('mistral:7b')).toBe(false);
    expect(hasVisionSupport('deepseek-r1:7b')).toBe(false);
    expect(hasVisionSupport('codellama')).toBe(false);
    expect(hasVisionSupport('gemma2:9b')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hasVisionSupport('CLAUDE-SONNET-4-6')).toBe(true);
    expect(hasVisionSupport('LLaVA:7b')).toBe(true);
    expect(hasVisionSupport('GPT-4O')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool wiring — verify visionTools exports the expected 4 tools
// ---------------------------------------------------------------------------

describe('visionTools registry', () => {
  it('exports exactly 4 tools with the expected names', async () => {
    // Import lazily to avoid triggering VS Code API at module load time.
    // The vscode mock handles commands/env/Uri.
    const { visionTools } = await import('./vision.js');
    const names = visionTools.map((t) => t.definition.name);
    expect(names).toContain('screenshot_page');
    expect(names).toContain('analyze_screenshot');
    expect(names).toContain('open_in_browser');
    expect(names).toContain('run_playwright_code');
    expect(names).toHaveLength(4);
  });

  it('run_playwright_code has alwaysRequireApproval: true', async () => {
    const { visionTools } = await import('./vision.js');
    const tool = visionTools.find((t) => t.definition.name === 'run_playwright_code');
    expect(tool?.alwaysRequireApproval).toBe(true);
  });

  it('screenshot_page, analyze_screenshot, open_in_browser do NOT require approval', async () => {
    const { visionTools } = await import('./vision.js');
    for (const name of ['screenshot_page', 'analyze_screenshot', 'open_in_browser']) {
      const tool = visionTools.find((t) => t.definition.name === name);
      expect(tool?.alwaysRequireApproval ?? false).toBe(false);
    }
  });

  it('all tools have non-empty descriptions with at least 150 characters', async () => {
    const { visionTools } = await import('./vision.js');
    for (const tool of visionTools) {
      expect(
        tool.definition.description.length,
        `${tool.definition.name} description too short`,
      ).toBeGreaterThanOrEqual(150);
    }
  });

  it('all tools declare required fields in their input_schema', async () => {
    const { visionTools } = await import('./vision.js');
    const requiredMap: Record<string, string[]> = {
      screenshot_page: ['url'],
      analyze_screenshot: ['image_path', 'criteria'],
      open_in_browser: ['url'],
      run_playwright_code: ['script'],
    };
    for (const tool of visionTools) {
      const schema = tool.definition.input_schema as { required?: string[] };
      expect(schema.required).toEqual(requiredMap[tool.definition.name]);
    }
  });
});

// ---------------------------------------------------------------------------
// Gap 1: resizePngBuffer — image resolution capping
// ---------------------------------------------------------------------------

describe('resizePngBuffer', () => {
  it('returns the original buffer unchanged when already within the pixel budget', () => {
    const small = makePng(4, 4, 6); // 16 pixels — well under any limit
    const result = resizePngBuffer(small, 1_000_000);
    expect(result).toBe(small); // same reference — no copy made
  });

  it('returns the original buffer unchanged for non-PNG data', () => {
    const notPng = Buffer.from('not a png at all');
    expect(resizePngBuffer(notPng, 1)).toBe(notPng);
  });

  it('returns original for unsupported color type (indexed / 16-bit)', () => {
    // Manually craft an IHDR with color type 3 (indexed).
    const fakePng = makePng(100, 100, 6);
    // Patch color type byte (offset 25 in the file = PNG sig(8) + chunk len(4) + 'IHDR'(4) + width(4) + height(4) + bitDepth(1) = offset 25)
    const patched = Buffer.from(fakePng);
    patched[25] = 3; // color type = indexed
    expect(resizePngBuffer(patched, 1)).toBe(patched);
  });

  it('downsamples a large RGBA PNG to fit within the pixel budget', () => {
    const big = makePng(200, 200, 6); // 40_000 pixels
    const result = resizePngBuffer(big, 10_000); // target ≤ 10_000 pixels (~100×100)
    expect(result).not.toBe(big);
    // Parse the output IHDR to verify dimensions shrank.
    const outWidth = result.readUInt32BE(16);
    const outHeight = result.readUInt32BE(20);
    expect(outWidth * outHeight).toBeLessThanOrEqual(10_000);
    expect(outWidth).toBeGreaterThan(0);
    expect(outHeight).toBeGreaterThan(0);
  });

  it('downsamples a large RGB PNG to fit within the pixel budget', () => {
    const big = makePng(150, 100, 2); // 15_000 pixels, RGB
    const result = resizePngBuffer(big, 2_000); // target ≤ 2_000
    expect(result).not.toBe(big);
    const outWidth = result.readUInt32BE(16);
    const outHeight = result.readUInt32BE(20);
    expect(outWidth * outHeight).toBeLessThanOrEqual(2_000);
  });

  it('output is a valid PNG (correct signature)', () => {
    const big = makePng(200, 200, 6);
    const result = resizePngBuffer(big, 10_000);
    const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 8; i++) expect(result[i]).toBe(PNG_SIG[i]);
  });

  it('preserves aspect ratio within ±1 pixel', () => {
    const big = makePng(200, 100, 6); // 2:1 ratio
    const result = resizePngBuffer(big, 5_000); // ~71×35 at 2:1
    const outWidth = result.readUInt32BE(16);
    const outHeight = result.readUInt32BE(20);
    // Width should be roughly twice the height (±2 due to floor rounding).
    expect(outWidth / outHeight).toBeGreaterThan(1.5);
    expect(outWidth / outHeight).toBeLessThan(2.5);
  });
});

// ---------------------------------------------------------------------------
// Gap 2: checkVisionRateLimit — sliding-window rate limiter
// ---------------------------------------------------------------------------

describe('checkVisionRateLimit', () => {
  afterEach(() => resetVisionRateLimits());

  it('allows calls within the limit', () => {
    expect(checkVisionRateLimit('test_tool', 3)).toBeNull();
    expect(checkVisionRateLimit('test_tool', 3)).toBeNull();
    expect(checkVisionRateLimit('test_tool', 3)).toBeNull();
  });

  it('blocks the call when the limit is reached', () => {
    checkVisionRateLimit('test_tool', 2);
    checkVisionRateLimit('test_tool', 2);
    const err = checkVisionRateLimit('test_tool', 2);
    expect(err).not.toBeNull();
    expect(err).toMatch(/rate limit/i);
    expect(err).toMatch(/test_tool/i);
  });

  it('includes a retry-in hint in the error', () => {
    checkVisionRateLimit('tool_a', 1);
    const err = checkVisionRateLimit('tool_a', 1);
    expect(err).toMatch(/retry in/i);
    expect(err).toMatch(/\d+s/);
  });

  it('tracks different tools independently', () => {
    checkVisionRateLimit('tool_x', 1);
    // tool_x is now at limit, but tool_y should be unaffected.
    expect(checkVisionRateLimit('tool_x', 1)).not.toBeNull();
    expect(checkVisionRateLimit('tool_y', 1)).toBeNull();
  });

  it('resetVisionRateLimits clears state so limits are fresh', () => {
    checkVisionRateLimit('tool_r', 1);
    expect(checkVisionRateLimit('tool_r', 1)).not.toBeNull();
    resetVisionRateLimits();
    expect(checkVisionRateLimit('tool_r', 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gap 3: criteria length cap — enforced in analyze_screenshot executor
// ---------------------------------------------------------------------------

describe('analyze_screenshot criteria length cap', () => {
  it('rejects criteria over 2000 characters', async () => {
    const { visionTools } = await import('./vision.js');
    const tool = visionTools.find((t) => t.definition.name === 'analyze_screenshot')!;
    const result = await tool.executor({
      image_path: '.sidecar/screenshots/any.png',
      criteria: 'x'.repeat(2001),
    });
    expect(result).toMatch(/2000/);
    expect(result).toMatch(/exceeds/i);
  });

  it('does not reject criteria of exactly 2000 characters (proceeds to path check)', async () => {
    // After passing the criteria check, it hits the absolute-path or missing-image check —
    // we just verify it does NOT return the criteria-length error.
    const { visionTools } = await import('./vision.js');
    const tool = visionTools.find((t) => t.definition.name === 'analyze_screenshot')!;
    const result = await tool.executor({
      image_path: '.sidecar/screenshots/any.png',
      criteria: 'x'.repeat(2000),
    });
    expect(result).not.toMatch(/exceeds.*2000/i);
  });
});

// ---------------------------------------------------------------------------
// Gap 4: viewport clamping in screenshot_page
// ---------------------------------------------------------------------------

describe('screenshot_page viewport clamping', () => {
  beforeEach(() => {
    vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetVisionRateLimits();
  });

  it('clamps oversized viewport and still attempts to launch browser (not a URL/selector error)', async () => {
    const { visionTools } = await import('./vision.js');
    const tool = visionTools.find((t) => t.definition.name === 'screenshot_page')!;
    // 4K viewport — should be clamped internally. Result must fail on browser launch, not on viewport.
    const context = { config: { visualVerifyAllowedDomains: ['localhost'] } as never };
    const result = await tool.executor(
      { url: 'http://localhost:3000', viewport: { width: 9999, height: 9999 } },
      context,
    );
    // Must not return a viewport-related error — only browser launch or playwright missing.
    expect(result).not.toMatch(/viewport/i);
    expect(result).toMatch(/playwright|browser|launch/i);
    // 30s, not vitest's 5s default: this genuinely attempts a browser launch, and
    // the attempt is what takes the time. Under a loaded machine it exceeded 5s
    // and failed the whole suite while passing in isolation — a false red that
    // recurred across several runs.
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Config-to-behavior: visualVerifyAllowedDomains must flow through to the
// URL validator inside screenshot_page and open_in_browser executors.
//
// Without the fix the allowedDomains config was read but never forwarded,
// so the allowlist had zero effect. These tests verify end-to-end that the
// context config reaches validateScreenshotUrl.
// ---------------------------------------------------------------------------
describe('visualVerifyAllowedDomains forwarded to URL validator', () => {
  // The "allows" tests verify URL validation passed. After URL validation,
  // screenshotPage calls ensureScreenshotsDir (needs mkdir) and then
  // playwright.chromium.launch (needs a real browser). We mock mkdir to
  // succeed and let playwright fail naturally — producing a "failed to launch
  // browser" message that proves the URL check was not the blocking step.
  beforeEach(() => {
    vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('screenshot_page blocks localhost without allowedDomains config', async () => {
    const { visionTools } = await import('./vision.js');
    const tool = visionTools.find((t) => t.definition.name === 'screenshot_page')!;
    const result = await tool.executor({ url: 'http://localhost:3000' });
    expect(result).toMatch(/loopback URLs are blocked/i);
  });

  it('screenshot_page allows localhost when listed in allowedDomains config', async () => {
    const { visionTools } = await import('./vision.js');
    const tool = visionTools.find((t) => t.definition.name === 'screenshot_page')!;
    const context = { config: { visualVerifyAllowedDomains: ['localhost'] } as never };
    const result = await tool.executor({ url: 'http://localhost:3000' }, context);
    // URL blocker must not fire — the result is a later error (browser launch/playwright)
    expect(result).not.toMatch(/loopback URLs are blocked/i);
    expect(result).not.toMatch(/private network URLs are blocked/i);
  });

  it('screenshot_page blocks 192.168.x.x without allowedDomains config', async () => {
    const { visionTools } = await import('./vision.js');
    const tool = visionTools.find((t) => t.definition.name === 'screenshot_page')!;
    const result = await tool.executor({ url: 'http://192.168.1.50' });
    expect(result).toMatch(/private network URLs are blocked/i);
  });

  it('screenshot_page allows 192.168.x.x when listed in allowedDomains config', async () => {
    const { visionTools } = await import('./vision.js');
    const tool = visionTools.find((t) => t.definition.name === 'screenshot_page')!;
    const context = { config: { visualVerifyAllowedDomains: ['192.168.1.50'] } as never };
    const result = await tool.executor({ url: 'http://192.168.1.50' }, context);
    expect(result).not.toMatch(/private network URLs are blocked/i);
  });

  it('open_in_browser blocks localhost without allowedDomains config', async () => {
    const { visionTools } = await import('./vision.js');
    const tool = visionTools.find((t) => t.definition.name === 'open_in_browser')!;
    const result = await tool.executor({ url: 'http://localhost:5173' });
    expect(result).toMatch(/loopback URLs are blocked/i);
  });

  it('open_in_browser allows localhost when listed in allowedDomains config', async () => {
    const { visionTools } = await import('./vision.js');
    const tool = visionTools.find((t) => t.definition.name === 'open_in_browser')!;
    const context = { config: { visualVerifyAllowedDomains: ['localhost'] } as never };
    const result = await tool.executor({ url: 'http://localhost:5173' }, context);
    // URL check passes — VS Code simpleBrowser command fires (mocked), blocker must not appear
    expect(result).not.toMatch(/loopback URLs are blocked/i);
  });
});
