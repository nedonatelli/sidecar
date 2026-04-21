import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Import the pure helpers (no VS Code API dependency)
// ---------------------------------------------------------------------------
import { cheapScreenshotChecks, hasVisionSupport } from './vision.js';

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

  it('returns a failure for a missing file', () => {
    const result = cheapScreenshotChecks(path.join(tmpDir, 'nonexistent.png'));
    expect(result).not.toBeNull();
    expect(result).toMatch(/not found|not readable/i);
  });

  it('returns a failure when file size is below 2 KB', () => {
    const tiny = path.join(tmpDir, 'tiny.png');
    // Write a valid-looking 50-byte file (too small to be a real screenshot)
    fs.writeFileSync(tiny, Buffer.alloc(50, 0x42));
    const result = cheapScreenshotChecks(tiny);
    expect(result).not.toBeNull();
    expect(result).toMatch(/blank/i);
  });

  it('returns null for a file at exactly the 2 KB boundary', () => {
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
    expect(cheapScreenshotChecks(borderline)).toBeNull();
  });

  it('returns null for a reasonably-sized varied PNG-like file', () => {
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
    expect(cheapScreenshotChecks(ok)).toBeNull();
  });

  it('flags a file with a highly homogeneous header as potentially clipped', () => {
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
    const result = cheapScreenshotChecks(clipped);
    expect(result).not.toBeNull();
    expect(result).toMatch(/clipped|solid-color|homogeneous/i);
  });

  it('returns null for a non-PNG file (skips clipping check)', () => {
    const jpeg = path.join(tmpDir, 'image.jpg');
    const buf = Buffer.alloc(4096, 0xff); // all 0xff — would fail if PNG check ran
    // JPEG magic (not PNG)
    buf[0] = 0xff;
    buf[1] = 0xd8;
    buf[2] = 0xff;
    fs.writeFileSync(jpeg, buf);
    // Should not trigger clip check because it's not a PNG
    expect(cheapScreenshotChecks(jpeg)).toBeNull();
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
