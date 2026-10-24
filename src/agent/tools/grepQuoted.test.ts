import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { grep } from './search.js';

// #316: with the REAL grep binary (no child_process mock). On Windows, a pattern
// holding `"` failed with "Trailing backslash": Node escapes the quote as `\"`
// on the command line and MSYS=noglob (GREP_ENV) stops MSYS undoing it. The
// pattern now goes on stdin. 10 SWE canary logs searched for
// `"seaborn-colorblind"` this way and the model gave up on finding the code.
describe('grep with patterns argv quoting used to break (#316)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-quoted-'));
    fs.writeFileSync(
      path.join(dir, 'styles.py'),
      ['x = "seaborn-colorblind"', "y = 'single'", '-pk = 1', 'plt.style.library["seaborn"]', ''].join('\n'),
    );
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const search = (pattern: string) => grep({ pattern, path: '.' }, { cwd: dir } as never);

  it('finds a pattern containing double quotes', async () => {
    const out = await search('"seaborn-colorblind"');
    expect(out).toContain('styles.py');
    expect(out).not.toMatch(/Trailing backslash|Grep error/);
  });

  it('finds a pattern containing single quotes', async () => {
    expect(await search("'single'")).toContain('styles.py');
  });

  it('still treats a leading dash as pattern text, not an option', async () => {
    expect(await search('-pk')).toContain('styles.py');
  });

  it('does not glob a regex like `.*` into file names', async () => {
    const out = await search('seaborn.*colorblind');
    expect(out).toContain('styles.py');
    expect(out).not.toMatch(/Grep error/);
  });

  it('reports an absence as an absence, not an error', async () => {
    const out = await search('"definitely_not_here_9f3"');
    expect(out).toMatch(/No matches found/);
  });

  // A model that types `def refine(` means the text. As an ERE it is an error,
  // and the reply sent models to `rg`, which wasn't installed (#315).
  it('searches an invalid regex literally, and says so', async () => {
    const out = await search('plt.style.library["');
    expect(out).toMatch(/is not a valid extended regular expression/);
    expect(out).toMatch(/searched as literal text/);
    expect(out).toContain('styles.py');
    expect(out).not.toMatch(/\brg\b/);
  });

  it('a literal search that finds nothing is still reported as an absence', async () => {
    const out = await search('def refine(');
    expect(out).toMatch(/searched as literal text/);
    expect(out).toMatch(/No matches found/);
  });
});
