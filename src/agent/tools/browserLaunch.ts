/**
 * Which browser the visual-verification tools drive, and how they find one.
 *
 * playwright-core ships NO browser: `chromium.launch()` needs a separate
 * `npx playwright install chromium`. It used to be the only thing tried, so on
 * a machine with Chrome and Edge installed but no Playwright download --
 * measured on the project's own workstation -- screenshot_page always failed
 * with "Executable doesn't exist at ...ms-playwright\chromium_headless_shell...".
 * Playwright drives an installed Chrome or Edge through its `channel` option.
 *
 * - `sidecar.visualVerify.browser`: 'auto' (default) tries Playwright's
 *   Chromium, then installed Chrome, then Edge, and uses the first that
 *   launches; 'chromium' | 'chrome' | 'msedge' tries only that one.
 * - `sidecar.visualVerify.browserPath`: an executable to launch instead
 *   (any Chromium-based browser); overrides `browser`.
 */
export type VisualVerifyBrowser = 'auto' | 'chromium' | 'chrome' | 'msedge';

interface LaunchOptions {
  headless: boolean;
  channel?: string;
  executablePath?: string;
}
/** The slice of playwright-core this needs; injected so tests need no browser. */
export interface PlaywrightLike {
  chromium: { launch(options: LaunchOptions): Promise<unknown> };
}

const AUTO_ORDER: Exclude<VisualVerifyBrowser, 'auto'>[] = ['chromium', 'chrome', 'msedge'];

function optionsFor(choice: Exclude<VisualVerifyBrowser, 'auto'>): LaunchOptions {
  // 'chromium' = Playwright's own download; the others are installed browsers.
  return choice === 'chromium' ? { headless: true } : { headless: true, channel: choice };
}

export async function launchBrowser(
  playwright: PlaywrightLike,
  settings: { browser: VisualVerifyBrowser; browserPath: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ browser: any; used: string }> {
  const path = settings.browserPath.trim();
  const attempts: { used: string; options: LaunchOptions }[] = path
    ? [{ used: path, options: { headless: true, executablePath: path } }]
    : (settings.browser === 'auto' ? AUTO_ORDER : [settings.browser]).map((c) => ({ used: c, options: optionsFor(c) }));

  const failures: string[] = [];
  for (const { used, options } of attempts) {
    try {
      return { browser: await playwright.chromium.launch(options), used };
    } catch (err) {
      failures.push(`${used}: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`);
    }
  }
  throw new Error(
    `could not launch a browser. Tried ${failures.join('; ')}. Fix one of: install Google Chrome or ` +
      `Microsoft Edge; set sidecar.visualVerify.browserPath to a Chromium-based browser's executable; ` +
      `or run \`npx playwright install chromium\`.`,
  );
}
