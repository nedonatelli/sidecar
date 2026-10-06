import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';

// Must import after vi.mock calls are hoisted by Vitest
import { isSeatbeltSupported, buildSandboxProfile, wrapWithSeatbelt } from './seatbelt.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isSeatbeltSupported', () => {
  it('returns false on non-darwin platforms', () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    expect(isSeatbeltSupported()).toBe(false);
  });

  it('returns false on darwin when sandbox-exec binary is absent', () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(isSeatbeltSupported()).toBe(false);
  });

  it('returns true on darwin when sandbox-exec is present', () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    expect(isSeatbeltSupported()).toBe(true);
  });

  it('returns false on win32 even if existsSync returns true', () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    expect(isSeatbeltSupported()).toBe(false);
  });
});

describe('buildSandboxProfile', () => {
  const workspace = '/Users/dev/my-project';
  const home = '/Users/dev';

  it('starts with SBPL version 1 and deny default', () => {
    const profile = buildSandboxProfile(workspace, home);
    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(deny default)');
  });

  it('allows file reads globally', () => {
    const profile = buildSandboxProfile(workspace, home);
    expect(profile).toContain('(allow file-read*)');
  });

  it('allows writes inside the workspace path', () => {
    const profile = buildSandboxProfile(workspace, home);
    expect(profile).toContain(`(subpath "${workspace}")`);
  });

  it('allows writes to npm and cargo caches under home', () => {
    const profile = buildSandboxProfile(workspace, home);
    expect(profile).toContain(`(subpath "${home}/.npm")`);
    expect(profile).toContain(`(subpath "${home}/.cargo")`);
  });

  it('allows writes to /tmp and /private/tmp', () => {
    const profile = buildSandboxProfile(workspace, home);
    expect(profile).toContain('(subpath "/tmp")');
    expect(profile).toContain('(subpath "/private/tmp")');
  });

  it('allows network-outbound', () => {
    const profile = buildSandboxProfile(workspace, home);
    expect(profile).toContain('(allow network-outbound)');
  });

  it('allows process-exec and process-fork', () => {
    const profile = buildSandboxProfile(workspace, home);
    expect(profile).toContain('(allow process-exec*)');
    expect(profile).toContain('(allow process-fork)');
  });

  it('escapes double-quotes in the workspace path', () => {
    const pathWithQuote = '/Users/dev/my"project';
    const profile = buildSandboxProfile(pathWithQuote, home);
    expect(profile).toContain('(subpath "/Users/dev/my\\"project")');
    expect(profile).not.toContain('(subpath "/Users/dev/my"project")');
  });

  it('escapes backslashes in the workspace path', () => {
    const pathWithBackslash = '/Users/dev/my\\project';
    const profile = buildSandboxProfile(pathWithBackslash, home);
    expect(profile).toContain('(subpath "/Users/dev/my\\\\project")');
  });

  it('uses os.homedir() when homeDir is not provided', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/Users/mocked');
    const profile = buildSandboxProfile('/workspace');
    expect(profile).toContain('(subpath "/Users/mocked/.npm")');
  });
});

describe('wrapWithSeatbelt', () => {
  it('uses sandbox-exec as the command', () => {
    const { cmd } = wrapWithSeatbelt('/bin/bash', ['--norc'], '/workspace');
    expect(cmd).toBe('/usr/bin/sandbox-exec');
  });

  it('passes -p followed by the profile as the first two args', () => {
    const { args } = wrapWithSeatbelt('/bin/bash', ['--norc'], '/workspace');
    expect(args[0]).toBe('-p');
    expect(args[1]).toContain('(version 1)');
  });

  it('appends shell path and shell args after the profile', () => {
    const { args } = wrapWithSeatbelt('/bin/zsh', ['-f'], '/workspace');
    expect(args[2]).toBe('/bin/zsh');
    expect(args[3]).toBe('-f');
  });

  it('works with no shell args', () => {
    const { args } = wrapWithSeatbelt('/bin/bash', [], '/workspace');
    expect(args[2]).toBe('/bin/bash');
    expect(args).toHaveLength(3);
  });
});

// Ways a sandboxed command could get code run OUTSIDE the sandbox later
// (security review 2026-10). Checked on the profile text: these tests run on
// every OS, but nothing here executes sandbox-exec.
describe('buildSandboxProfile carve-outs', () => {
  const ws = '/Users/dev/my-project';
  const home = '/Users/dev';
  const profile = buildSandboxProfile(ws, home);
  const lastIndex = (s: string) => profile.lastIndexOf(s);

  it('binds and listens on localhost only', () => {
    expect(profile).toContain('(allow network-inbound (local ip "localhost:*"))');
    expect(profile).toContain('(allow network-bind (local ip "localhost:*"))');
    expect(profile).not.toContain('"*:*"');
  });

  it('denies writes that make unsandboxed code run, AFTER the workspace allow', () => {
    for (const rule of [
      `(subpath "${ws}/.git/hooks")`,
      `(literal "${ws}/.git/config")`,
      `(subpath "${ws}/.vscode")`,
      `(literal "${ws}/.mcp.json")`,
      `(literal "${ws}/.sidecar/settings.json")`,
    ]) {
      expect(lastIndex(rule), rule).toBeGreaterThan(lastIndex(`(subpath "${ws}"))`));
    }
    expect(lastIndex('(deny file-write*')).toBeGreaterThan(lastIndex('(allow file-write*'));
  });

  it('denies writes to PATH directories inside the writable caches', () => {
    for (const dir of ['.local/bin', '.cargo/bin', 'go/bin']) {
      expect(profile).toContain(`(subpath "${home}/${dir}")`);
    }
  });

  it('denies the launchers that escape via launchd or LaunchServices', () => {
    for (const bin of ['/bin/launchctl', '/usr/bin/osascript', '/usr/bin/open']) {
      expect(profile).toContain(`(literal "${bin}")`);
    }
  });
});
