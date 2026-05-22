import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
    },
  };
});

import * as fs from 'fs';
import {
  loadRepoPolicy,
  mergePermLevel,
  setActivePolicy,
  getActivePolicy,
  type ToolPermLevel,
} from './policyLoader.js';

const mockReadFile = fs.promises.readFile as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  setActivePolicy(null);
});

describe('mergePermLevel', () => {
  it('returns policy level when user has no explicit permission', () => {
    expect(mergePermLevel(undefined, 'ask')).toBe('ask');
    expect(mergePermLevel(undefined, 'deny')).toBe('deny');
  });

  it('takes the more restrictive of user vs policy', () => {
    expect(mergePermLevel('allow', 'ask')).toBe('ask');
    expect(mergePermLevel('allow', 'deny')).toBe('deny');
    expect(mergePermLevel('ask', 'deny')).toBe('deny');
  });

  it('keeps the user level when it is already more restrictive', () => {
    expect(mergePermLevel('deny', 'ask')).toBe('deny');
    expect(mergePermLevel('deny', 'allow')).toBe('deny');
    expect(mergePermLevel('ask', 'allow')).toBe('ask');
  });

  it('is idempotent when both sides are equal', () => {
    const levels: ToolPermLevel[] = ['allow', 'ask', 'deny'];
    for (const l of levels) {
      expect(mergePermLevel(l, l)).toBe(l);
    }
  });
});

describe('getActivePolicy / setActivePolicy', () => {
  it('starts null', () => {
    expect(getActivePolicy()).toBeNull();
  });

  it('stores and retrieves a policy', () => {
    const p = { version: 1 as const, toolPermissions: { run_command: 'ask' as const } };
    setActivePolicy(p);
    expect(getActivePolicy()).toBe(p);
  });

  it('can be cleared back to null', () => {
    setActivePolicy({ version: 1, toolPermissions: {} });
    setActivePolicy(null);
    expect(getActivePolicy()).toBeNull();
  });
});

describe('loadRepoPolicy', () => {
  it('returns null when the file does not exist (ENOENT)', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockReadFile.mockRejectedValue(err);
    await expect(loadRepoPolicy('/workspace')).resolves.toBeNull();
  });

  it('returns null and warns on other read errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockReadFile.mockRejectedValue(new Error('EPERM'));
    await expect(loadRepoPolicy('/workspace')).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('.sidecar/policy.json'), expect.any(Error));
  });

  it('returns null and warns when JSON is invalid', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockReadFile.mockResolvedValue('{ not valid json }');
    await expect(loadRepoPolicy('/workspace')).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
  });

  it('returns null and warns when version field is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockReadFile.mockResolvedValue(JSON.stringify({ toolPermissions: {} }));
    await expect(loadRepoPolicy('/workspace')).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('version'));
  });

  it('returns null and warns when version is not 1', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockReadFile.mockResolvedValue(JSON.stringify({ version: 2, toolPermissions: {} }));
    await expect(loadRepoPolicy('/workspace')).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns the parsed policy for a valid file', async () => {
    const policy = {
      version: 1,
      toolPermissions: { run_command: 'ask', delete_file: 'deny' },
    };
    mockReadFile.mockResolvedValue(JSON.stringify(policy));
    const result = await loadRepoPolicy('/workspace');
    expect(result).toEqual(policy);
  });

  it('reads from the correct path', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ version: 1 }));
    await loadRepoPolicy('/my/project');
    expect(mockReadFile).toHaveBeenCalledWith(expect.stringContaining('.sidecar/policy.json'), 'utf-8');
  });
});
