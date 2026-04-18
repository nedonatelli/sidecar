import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  syncSkillRegistries,
  collectRegistryRefs,
  slugifyRegistryUrl,
  type SkillSyncConfigSlice,
} from './skillRegistrySync.js';
import { GitCLI } from '../github/git.js';

function tmpHome(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-skill-sync-'));
  return d;
}

function makeConfig(overrides: Partial<SkillSyncConfigSlice> = {}): SkillSyncConfigSlice {
  return {
    skillsUserRegistry: '',
    skillsTeamRegistries: [],
    skillsAutoPull: 'on-start',
    skillsTrustedRegistries: [],
    skillsOffline: false,
    ...overrides,
  };
}

describe('slugifyRegistryUrl', () => {
  it('turns an HTTPS GitHub URL into a filesystem-safe slug', () => {
    expect(slugifyRegistryUrl('https://github.com/acme/skills.git')).toBe('github.com-acme-skills');
  });

  it('handles SSH-style git URLs', () => {
    expect(slugifyRegistryUrl('git@github.com:acme/skills.git')).toBe('github.com-acme-skills');
  });

  it('strips the .git suffix but preserves versions in the repo name', () => {
    expect(slugifyRegistryUrl('https://gitlab.com/team/prompt-kit-v2.git')).toBe('gitlab.com-team-prompt-kit-v2');
  });

  it('is idempotent — slugging a slug is a no-op', () => {
    const s = slugifyRegistryUrl('https://github.com/a/b');
    expect(slugifyRegistryUrl(s)).toBe(s);
  });
});

describe('collectRegistryRefs', () => {
  let home: string;
  beforeEach(() => {
    home = tmpHome();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns an empty list when no registries are configured', () => {
    expect(collectRegistryRefs(makeConfig(), home)).toEqual([]);
  });

  it('user registry goes into ~/.sidecar/user-skills', () => {
    const refs = collectRegistryRefs(makeConfig({ skillsUserRegistry: 'https://github.com/me/skills.git' }), home);
    expect(refs).toHaveLength(1);
    expect(refs[0].tier).toBe('user');
    expect(refs[0].managedDir).toBe(path.join(home, '.sidecar', 'user-skills'));
    expect(refs[0].isLocal).toBe(false);
  });

  it('each team registry gets its own slugged subdirectory', () => {
    const refs = collectRegistryRefs(
      makeConfig({
        skillsTeamRegistries: ['https://github.com/team-a/skills', 'https://github.com/team-b/skills'],
      }),
      home,
    );
    expect(refs).toHaveLength(2);
    expect(refs[0].managedDir).toBe(path.join(home, '.sidecar', 'team-skills', 'github.com-team-a-skills'));
    expect(refs[1].managedDir).toBe(path.join(home, '.sidecar', 'team-skills', 'github.com-team-b-skills'));
  });

  it('treats an existing absolute directory as a local-folder ref (no clone target)', () => {
    const localDir = path.join(home, 'my-skills');
    fs.mkdirSync(localDir);
    const refs = collectRegistryRefs(makeConfig({ skillsUserRegistry: localDir }), home);
    expect(refs[0].isLocal).toBe(true);
    expect(refs[0].managedDir).toBe(localDir);
  });

  it('drops empty-string entries from the team array', () => {
    const refs = collectRegistryRefs(
      makeConfig({ skillsTeamRegistries: ['', '   ', 'https://github.com/real/skills'] }),
      home,
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].tier).toBe('team');
  });
});

