import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeTool } from './executor.js';
import type { ToolUseContentBlock } from '../ollama/types.js';
import type { ChangeLog } from './changelog.js';
import { window } from 'vscode';

// Mock the modules
vi.mock('../config/settings.js', () => ({
  getToolPermissions: vi.fn(() => ({})),
  getHooks: vi.fn(() => ({})),
}));

vi.mock('./tools.js', () => ({
  findTool: vi.fn(),
}));

import { findTool } from './tools.js';
import { getToolPermissions } from '../config/settings.js';

const mockedFindTool = vi.mocked(findTool);
const mockedGetPermissions = vi.mocked(getToolPermissions);

function makeToolUse(name: string, input: Record<string, unknown> = {}): ToolUseContentBlock {
  return { type: 'tool_use', id: 'test_1', name, input };
}

describe('executeTool', () => {
  let showWarningSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetPermissions.mockReturnValue({});
    showWarningSpy = vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);
  });

  it('returns error for unknown tool', async () => {
    mockedFindTool.mockReturnValue(undefined);
    const result = await executeTool(makeToolUse('nonexistent'));
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Unknown tool');
  });

  it('returns error when tool permission is deny', async () => {
    mockedFindTool.mockReturnValue({
      definition: { name: 'read_file', description: '', input_schema: { type: 'object', properties: {} } },
      executor: async () => 'ok',
      requiresApproval: false,
    });
    mockedGetPermissions.mockReturnValue({ read_file: 'deny' });

    const result = await executeTool(makeToolUse('read_file'));
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('denied by policy');
  });

  it('skips approval when permission is allow', async () => {
    const executor = vi.fn().mockResolvedValue('file contents');
    mockedFindTool.mockReturnValue({
      definition: { name: 'write_file', description: '', input_schema: { type: 'object', properties: {} } },
      executor,
      requiresApproval: true,
    });
    mockedGetPermissions.mockReturnValue({ write_file: 'allow' });

    const result = await executeTool(makeToolUse('write_file', { path: 'test.ts', content: 'hi' }), 'cautious');
    expect(result.is_error).toBeFalsy();
    expect(result.content).toBe('file contents');
    expect(showWarningSpy).not.toHaveBeenCalled();
  });

  it('shows approval dialog in cautious mode for write tools', async () => {
    const executor = vi.fn().mockResolvedValue('written');
    mockedFindTool.mockReturnValue({
      definition: { name: 'write_file', description: '', input_schema: { type: 'object', properties: {} } },
      executor,
      requiresApproval: true,
    });
    showWarningSpy.mockResolvedValue('Allow' as never);

    const result = await executeTool(makeToolUse('write_file', { path: 'test.ts' }), 'cautious');
    expect(showWarningSpy).toHaveBeenCalled();
    expect(result.content).toBe('written');
  });

  it('returns error when user denies approval', async () => {
    mockedFindTool.mockReturnValue({
      definition: { name: 'write_file', description: '', input_schema: { type: 'object', properties: {} } },
      executor: async () => 'ok',
      requiresApproval: true,
    });
    showWarningSpy.mockResolvedValue('Deny' as never);

    const result = await executeTool(makeToolUse('write_file', { path: 'test.ts' }), 'cautious');
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('denied by user');
  });

  it('does not require approval in autonomous mode for read tools', async () => {
    const executor = vi.fn().mockResolvedValue('data');
    mockedFindTool.mockReturnValue({
      definition: { name: 'read_file', description: '', input_schema: { type: 'object', properties: {} } },
      executor,
      requiresApproval: false,
    });

    const result = await executeTool(makeToolUse('read_file', { path: 'test.ts' }), 'autonomous');
    expect(showWarningSpy).not.toHaveBeenCalled();
    expect(result.content).toBe('data');
  });

  it('snapshots file before write_file when changelog provided', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    mockedFindTool.mockReturnValue({
      definition: { name: 'write_file', description: '', input_schema: { type: 'object', properties: {} } },
      executor,
      requiresApproval: false,
    });
    mockedGetPermissions.mockReturnValue({ write_file: 'allow' });

    const changelog = { snapshotFile: vi.fn().mockResolvedValue(undefined) } as unknown as ChangeLog;
    await executeTool(makeToolUse('write_file', { path: 'src/main.ts', content: 'new' }), 'autonomous', changelog);
    expect(changelog.snapshotFile).toHaveBeenCalledWith('src/main.ts');
  });

  it('returns error when executor throws', async () => {
    mockedFindTool.mockReturnValue({
      definition: { name: 'read_file', description: '', input_schema: { type: 'object', properties: {} } },
      executor: async () => {
        throw new Error('file not found');
      },
      requiresApproval: false,
    });

    const result = await executeTool(makeToolUse('read_file', { path: 'missing.ts' }));
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('file not found');
  });

  it('requires approval for all tools in manual mode', async () => {
    const executor = vi.fn().mockResolvedValue('data');
    mockedFindTool.mockReturnValue({
      definition: { name: 'read_file', description: '', input_schema: { type: 'object', properties: {} } },
      executor,
      requiresApproval: false,
    });
    showWarningSpy.mockResolvedValue('Allow' as never);

    await executeTool(makeToolUse('read_file', { path: 'test.ts' }), 'manual');
    expect(showWarningSpy).toHaveBeenCalled();
  });
});
