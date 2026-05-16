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