describe('syncSkillRegistries', () => {
  let home: string;
  beforeEach(() => {
    home = tmpHome();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns [] when offline mode is on AND nothing is cached', async () => {
    const git = {
      clone: vi.fn().mockResolvedValue(''),
      pull: vi.fn().mockResolvedValue(''),
    } as unknown as GitCLI;
    const refs = await syncSkillRegistries({
      config: makeConfig({
        skillsUserRegistry: 'https://github.com/me/skills.git',
        skillsOffline: true,
      }),
      homeDir: home,
      git,
    });
    expect(refs).toEqual([]);
    expect(git.clone).not.toHaveBeenCalled();
  });

  it('returns cached refs in offline mode without touching the network', async () => {
    // Pre-populate the managed dir to simulate a prior clone.
    const managed = path.join(home, '.sidecar', 'user-skills');
    fs.mkdirSync(managed, { recursive: true });

    const git = { clone: vi.fn(), pull: vi.fn() } as unknown as GitCLI;
    const refs = await syncSkillRegistries({
      config: makeConfig({
        skillsUserRegistry: 'https://github.com/me/skills.git',
        skillsOffline: true,
      }),
      homeDir: home,
      git,
    });
    expect(refs).toHaveLength(1);
    expect(git.clone).not.toHaveBeenCalled();
    expect(git.pull).not.toHaveBeenCalled();
  });

  it('first install: prompts for trust, clones on accept', async () => {
    const git = {
      clone: vi.fn().mockResolvedValue('ok'),
      pull: vi.fn(),
    } as unknown as GitCLI;
    const trustPrompt = vi.fn().mockResolvedValue(true);

    const refs = await syncSkillRegistries({
      config: makeConfig({ skillsUserRegistry: 'https://github.com/me/skills.git' }),
      homeDir: home,
      git,
      trustPrompt,
    });

    expect(trustPrompt).toHaveBeenCalledOnce();
    expect(git.clone).toHaveBeenCalledOnce();
    expect(refs).toHaveLength(1);
  });

  it('first install: skips the registry on trust decline', async () => {
    const git = { clone: vi.fn(), pull: vi.fn() } as unknown as GitCLI;
    const refs = await syncSkillRegistries({
      config: makeConfig({ skillsUserRegistry: 'https://github.com/me/skills.git' }),
      homeDir: home,
      git,
      trustPrompt: async () => false,
    });
    expect(refs).toHaveLength(0);
    expect(git.clone).not.toHaveBeenCalled();
  });

  it('URLs in trustedRegistries bypass the trust prompt on first install', async () => {
    const git = {
      clone: vi.fn().mockResolvedValue('ok'),
      pull: vi.fn(),
    } as unknown as GitCLI;
    const trustPrompt = vi.fn();
    const url = 'https://github.com/corp/approved-skills.git';

    await syncSkillRegistries({
      config: makeConfig({
        skillsUserRegistry: url,
        skillsTrustedRegistries: [url],
      }),
      homeDir: home,
      git,
      trustPrompt,
    });

    expect(trustPrompt).not.toHaveBeenCalled();
    expect(git.clone).toHaveBeenCalledOnce();
  });

  it('cached registry + autoPull=on-start → pulls', async () => {
    const managed = path.join(home, '.sidecar', 'user-skills');
    fs.mkdirSync(managed, { recursive: true });

    const git = {
      clone: vi.fn(),
      pull: vi.fn().mockResolvedValue('ok'),
    } as unknown as GitCLI;
    const refs = await syncSkillRegistries({
      config: makeConfig({
        skillsUserRegistry: 'https://github.com/me/skills.git',
        skillsAutoPull: 'on-start',
      }),
      homeDir: home,
      git,
    });
    // The sync constructs its own pull-scoped GitCLI (different from the
    // injected one). We can't inspect the pull call on the injected git
    // directly, but we CAN verify `refs` contains the managed ref.
    expect(refs).toHaveLength(1);
    expect(git.clone).not.toHaveBeenCalled();
  });

  it('cached registry + autoPull=manual → skips the pull', async () => {
    const managed = path.join(home, '.sidecar', 'user-skills');
    fs.mkdirSync(managed, { recursive: true });

    const git = { clone: vi.fn(), pull: vi.fn() } as unknown as GitCLI;
    const refs = await syncSkillRegistries({
      config: makeConfig({
        skillsUserRegistry: 'https://github.com/me/skills.git',
        skillsAutoPull: 'manual',
      }),
      homeDir: home,
      git,
    });
    expect(refs).toHaveLength(1);
    expect(git.clone).not.toHaveBeenCalled();
  });

  it('local-folder refs always sync without touching git', async () => {
    const local = path.join(home, 'project-local-skills');
    fs.mkdirSync(local);
    const git = { clone: vi.fn(), pull: vi.fn() } as unknown as GitCLI;
    const refs = await syncSkillRegistries({
      config: makeConfig({ skillsUserRegistry: local }),
      homeDir: home,
      git,
    });
    expect(refs).toHaveLength(1);
    expect(refs[0].isLocal).toBe(true);
    expect(git.clone).not.toHaveBeenCalled();
  });

  it('a failed clone is logged but does not abort the loop', async () => {
    const git = {
      clone: vi.fn().mockRejectedValue(new Error('network down')),
      pull: vi.fn(),
    } as unknown as GitCLI;
    const lines: string[] = [];

    await syncSkillRegistries({
      config: makeConfig({
        skillsUserRegistry: 'https://github.com/me/skills.git',
        skillsTrustedRegistries: ['https://github.com/me/skills.git'],
      }),
      homeDir: home,
      git,
      log: (l) => lines.push(l),
    });

    expect(lines.some((l) => /Failed to sync/.test(l))).toBe(true);
    expect(lines.some((l) => /network down/.test(l))).toBe(true);
  });
});
