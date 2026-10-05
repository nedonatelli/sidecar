import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import { launchBrowser } from './browserLaunch.js';

// A fake playwright: `works` lists the launch options that succeed, by label.
function fakePlaywright(works: string[]) {
  const label = (o: { channel?: string; executablePath?: string }) =>
    o.executablePath ? `path:${o.executablePath}` : (o.channel ?? 'chromium');
  const launch = vi.fn(async (o: { channel?: string; executablePath?: string; headless: boolean }) => {
    if (!works.includes(label(o))) throw new Error(`Executable doesn't exist (${label(o)})`);
    return { label: label(o) };
  });
  return { pw: { chromium: { launch } }, launch, label };
}

describe('launchBrowser', () => {
  // playwright-core ships NO browser: chromium.launch() needs a separate
  // `npx playwright install chromium`. On a machine with Chrome and Edge but no
  // Playwright download, screenshot_page always failed: "Executable doesn't
  // exist at ...ms-playwright\chromium_headless_shell-1217...".
  it("auto: falls back to the installed Chrome when Playwright's Chromium is missing", async () => {
    const { pw } = fakePlaywright(['chrome', 'msedge']);
    const r = await launchBrowser(pw, { browser: 'auto', browserPath: '' });
    expect(r.used).toBe('chrome');
  });

  it('auto: tries Chromium, then Chrome, then Edge, in that order', async () => {
    const { pw, launch, label } = fakePlaywright(['msedge']);
    const r = await launchBrowser(pw, { browser: 'auto', browserPath: '' });
    expect(r.used).toBe('msedge');
    expect(launch.mock.calls.map(([o]) => label(o))).toEqual(['chromium', 'chrome', 'msedge']);
  });

  it('auto: uses Playwright Chromium first when it is there', async () => {
    const { pw, launch } = fakePlaywright(['chromium', 'chrome']);
    expect((await launchBrowser(pw, { browser: 'auto', browserPath: '' })).used).toBe('chromium');
    expect(launch).toHaveBeenCalledOnce();
  });

  it('a named browser is the only one tried', async () => {
    const { pw, launch } = fakePlaywright(['chromium', 'chrome', 'msedge']);
    expect((await launchBrowser(pw, { browser: 'msedge', browserPath: '' })).used).toBe('msedge');
    expect(launch).toHaveBeenCalledOnce();
  });

  it('browserPath overrides the choice and is launched as an executable', async () => {
    const { pw, launch, label } = fakePlaywright(['path:D:/browsers/brave.exe']);
    const r = await launchBrowser(pw, { browser: 'chrome', browserPath: 'D:/browsers/brave.exe' });
    expect(r.used).toBe('D:/browsers/brave.exe');
    expect(launch.mock.calls.map(([o]) => label(o))).toEqual(['path:D:/browsers/brave.exe']);
  });

  it('every launch is headless', async () => {
    const { pw, launch } = fakePlaywright(['chrome']);
    await launchBrowser(pw, { browser: 'auto', browserPath: '' });
    for (const [o] of launch.mock.calls) expect(o.headless).toBe(true);
  });

  it('when nothing launches, the error says what was tried and how to fix it', async () => {
    const { pw } = fakePlaywright([]);
    const err = await launchBrowser(pw, { browser: 'auto', browserPath: '' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/chromium/);
    expect(msg).toMatch(/chrome/);
    expect(msg).toMatch(/msedge/);
    expect(msg).toMatch(/sidecar\.visualVerify\.browserPath/);
    expect(msg).toMatch(/npx playwright install chromium/);
  });

  // The real thing, where it can run: on this project's Windows workstation
  // Chrome and Edge are installed and Playwright's Chromium is not.
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  it.skipIf(!fs.existsSync(chrome))(
    'really launches the installed Chrome through auto',
    async () => {
      const pw = require('playwright-core');
      const r = await launchBrowser(pw, { browser: 'auto', browserPath: '' });
      try {
        expect(['chromium', 'chrome', 'msedge']).toContain(r.used);
        const page = await r.browser.newPage();
        await page.setContent('<h1>ok</h1>');
        expect(await page.textContent('h1')).toBe('ok');
      } finally {
        await r.browser.close();
      }
    },
    60_000,
  );
});
