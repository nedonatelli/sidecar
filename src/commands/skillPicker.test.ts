import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Skill } from '../agent/skillLoader.js';

// ── Mocks ──────────────────────────────────────────────────────────────────

type MockItem = { label: string; description: string; detail: string; skill: Skill };
const mockQuickPick = {
  items: [] as MockItem[],
  placeholder: '',
  matchOnDescription: false,
  matchOnDetail: false,
  canSelectMany: false,
  title: '',
  activeItems: [] as MockItem[],
  selectedItems: [] as MockItem[],
  onDidAccept: vi.fn(),
  onDidHide: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
};

vi.mock('vscode', () => ({
  window: {
    createQuickPick: vi.fn(() => mockQuickPick),
    showInformationMessage: vi.fn(),
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSkill(id: string, overrides: Partial<Skill> = {}): Skill {
  return {
    id,
    name: id,
    description: `${id} description`,
    content: `# ${id}`,
    source: 'builtin',
    filePath: `/skills/${id}.md`,
    ...overrides,
  };
}

function makeLoader(skills: Skill[]) {
  return {
    getAll: () => skills,
    count: skills.length,
    isReady: () => true,
  } as unknown as import('../agent/skillLoader.js').SkillLoader;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('openSkillPicker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockQuickPick.items = [];
    mockQuickPick.activeItems = [];
    mockQuickPick.selectedItems = [];
    mockQuickPick.canSelectMany = false;
  });

  it('returns null when no skills are loaded', async () => {
    const { openSkillPicker } = await import('./skillPicker.js');
    const result = await openSkillPicker(makeLoader([]));
    expect(result).toBeNull();
  });

  it('returns null when user cancels (onDidHide fires)', async () => {
    const { openSkillPicker } = await import('./skillPicker.js');
    const loader = makeLoader([makeSkill('review-code')]);

    mockQuickPick.onDidHide.mockImplementation((cb: () => void) => cb());

    const result = await openSkillPicker(loader);
    expect(result).toBeNull();
  });

  it('returns selected skill on accept in replace mode', async () => {
    const { openSkillPicker } = await import('./skillPicker.js');
    const skill = makeSkill('review-code');
    const loader = makeLoader([skill]);

    mockQuickPick.onDidAccept.mockImplementation((cb: () => void) => {
      mockQuickPick.activeItems = [{ label: '/review-code', description: '', detail: '', skill }];
      cb();
    });
    mockQuickPick.onDidHide.mockImplementation(() => {});

    const result = await openSkillPicker(loader);
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('replace');
    expect(result!.skills).toHaveLength(1);
    expect(result!.skills[0].id).toBe('review-code');
  });

  it('returns multiple skills in stack mode', async () => {
    const { openSkillPicker } = await import('./skillPicker.js');
    const s1 = makeSkill('review-code');
    const s2 = makeSkill('security-reviewer', { source: 'team-registry', registrySlug: 'acme' });
    const loader = makeLoader([s1, s2]);

    mockQuickPick.canSelectMany = true;
    mockQuickPick.onDidAccept.mockImplementation((cb: () => void) => {
      mockQuickPick.selectedItems = [
        { label: '/review-code', description: '', detail: '', skill: s1 },
        { label: '/security-reviewer', description: '', detail: '', skill: s2 },
      ];
      cb();
    });
    mockQuickPick.onDidHide.mockImplementation(() => {});

    const result = await openSkillPicker(loader, { mode: 'stack' });
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('stack');
    expect(result!.skills).toHaveLength(2);
  });

  it('sets canSelectMany when mode is stack', async () => {
    const { openSkillPicker } = await import('./skillPicker.js');
    const loader = makeLoader([makeSkill('debug')]);
    mockQuickPick.onDidHide.mockImplementation((cb: () => void) => cb());

    await openSkillPicker(loader, { mode: 'stack' });
    expect(mockQuickPick.canSelectMany).toBe(true);
  });

  it('adds shield prefix for restricted skills', async () => {
    const { openSkillPicker } = await import('./skillPicker.js');
    const restricted = makeSkill('constrained', { allowedTools: ['read_file', 'grep'] });
    const loader = makeLoader([restricted]);
    mockQuickPick.onDidHide.mockImplementation((cb: () => void) => cb());

    await openSkillPicker(loader);
    const item = mockQuickPick.items[0];
    expect(item.label).toContain('$(shield)');
  });

  it('does not add shield prefix for unrestricted skills', async () => {
    const { openSkillPicker } = await import('./skillPicker.js');
    const plain = makeSkill('explain-code');
    const loader = makeLoader([plain]);
    mockQuickPick.onDidHide.mockImplementation((cb: () => void) => cb());

    await openSkillPicker(loader);
    const item = mockQuickPick.items[0];
    expect(item.label).not.toContain('$(shield)');
  });

  it('includes registry slug in detail for registry skills', async () => {
    const { openSkillPicker } = await import('./skillPicker.js');
    const teamSkill = makeSkill('team-workflow', { source: 'team-registry', registrySlug: 'acme-corp' });
    const loader = makeLoader([teamSkill]);
    mockQuickPick.onDidHide.mockImplementation((cb: () => void) => cb());

    await openSkillPicker(loader);
    const item = mockQuickPick.items[0];
    expect(item.detail).toContain('acme-corp');
  });
});

describe('runSkillPickerCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockQuickPick.items = [];
    mockQuickPick.activeItems = [];
    mockQuickPick.selectedItems = [];
    mockQuickPick.canSelectMany = false;
  });

  it('calls sendToChat with slash command on selection', async () => {
    const { runSkillPickerCommand } = await import('./skillPicker.js');
    const skill = makeSkill('review-code');
    const loader = makeLoader([skill]);
    const sendToChat = vi.fn();

    mockQuickPick.onDidAccept.mockImplementation((cb: () => void) => {
      mockQuickPick.activeItems = [{ label: '/review-code', description: '', detail: '', skill }];
      cb();
    });
    mockQuickPick.onDidHide.mockImplementation(() => {});

    await runSkillPickerCommand(loader, sendToChat);
    expect(sendToChat).toHaveBeenCalledWith('/review-code');
  });

  it('does not call sendToChat when cancelled', async () => {
    const { runSkillPickerCommand } = await import('./skillPicker.js');
    const loader = makeLoader([makeSkill('debug')]);
    const sendToChat = vi.fn();

    mockQuickPick.onDidHide.mockImplementation((cb: () => void) => cb());

    await runSkillPickerCommand(loader, sendToChat);
    expect(sendToChat).not.toHaveBeenCalled();
  });

  it('joins multiple skills with space in stack mode', async () => {
    const { runSkillPickerCommand } = await import('./skillPicker.js');
    const s1 = makeSkill('review-code');
    const s2 = makeSkill('security-reviewer');
    const loader = makeLoader([s1, s2]);
    const sendToChat = vi.fn();

    mockQuickPick.canSelectMany = true;
    mockQuickPick.onDidAccept.mockImplementation((cb: () => void) => {
      mockQuickPick.selectedItems = [
        { label: '/review-code', description: '', detail: '', skill: s1 },
        { label: '/security-reviewer', description: '', detail: '', skill: s2 },
      ];
      cb();
    });
    mockQuickPick.onDidHide.mockImplementation(() => {});

    await runSkillPickerCommand(loader, sendToChat, true);
    expect(sendToChat).toHaveBeenCalledWith('/review-code /security-reviewer');
  });
});
