import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../agent/audit/auditBuffer.js', () => ({
  getDefaultAuditBuffer: vi.fn(() => ({
    read: vi.fn(() => ({ buffered: false, deleted: false })),
  })),
}));

import {
  AuditFileDecorationProvider,
  getAuditDecorationProvider,
  setAuditDecorationProvider,
} from './auditDecorations.js';
import { getDefaultAuditBuffer } from '../agent/audit/auditBuffer.js';

function makeUri(fsPath: string) {
  return { fsPath, scheme: 'file', path: fsPath };
}

describe('getAuditDecorationProvider / setAuditDecorationProvider', () => {
  it('returns null before any instance is set', () => {
    // Reset module-level singleton by re-reading the export
    expect(getAuditDecorationProvider()).toBeNull();
  });

  it('returns the instance after setAuditDecorationProvider', () => {
    const provider = new AuditFileDecorationProvider();
    setAuditDecorationProvider(provider);
    expect(getAuditDecorationProvider()).toBe(provider);
    // Clean up
    (setAuditDecorationProvider as unknown as (p: null) => void)(null as never);
  });
});

describe('AuditFileDecorationProvider.provideFileDecoration', () => {
  let provider: AuditFileDecorationProvider;
  let readMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    readMock = vi.fn(() => ({ buffered: false, deleted: false }));
    vi.mocked(getDefaultAuditBuffer).mockReturnValue({ read: readMock } as never);
    provider = new AuditFileDecorationProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined when the path is outside the workspace root', () => {
    // workspace.workspaceFolders[0].uri.fsPath = '/mock-workspace' (from mock)
    const uri = makeUri('/other-root/file.ts');
    expect(provider.provideFileDecoration(uri as never)).toBeUndefined();
  });

  it('returns undefined when the file is not buffered', () => {
    readMock.mockReturnValue({ buffered: false, deleted: false });
    const uri = makeUri('/mock-workspace/src/foo.ts');
    expect(provider.provideFileDecoration(uri as never)).toBeUndefined();
  });

  it('returns pending-change decoration for a buffered (non-deleted) file', () => {
    readMock.mockReturnValue({ buffered: true, deleted: false });
    const uri = makeUri('/mock-workspace/src/foo.ts');
    const dec = provider.provideFileDecoration(uri as never);
    expect(dec).toBeDefined();
    expect(dec!.badge).toBe('~');
    expect(dec!.tooltip).toContain('pending change');
  });

  it('returns pending-delete decoration for a buffered deleted file', () => {
    readMock.mockReturnValue({ buffered: true, deleted: true });
    const uri = makeUri('/mock-workspace/src/bar.ts');
    const dec = provider.provideFileDecoration(uri as never);
    expect(dec).toBeDefined();
    expect(dec!.badge).toBe('✗');
    expect(dec!.tooltip).toContain('pending delete');
  });

  it('strips the workspace prefix and passes the relative path to buf.read', () => {
    readMock.mockReturnValue({ buffered: false, deleted: false });
    provider.provideFileDecoration(makeUri('/mock-workspace/src/util.ts') as never);
    expect(readMock).toHaveBeenCalledWith('src/util.ts');
  });

  it('calls buf.read on every invocation with the relative path', () => {
    readMock.mockReturnValue({ buffered: false, deleted: false });
    provider.provideFileDecoration(makeUri('/mock-workspace/a.ts') as never);
    provider.provideFileDecoration(makeUri('/mock-workspace/b.ts') as never);
    expect(readMock).toHaveBeenCalledTimes(2);
    expect(readMock).toHaveBeenCalledWith('a.ts');
    expect(readMock).toHaveBeenCalledWith('b.ts');
  });
});

describe('AuditFileDecorationProvider.refresh', () => {
  it('fires onDidChangeFileDecorations event with the given URIs', () => {
    const provider = new AuditFileDecorationProvider();
    const listener = vi.fn();
    provider.onDidChangeFileDecorations(listener);

    const uris = [makeUri('/mock-workspace/a.ts'), makeUri('/mock-workspace/b.ts')];
    provider.refresh(uris as never[]);

    expect(listener).toHaveBeenCalledWith(uris);
  });

  it('fires without argument when no URIs are passed', () => {
    const provider = new AuditFileDecorationProvider();
    const listener = vi.fn();
    provider.onDidChangeFileDecorations(listener);

    provider.refresh();

    expect(listener).toHaveBeenCalledWith(undefined);
  });
});
