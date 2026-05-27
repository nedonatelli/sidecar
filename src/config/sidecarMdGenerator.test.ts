import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./workspace.js', () => ({
  getWorkspaceRoot: vi.fn().mockReturnValue('/workspace'),
}));

import { generateSidecarMd } from './sidecarMdGenerator.js';
import { getWorkspaceRoot } from './workspace.js';
import { workspace, window } from 'vscode';
import type { SideCarClient } from '../ollama/client.js';

function makeMockClient(completeResult = '# My Project\n\nProject description.'): SideCarClient {
  return {
    complete: vi.fn().mockResolvedValue(completeResult),
    updateSystemPrompt: vi.fn(),
    completeWithOverrides: vi.fn(),
  } as unknown as SideCarClient;
}

describe('generateSidecarMd', () => {
  beforeEach(() => {
    vi.mocked(getWorkspaceRoot).mockReturnValue('/workspace');
    vi.mocked(window.showWarningMessage).mockResolvedValue(undefined);
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValue(new Error('ENOENT'));
    vi.spyOn(workspace.fs, 'readDirectory').mockResolvedValue([]);
    vi.spyOn(workspace.fs, 'stat').mockRejectedValue(new Error('ENOENT'));
    vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns early when there is no workspace root', async () => {
    vi.mocked(getWorkspaceRoot).mockReturnValue(null as unknown as string);
    const client = makeMockClient();

    await generateSidecarMd(client);

    expect(window.showWarningMessage).toHaveBeenCalledWith('No workspace folder open.');
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('returns early when user cancels overwrite dialog for existing SIDECAR.md', async () => {
    vi.spyOn(workspace.fs, 'readFile').mockImplementation((uri) => {
      const u = uri as { fsPath: string };
      if (u.fsPath.endsWith('SIDECAR.md')) {
        return Promise.resolve(Buffer.from('existing content'));
      }
      return Promise.reject(new Error('ENOENT'));
    });

    // User hits Cancel — showWarningMessage returns undefined (not 'Overwrite')
    vi.mocked(window.showWarningMessage).mockResolvedValue(undefined);

    const client = makeMockClient();
    await generateSidecarMd(client);

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      'SIDECAR.md already exists. Overwrite it?',
      { modal: true },
      'Overwrite',
    );
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('calls client.complete() and writes the result when no existing SIDECAR.md', async () => {
    // readFile already throws ENOENT for every path (set in beforeEach)
    const expectedContent = '# My Project\n\nProject description.';
    const client = makeMockClient(expectedContent);

    await generateSidecarMd(client);

    expect(client.complete).toHaveBeenCalledOnce();
    expect(workspace.fs.writeFile).toHaveBeenCalledOnce();

    const [, writtenBytes] = vi.mocked(workspace.fs.writeFile).mock.calls[0];
    const writtenContent = Buffer.from(writtenBytes as Uint8Array).toString('utf-8');
    expect(writtenContent).toBe(expectedContent);
  });

  it('strips markdown code fences from model output before writing', async () => {
    const rawOutput = '```\n# My Project\n\nProject description.\n```';
    const client = makeMockClient(rawOutput);

    await generateSidecarMd(client);

    const [, writtenBytes] = vi.mocked(workspace.fs.writeFile).mock.calls[0];
    const writtenContent = Buffer.from(writtenBytes as Uint8Array).toString('utf-8');
    expect(writtenContent).not.toMatch(/^```/);
    expect(writtenContent).not.toMatch(/```$/);
    expect(writtenContent).toContain('# My Project');
  });

  it('strips ```markdown\\n prefix from model output before writing', async () => {
    const rawOutput = '```markdown\n# My Project\n\nProject description.\n```';
    const client = makeMockClient(rawOutput);

    await generateSidecarMd(client);

    const [, writtenBytes] = vi.mocked(workspace.fs.writeFile).mock.calls[0];
    const writtenContent = Buffer.from(writtenBytes as Uint8Array).toString('utf-8');
    expect(writtenContent).not.toMatch(/^```/);
    expect(writtenContent).not.toMatch(/```$/);
    expect(writtenContent).not.toMatch(/^markdown/);
    expect(writtenContent).toContain('# My Project');
  });

  it('proceeds to overwrite when user confirms the overwrite dialog', async () => {
    vi.spyOn(workspace.fs, 'readFile').mockImplementation((uri) => {
      const u = uri as { fsPath: string };
      if (u.fsPath.endsWith('SIDECAR.md')) {
        return Promise.resolve(Buffer.from('old content'));
      }
      return Promise.reject(new Error('ENOENT'));
    });

    // Simulate the mock returning the string 'Overwrite' (what vscode returns when user picks it)
    vi.mocked(window.showWarningMessage).mockResolvedValue('Overwrite' as never);

    const client = makeMockClient('# New Content');
    await generateSidecarMd(client);

    expect(client.complete).toHaveBeenCalledOnce();
    expect(workspace.fs.writeFile).toHaveBeenCalledOnce();
  });

  it('strips ```md\\n prefix from model output before writing', async () => {
    const rawOutput = '```md\n# My Project\n\nProject description.\n```';
    const client = makeMockClient(rawOutput);

    await generateSidecarMd(client);

    const [, writtenBytes] = vi.mocked(workspace.fs.writeFile).mock.calls[0];
    const writtenContent = Buffer.from(writtenBytes as Uint8Array).toString('utf-8');
    expect(writtenContent).not.toMatch(/^```/);
    expect(writtenContent).toContain('# My Project');
  });
});
