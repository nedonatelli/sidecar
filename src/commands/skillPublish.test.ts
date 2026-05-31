import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockShowWarningMessage = vi.fn();
const mockShowErrorMessage = vi.fn();
const mockShowInformationMessage = vi.fn();
const mockShowOpenDialog = vi.fn();
const mockExecuteCommand = vi.fn();
const mockWithProgress = vi.fn().mockImplementation((_opts: unknown, task: () => Promise<void>) => task());

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: mockShowWarningMessage,
    showErrorMessage: mockShowErrorMessage,
    showInformationMessage: mockShowInformationMessage,
    showOpenDialog: mockShowOpenDialog,
    withProgress: mockWithProgress,
    activeTextEditor: undefined,
  },
  commands: { executeCommand: mockExecuteCommand },
  workspace: { workspaceFolders: undefined },
}));

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockAccess = vi.fn();
const mockUnlink = vi.fn().mockResolvedValue(undefined);
vi.mock('fs', () => ({
  promises: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    access: mockAccess,
    unlink: mockUnlink,
  },
}));

vi.mock('../config/settings.js', () => ({
  getConfig: vi.fn(() => ({
    skillsOffline: false,
    skillsUserRegistry: 'git@github.com:user/skills.git',
  })),
}));

const mockStage = vi.fn().mockResolvedValue('');
const mockCommit = vi.fn().mockResolvedValue('committed');
const mockPush = vi.fn().mockResolvedValue('pushed');
const MockGitCLI = vi.fn(() => ({ stage: mockStage, commit: mockCommit, push: mockPush }));
vi.mock('../github/git.js', () => ({ GitCLI: MockGitCLI }));

// ── Tests ──────────────────────────────────────────────────────────────────

type Config = ReturnType<typeof import('../config/settings.js').getConfig>;
const DEFAULT_CONFIG: Partial<Config> = { skillsOffline: false, skillsUserRegistry: 'git@github.com:user/skills.git' };

describe('publishSkill', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    // vi.resetAllMocks() clears the getConfig factory implementation — restore it.
    const { getConfig } = await import('../config/settings.js');
    vi.mocked(getConfig).mockReturnValue(DEFAULT_CONFIG as Config);
    mockAccess.mockResolvedValue(undefined); // files/dirs exist by default
    mockReadFile.mockResolvedValue('---\nname: My Skill\n---\n# content');
    mockWriteFile.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
  });

  it('returns false and warns when offline mode is active', async () => {
    const { getConfig } = await import('../config/settings.js');
    vi.mocked(getConfig).mockReturnValueOnce({
      skillsOffline: true,
      skillsUserRegistry: 'git@...',
    } as unknown as ReturnType<typeof import('../config/settings.js').getConfig>);
    const { publishSkill } = await import('./skillPublish.js');

    const result = await publishSkill({
      filePath: '/testhome/.sidecar/skill.md',
      registryDir: '/reg',
      homeDir: '/testhome',
    });
    expect(result).toBe(false);
    expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });

  it('returns false and prompts to configure when no registry set', async () => {
    const { getConfig } = await import('../config/settings.js');
    vi.mocked(getConfig).mockReturnValueOnce({ skillsOffline: false, skillsUserRegistry: '' } as unknown as ReturnType<
      typeof import('../config/settings.js').getConfig
    >);
    mockShowWarningMessage.mockResolvedValueOnce(undefined); // user dismissed
    const { publishSkill } = await import('./skillPublish.js');

    const result = await publishSkill({
      filePath: '/testhome/.sidecar/skill.md',
      registryDir: '/reg',
      homeDir: '/testhome',
    });
    expect(result).toBe(false);
    expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining('userRegistry'), expect.any(String));
  });

  it('returns false when registry clone does not exist', async () => {
    mockAccess.mockRejectedValueOnce(new Error('ENOENT')); // registryDir missing
    const { publishSkill } = await import('./skillPublish.js');

    const result = await publishSkill({ filePath: '/path/to/skill.md', registryDir: '/missing-reg' });
    expect(result).toBe(false);
    expect(mockShowWarningMessage).toHaveBeenCalledWith(expect.stringContaining('clone not found'));
  });

  it('copies file, commits, and pushes on success', async () => {
    // registryDir exists, destPath does not exist (no overwrite prompt)
    mockAccess.mockImplementation(async (p: string) => {
      if (p === '/reg') return;
      throw new Error('ENOENT');
    });
    const git = { stage: mockStage, commit: mockCommit, push: mockPush };
    const { publishSkill } = await import('./skillPublish.js');

    const result = await publishSkill({
      filePath: '/testhome/.sidecar/my-skill.md',
      registryDir: '/reg',
      homeDir: '/testhome',
      git: git as unknown as import('../github/git.js').GitCLI,
    });

    expect(result).toBe(true);
    expect(mockWriteFile).toHaveBeenCalledWith('/reg/my-skill.md', expect.any(String), 'utf-8');
    expect(mockStage).toHaveBeenCalledWith(['/reg/my-skill.md']);
    expect(mockCommit).toHaveBeenCalledWith('Add skill: my-skill');
    expect(mockPush).toHaveBeenCalled();
    expect(mockShowInformationMessage).toHaveBeenCalledWith(expect.stringContaining('Published'));
  });

  it('prompts for overwrite confirmation when dest exists', async () => {
    // First access: registryDir exists. Second access: destPath exists.
    mockAccess.mockResolvedValue(undefined);
    mockShowWarningMessage.mockResolvedValueOnce('Overwrite');
    const git = { stage: mockStage, commit: mockCommit, push: mockPush };
    const { publishSkill } = await import('./skillPublish.js');

    const result = await publishSkill({
      filePath: '/testhome/.sidecar/existing.md',
      registryDir: '/reg',
      homeDir: '/testhome',
      git: git as unknown as import('../github/git.js').GitCLI,
    });

    expect(result).toBe(true);
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('already exists'),
      expect.anything(),
      'Overwrite',
    );
  });

  it('returns false when overwrite is declined', async () => {
    mockAccess.mockResolvedValue(undefined);
    mockShowWarningMessage.mockResolvedValueOnce(undefined); // declined
    const { publishSkill } = await import('./skillPublish.js');

    const result = await publishSkill({
      filePath: '/testhome/.sidecar/existing.md',
      registryDir: '/reg',
      homeDir: '/testhome',
    });

    expect(result).toBe(false);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('shows error and returns false on git push failure', async () => {
    mockAccess.mockImplementation(async (p: string) => {
      // registryDir exists, destPath does not
      if (p === '/reg') return;
      throw new Error('ENOENT');
    });
    const failingGit = { stage: vi.fn(), commit: vi.fn(), push: vi.fn().mockRejectedValue(new Error('auth failed')) };
    const { publishSkill } = await import('./skillPublish.js');

    const result = await publishSkill({
      filePath: '/testhome/.sidecar/new-skill.md',
      registryDir: '/reg',
      homeDir: '/testhome',
      git: failingGit as unknown as import('../github/git.js').GitCLI,
    });

    expect(result).toBe(false);
    expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining('auth failed'));
  });
});
