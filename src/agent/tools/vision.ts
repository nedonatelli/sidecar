/**
 * Vision tools (v0.77) — Screenshot-in-the-Loop visual verification.
 *
 * screenshot_page      — capture a URL as PNG via Playwright headless Chromium.
 * analyze_screenshot   — cheap heuristic pre-filter + VLM vision verdict.
 * open_in_browser      — open a URL in VS Code's Simple Browser panel.
 * run_playwright_code  — execute arbitrary Playwright TypeScript (always requires approval).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
function ensureScreenshotsDir(context?: import('./shared.js').ToolExecutorContext): string {
  const config = context?.config ?? getConfig();
  const base = config.visualVerifyScreenshotsDir || '.sidecar/screenshots';
  const dir = path.isAbsolute(base) ? base : path.join(getRoot(), base);
  fs.mkdirSync(dir, { recursive: true });
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
export function cheapScreenshotChecks(imagePath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(imagePath);
  } catch {
    return 'File not found or not readable.';
  }

  // Blank canvas heuristic: a valid screenshot of any content should be
  // larger than 2 KB. PNGs with solid fills compress extremely well and
  // come in under this threshold reliably.
  if (stat.size < 2048) {
    return `Image appears to be blank (file size ${stat.size} bytes < 2 KB). The rendered output may be empty or failed to load.`;
  }

  // Edge-clipping heuristic: read a small PNG header chunk to sample
  // a few bytes. If the file is not a valid PNG we can't check, so skip.
  let buf: Buffer;
  try {
    const fd = fs.openSync(imagePath, 'r');
    buf = Buffer.alloc(Math.min(stat.size, 65536));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
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
// screenshot_page
// ---------------------------------------------------------------------------

async function screenshotPage(input: Record<string, unknown>, _context?: ToolExecutorContext): Promise<string> {
  const url = input.url as string | undefined;
  if (!url) return 'Error: url is required';

  const urlError = validateScreenshotUrl(url);
  if (urlError) return urlError;

  const selector = input.selector as string | undefined;
  const waitForRaw = (input.wait_for as string | undefined) ?? 'load';
  const viewportRaw = input.viewport as { width?: number; height?: number } | undefined;

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

  const screenshotsDir = ensureScreenshotsDir(_context);
  const timestamp = Date.now();
  const slug = urlSlug(url);
  const outputPath = path.join(screenshotsDir, `${timestamp}-${slug}.png`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any;

  try {
    browser = await playwright.chromium.launch({ headless: true });
    page = await browser.newPage();

    const width = viewportRaw?.width ?? 1280;
    const height = viewportRaw?.height ?? 800;
    await page.setViewportSize({ width, height });

    // Determine waitUntil strategy
    let waitUntil: string = 'load';
    let extraWaitMs = 0;
    if (waitForRaw === 'networkidle') {
      waitUntil = 'networkidle';
    } else if (waitForRaw === 'domcontentloaded') {
      waitUntil = 'domcontentloaded';
    } else if (/^\d+$/.test(waitForRaw)) {
      extraWaitMs = parseInt(waitForRaw, 10);
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

  const config = context?.config ?? getConfig();

  // Reject absolute paths — same guard as read_file. The agent should always
  // pass workspace-relative paths; absolute paths are a path-traversal vector.
  if (path.isAbsolute(rawPath)) {
    return `Error: absolute paths are not allowed for image_path. Use a workspace-relative path (e.g. ".sidecar/screenshots/file.png").`;
  }
  const imagePath = path.join(getRoot(), rawPath);

  if (config.visualVerifyCheapChecksOnly) {
    const preFilterResult = cheapScreenshotChecks(imagePath);
    if (preFilterResult) {
      return `Visual check failed (pre-filter): ${preFilterResult}\n\n{"pass":false,"issues":["${preFilterResult.replace(/"/g, '\\"')}"]}`;
    }
    return `Pre-filter passed (cheap checks only — VLM analysis skipped).\n\n{"pass":true,"issues":[]}`;
  }

  // Run cheap pre-filter first — fail fast without a VLM call.
  const preFilterFailure = cheapScreenshotChecks(imagePath);
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

  // Read the image as base64.
  let imageData: string;
  try {
    imageData = (await fs.promises.readFile(imagePath)).toString('base64');
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
    'Respond ONLY with a JSON object: { "pass": boolean, "issues": string[] }. ' +
    '"pass" is true when all criteria are met. "issues" is an empty array when pass is true, ' +
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

  let verdict: { pass: boolean; issues: string[] };
  try {
    verdict = JSON.parse(jsonMatch[0]) as typeof verdict;
  } catch {
    return `VLM response JSON parse error. Raw response:\n${raw}`;
  }

  const summary = verdict.pass
    ? `✓ Visual check passed.`
    : `✗ Visual check failed — ${verdict.issues.length} issue${verdict.issues.length === 1 ? '' : 's'}:\n${verdict.issues.map((i) => `  • ${i}`).join('\n')}`;

  return `${summary}\n\n${JSON.stringify(verdict)}`;
}

// ---------------------------------------------------------------------------
// open_in_browser
// ---------------------------------------------------------------------------

async function openInBrowser(input: Record<string, unknown>): Promise<string> {
  const url = input.url as string | undefined;
  if (!url) return 'Error: url is required';

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
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* ignore cleanup errors */
      }
      const stdout = chunks.join('');
      const stderr = errChunks.join('');
      if (signal === 'SIGTERM' || ac.signal.aborted) {
        resolve(`Script timed out after ${timeoutMs}ms.`);
      } else if (code !== 0) {
        resolve(`Script exited with code ${code}.\nstderr:\n${stderr}\nstdout:\n${stdout}`);
      } else {
        resolve(stdout || '(script completed with no stdout output)');
      }
    });

    child.on('error', (err: Error) => {
      clearTimeout(killTimer);
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
            description: 'Path to the image file (absolute, or relative to workspace root)',
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
