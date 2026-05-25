/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/project' } }],
    fs: {
      readFile: vi.fn(),
      readDirectory: vi.fn().mockResolvedValue([]),
    },
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, path: p }),
    joinPath: (base: { fsPath: string }, ...segs: string[]) => {
      const p = base.fsPath + '/' + segs.join('/');
      return { fsPath: p, path: p };
    },
  },
  FileType: { File: 1, Directory: 2 },
}));

import { SkillLoader } from './skillLoader.js';
import { workspace, FileType } from 'vscode';

const mockReadDir = vi.mocked(workspace.fs.readDirectory);
const mockReadFile = vi.mocked(workspace.fs.readFile);

describe('SkillLoader', () => {
  let loader: SkillLoader;

  beforeEach(() => {
    loader = new SkillLoader();
    mockReadDir.mockReset();
    mockReadFile.mockReset();
    // Default: all dirs empty
    mockReadDir.mockResolvedValue([]);
  });

  it('initializes with no skills when dirs are empty', async () => {
    await loader.initialize();
    expect(loader.isReady()).toBe(true);
    expect(loader.count).toBe(0);
  });

  it('parses skill files with frontmatter', async () => {
    // Simulate built-in skills dir
    loader.setBuiltinPath('/ext/skills');
    mockReadDir.mockImplementation(async (uri: any) => {
      if (uri.fsPath.includes('/ext/skills')) {
        return [['review-code.md', FileType.File]];
      }
      return [];
    });
    mockReadFile.mockImplementation(async (uri: any) => {
      if (uri.fsPath.includes('review-code.md')) {
        return Buffer.from('---\nname: Code Review\ndescription: Review code for bugs\n---\n\n# Review\nDo a review.');
      }
      throw new Error('not found');
    });

    await loader.initialize();
    expect(loader.count).toBe(1);
    const skill = loader.get('review-code');
    expect(skill).not.toBeUndefined();
    expect(skill!.name).toBe('Code Review');
    expect(skill!.description).toBe('Review code for bugs');
    expect(skill!.content).toContain('# Review');
    expect(skill!.source).toBe('builtin');
  });

  it('later sources override earlier on name conflict', async () => {
    loader.setBuiltinPath('/ext/skills');
    mockReadDir.mockImplementation(async (uri: any) => {
      if (uri.fsPath.includes('/ext/skills') || uri.fsPath.includes('.claude/commands')) {
        return [['test-skill.md', FileType.File]];
      }
      return [];
    });
    mockReadFile.mockImplementation(async (uri: any) => {
      if (uri.fsPath.includes('/ext/skills')) {
        return Buffer.from('---\nname: Built-in\n---\nBuilt-in version');
      }
      if (uri.fsPath.includes('.claude/commands')) {
        return Buffer.from('---\nname: Project Override\n---\nProject version');
      }
      throw new Error('not found');
    });

    await loader.initialize();
    const skill = loader.get('test-skill');
    expect(skill!.name).toBe('Project Override');
    expect(skill!.source).toBe('project-claude');
  });

  it('getAll returns all skills', async () => {
    loader.setBuiltinPath('/ext/skills');
    mockReadDir.mockImplementation(async (uri: any) => {
      if (uri.fsPath.includes('/ext/skills')) {
        return [
          ['a.md', FileType.File],
          ['b.md', FileType.File],
        ];
      }
      return [];
    });
    mockReadFile.mockImplementation(async () => Buffer.from('---\nname: Skill\n---\nContent'));

    await loader.initialize();
    expect(loader.getAll()).toHaveLength(2);
  });

  it('listFormatted returns formatted string', async () => {
    loader.setBuiltinPath('/ext/skills');
    mockReadDir.mockImplementation(async (uri: any) => {
      if (uri.fsPath.includes('/ext/skills')) {
        return [['my-skill.md', FileType.File]];
      }
      return [];
    });
    mockReadFile.mockImplementation(async () =>
      Buffer.from('---\nname: My Skill\ndescription: Does things\n---\nContent'),
    );

    await loader.initialize();
    const list = loader.listFormatted();
    expect(list).toContain('**Available skills (1):**');
    expect(list).toContain('/my-skill');
    expect(list).toContain('Does things');
  });

  it('match returns skill by keyword', async () => {
    loader.setBuiltinPath('/ext/skills');
    mockReadDir.mockImplementation(async (uri: any) => {
      if (uri.fsPath.includes('/ext/skills')) {
        return [['debug.md', FileType.File]];
      }
      return [];
    });
    mockReadFile.mockImplementation(async () =>
      Buffer.from('---\nname: Debug\ndescription: Debug issues\n---\nDebug content with breakpoints and errors'),
    );

    await loader.initialize();
    // Match by slash command
    const exact = loader.match('/debug something');
    expect(exact).not.toBeNull();
    expect(exact!.id).toBe('debug');
  });

  it('handles missing directories gracefully', async () => {
    mockReadDir.mockRejectedValue(new Error('ENOENT'));
    await loader.initialize();
    expect(loader.count).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Skills 2.0 — enforced frontmatter fields
  // ---------------------------------------------------------------------------

  it('parses allowed-tools as inline comma list', async () => {
    loader.setBuiltinPath('/ext/skills');
    mockReadDir.mockImplementation(async (uri: any) => {
      if (uri.fsPath.includes('/ext/skills')) return [['restricted.md', FileType.File]];
      return [];
    });
    mockReadFile.mockImplementation(async () =>
      Buffer.from('---\nname: Restricted\nallowed-tools: read_file, list_files\n---\nContent'),
    );

    await loader.initialize();
    const skill = loader.get('restricted');
    expect(skill!.allowedTools).toEqual(['read_file', 'list_files']);
  });

  it('parses allowed-tools as YAML block list', async () => {
    loader.setBuiltinPath('/ext/skills');
    mockReadDir.mockImplementation(async (uri: any) => {
      if (uri.fsPath.includes('/ext/skills')) return [['block.md', FileType.File]];
      return [];
    });
    mockReadFile.mockImplementation(async () =>
      Buffer.from('---\nname: Block\nallowed-tools:\n  - read_file\n  - run_command\n---\nContent'),
    );

    await loader.initialize();
    const skill = loader.get('block');
    expect(skill!.allowedTools).toEqual(['read_file', 'run_command']);
  });

  it('parses preferred-model', async () => {
    loader.setBuiltinPath('/ext/skills');
    mockReadDir.mockImplementation(async (uri: any) => {
      if (uri.fsPath.includes('/ext/skills')) return [['smart.md', FileType.File]];
      return [];
    });
    mockReadFile.mockImplementation(async () =>
      Buffer.from('---\nname: Smart\npreferred-model: claude-opus-4-7\n---\nContent'),
    );

    await loader.initialize();
    expect(loader.get('smart')!.preferredModel).toBe('claude-opus-4-7');
  });

  it('parses max-iterations', async () => {
    loader.setBuiltinPath('/ext/skills');
    mockReadDir.mockImplementation(async (uri: any) => {
      if (uri.fsPath.includes('/ext/skills')) return [['quick.md', FileType.File]];
      return [];
    });
    mockReadFile.mockImplementation(async () => Buffer.from('---\nname: Quick\nmax-iterations: 5\n---\nContent'));

    await loader.initialize();
    expect(loader.get('quick')!.maxIterations).toBe(5);
  });

  it('parses disable-model-invocation: true', async () => {
    loader.setBuiltinPath('/ext/skills');
    mockReadDir.mockImplementation(async (uri: any) => {
      if (uri.fsPath.includes('/ext/skills')) return [['ref.md', FileType.File]];
      return [];
    });
    mockReadFile.mockImplementation(async () =>
      Buffer.from('---\nname: Ref\ndisable-model-invocation: true\n---\nContent'),
    );

    await loader.initialize();
    expect(loader.get('ref')!.disableModelInvocation).toBe(true);
  });

  it('does not set skills 2.0 fields when not in frontmatter', async () => {
    loader.setBuiltinPath('/ext/skills');
    mockReadDir.mockImplementation(async (uri: any) => {
      if (uri.fsPath.includes('/ext/skills')) return [['plain.md', FileType.File]];
      return [];
    });
    mockReadFile.mockImplementation(async () =>
      Buffer.from('---\nname: Plain\ndescription: Simple skill\n---\nContent'),
    );

    await loader.initialize();
    const skill = loader.get('plain');
    expect(skill!.allowedTools).toBeUndefined();
    expect(skill!.preferredModel).toBeUndefined();
    expect(skill!.maxIterations).toBeUndefined();
    expect(skill!.disableModelInvocation).toBeUndefined();
  });

  it('listFormatted shows shield badge for restricted skills', async () => {
    loader.setBuiltinPath('/ext/skills');
    mockReadDir.mockImplementation(async (uri: any) => {
      if (uri.fsPath.includes('/ext/skills'))
        return [
          ['restricted.md', FileType.File],
          ['plain.md', FileType.File],
        ];
      return [];
    });
    mockReadFile.mockImplementation(async (uri: any) => {
      if (uri.fsPath.includes('restricted'))
        return Buffer.from('---\nname: Restricted\nallowed-tools: read_file\n---\nContent');
      return Buffer.from('---\nname: Plain\n---\nContent');
    });

    await loader.initialize();
    const list = loader.listFormatted();
    const lines = list.split('\n');
    const restrictedLine = lines.find((l) => l.includes('/restricted'));
    const plainLine = lines.find((l) => l.includes('/plain'));
    expect(restrictedLine).toContain('🛡');
    expect(plainLine).not.toContain('🛡');
  });

  it('skips non-.md files', async () => {
    loader.setBuiltinPath('/ext/skills');
    mockReadDir.mockImplementation(async (uri: any) => {
      if (uri.fsPath.includes('/ext/skills')) {
        return [
          ['readme.txt', FileType.File],
          ['skill.md', FileType.File],
        ];
      }
      return [];
    });
    mockReadFile.mockImplementation(async () => Buffer.from('---\nname: S\n---\nC'));

    await loader.initialize();
    expect(loader.count).toBe(1);
  });
});
