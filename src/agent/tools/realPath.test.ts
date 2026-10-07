import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workspace, Uri } from 'vscode';
import { realWorkspaceRelative, realPathRefusal, validateFilePath, isProtectedWritePath } from './shared.js';
import { readFile, writeFile } from './fs.js';
import { checkGrepPath } from './search.js';
import { detectIrrecoverable } from '../executor/irrecoverableDetector.js';
import { resolveAtReferences } from '../../config/workspace.js';

// Path checks used to judge the name a path was GIVEN. A link inside the
// workspace that leads out of it, or another name for a credential or
// protected file, passed every check and was read or written.

let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'realpath-'));
  root = path.join(base, 'ws');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'aws-credentials'), 'aws_secret_access_key=SECRET\n');
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=SECRET\n');
  // A junction needs no privileges on Windows; elsewhere it is a symlink.
  fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const ctx = () => ({ cwd: root }) as never;
const realFsRead = async (uri: { fsPath: string }) => fs.readFileSync(uri.fsPath);

describe('realWorkspaceRelative', () => {
  it('follows a link out of the workspace', () => {
    expect(realWorkspaceRelative(root, 'linked/aws-credentials')).toBeNull();
    expect(realWorkspaceRelative(root, 'linked')).toBeNull();
  });

  it('keeps an ordinary path, and a not-yet-existing one, inside', () => {
    expect(realWorkspaceRelative(root, 'src/a.ts')).toBe('src/a.ts');
    expect(realWorkspaceRelative(root, 'src/new/b.ts')).toBe('src/new/b.ts');
  });
});

describe('approval-free reads judge the real target', () => {
  it('read_file refuses a file reached through a link out of the workspace', async () => {
    vi.spyOn(workspace.fs, 'readFile').mockImplementation(realFsRead as never);
    await expect(readFile({ path: 'linked/aws-credentials' }, ctx())).rejects.toThrow(/outside the workspace/);
  });

  it('grep refuses a path that leads out of the workspace', () => {
    expect(checkGrepPath('linked', root)).toMatch(/outside the workspace/);
    expect(checkGrepPath('src', root)).toBeNull();
  });

  it('@file: refuses credential files and links out of the workspace', async () => {
    const saved = workspace.workspaceFolders;
    (workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    vi.spyOn(workspace.fs, 'readFile').mockImplementation(realFsRead as never);
    try {
      const out = await resolveAtReferences('see @file:.env and @file:linked/aws-credentials and @file:src/a.ts');
      expect(out).not.toContain('SECRET');
      expect(out).toContain('export const a = 1;');
    } finally {
      (workspace as { workspaceFolders: unknown }).workspaceFolders = saved;
    }
  });
});

describe('writes judge the real target', () => {
  it('write_file refuses a path through a link out of the workspace', async () => {
    await expect(writeFile({ path: 'linked/planted.txt', content: 'x' }, ctx())).rejects.toThrow(
      /outside the workspace/,
    );
    expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false);
  });

  it('refuses NTFS stream names', () => {
    expect(validateFilePath('.env::$DATA')).toMatch(/":" is not allowed/);
    expect(validateFilePath('src/a.ts:hidden')).toMatch(/":" is not allowed/);
  });
});

// 8.3 short names exist only on NTFS volumes that generate them; the test
// runs where `SIDECA~1` actually resolves.
describe('Windows short names', () => {
  const shortNamesWork = () => {
    if (process.platform !== 'win32') return false;
    fs.mkdirSync(path.join(root, '.sidecar', 'memory'), { recursive: true });
    return fs.existsSync(path.join(root, 'SIDECA~1'));
  };

  it('a short name for protected state or a credential file is judged by its long name', (ctx) => {
    if (!shortNamesWork()) ctx.skip();
    expect(realPathRefusal(root, 'SIDECA~1/memory/agent-memories.json', 'write')).toMatch(/\.sidecar\/memory/);
    expect(realPathRefusal(root, 'ENV~1', 'read')).toMatch(/credential file/);
  });
});

describe('protected and command-running files', () => {
  it.each([
    '.git/hooks/pre-commit',
    '.git/config',
    '.sidecar/audit-buffer/state.json',
    '.sidecar/policy.json',
    '.sidecar/facets/x.md',
  ])('refuses agent writes to %s', (p) => {
    expect(isProtectedWritePath(p)).not.toBeNull();
  });

  it.each([
    '.vscode/tasks.json',
    '.vscode/settings.json',
    '.mcp.json',
    '.husky/pre-commit',
    '.pre-commit-config.yaml',
    '.envrc',
  ])('a write to %s always needs confirmation', (p) => {
    expect(
      detectIrrecoverable({ type: 'tool_use', id: 'x', name: 'write_file', input: { path: p, content: '' } }),
    ).not.toBeNull();
    expect(detectIrrecoverable({ type: 'tool_use', id: 'x', name: 'edit_file', input: { path: p } })).not.toBeNull();
  });

  it('ordinary source files need no extra confirmation', () => {
    expect(
      detectIrrecoverable({ type: 'tool_use', id: 'x', name: 'write_file', input: { path: 'src/a.ts' } }),
    ).toBeNull();
  });

  it('refuses a command-running file reached under another name', () => {
    fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
    fs.symlinkSync(path.join(root, '.vscode'), path.join(root, 'vsc'), 'junction');
    expect(realPathRefusal(root, 'vsc/tasks.json', 'write')).toMatch(/another name/);
    expect(realPathRefusal(root, '.vscode/tasks.json', 'write')).toBeNull();
  });
});
