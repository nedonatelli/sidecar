import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fsNode from 'fs';
import * as osNode from 'os';
import * as pathNode from 'path';
import { grep } from './search.js';

// Real filesystem and the real grep binary: the defect is in how the CHILD
// PROCESS treats its arguments, which no execFile mock can show. Git for
// Windows' grep glob-expands its argv like a shell would, so `path: ".*"`
// became `. .. .git ...` -- searching the PARENT of the workspace (the whole
// temp folder in the SWE harness, 15 s timeouts) and returning files from
// outside it.
describe('grep — `path` is a location inside the workspace, never a pattern', () => {
  const parent = fsNode.mkdtempSync(pathNode.join(osNode.tmpdir(), 'grep-guard-'));
  const root = pathNode.join(parent, 'repo');
  const ctx = { cwd: root } as never;

  beforeAll(() => {
    fsNode.mkdirSync(pathNode.join(root, 'src'), { recursive: true });
    fsNode.mkdirSync(pathNode.join(root, 'a+b (old)'), { recursive: true });
    fsNode.writeFileSync(pathNode.join(root, 'src', 'app.py'), 'NEEDLE = 1\n');
    fsNode.writeFileSync(pathNode.join(root, 'a+b (old)', 'legacy.py'), 'NEEDLE = 2\n');
    fsNode.writeFileSync(pathNode.join(root, '.env.example'), 'X=1\n');
    // A sibling OUTSIDE the workspace that must never appear in results.
    fsNode.mkdirSync(pathNode.join(parent, 'outside'), { recursive: true });
    fsNode.writeFileSync(pathNode.join(parent, 'outside', 'secret.py'), 'NEEDLE = "outside"\n');
  });
  afterAll(() => fsNode.rmSync(parent, { recursive: true, force: true }));

  it('refuses a regex/glob given as `path`, and says to omit it', async () => {
    const out = await grep({ pattern: 'NEEDLE', path: '.*' }, ctx);
    expect(out).toMatch(/looks like a pattern/);
    expect(out).toMatch(/omit `path`/);
    expect(out).not.toContain('outside');
  });

  it('points a file-type glob at search_files', async () => {
    const out = await grep({ pattern: 'NEEDLE', path: '*.py' }, ctx);
    expect(out).toMatch(/looks like a pattern/);
    expect(out).toContain('search_files(pattern="**/*.py")');
  });

  it('refuses a path that leaves the workspace', async () => {
    const out = await grep({ pattern: 'NEEDLE', path: '../outside' }, ctx);
    expect(out).toMatch(/outside the workspace/);
    expect(out).not.toContain('secret.py');
  });

  it('says plainly when a path does not exist', async () => {
    const out = await grep({ pattern: 'NEEDLE', path: 'nope/' }, ctx);
    expect(out).toMatch(/does not exist/);
    expect(out).not.toMatch(/Perl-style|Grep failed/);
  });

  it('still accepts a real directory whose name has pattern characters in it', async () => {
    const out = await grep({ pattern: 'NEEDLE', path: 'a+b (old)' }, ctx);
    expect(out).toContain('legacy.py');
  });

  it('accepts an absolute path inside the workspace', async () => {
    const out = await grep({ pattern: 'NEEDLE', path: pathNode.join(root, 'src') }, ctx);
    expect(out).toContain('app.py');
  });

  it('never glob-expands the PATTERN: `.*` searches the given file, not every dotfile and the parent', async () => {
    // Without MSYS=noglob, `.*` as the pattern became `.` plus extra path
    // arguments (`..`, `.env.example`, ...) and grep searched outside the root.
    const out = await grep({ pattern: '.*', path: 'src' }, ctx);
    expect(out).toContain('app.py');
    expect(out).not.toContain('secret.py');
    expect(out).not.toContain('.env.example');
  });

  it('searches for a pattern that starts with "-" instead of reading it as an option', async () => {
    fsNode.writeFileSync(pathNode.join(root, 'src', 'models.py'), "ordering = ['-pk']\n");
    const out = await grep({ pattern: '-pk' }, ctx);
    expect(out).toContain('models.py');
  });

  it('never searches .git or reports binary files', async () => {
    // `Binary file ./.git/objects/pack/pack-<hash>.pack matches` reached the
    // model in real runs: noise it cannot act on, and the pack name differs
    // between clones, which broke 3 of 50 determinism pairs in a baseline.
    fsNode.mkdirSync(pathNode.join(root, '.git', 'objects'), { recursive: true });
    fsNode.writeFileSync(
      pathNode.join(root, '.git', 'objects', 'pack.pack'),
      Buffer.from([0, 1, 2, ...Buffer.from('NEEDLE')]),
    );
    fsNode.writeFileSync(pathNode.join(root, '.git', 'config'), 'NEEDLE\n');
    fsNode.writeFileSync(pathNode.join(root, 'src', 'blob.bin'), Buffer.from([0, 0, ...Buffer.from('NEEDLE'), 0]));
    const out = await grep({ pattern: 'NEEDLE' }, ctx);
    expect(out).toContain('app.py');
    expect(out).not.toContain('.git');
    expect(out).not.toMatch(/Binary file/);
  });

  it('searches the whole workspace when `path` is omitted, and nothing outside it', async () => {
    const out = await grep({ pattern: 'NEEDLE' }, ctx);
    expect(out).toContain('app.py');
    expect(out).toContain('legacy.py');
    expect(out).not.toContain('secret.py');
  });
});
