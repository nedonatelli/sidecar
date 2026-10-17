import * as path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { workspace } from 'vscode';
import { checkDocumentGate } from './documentGate.js';

const wsMock = workspace as Record<string, unknown>;
const ROOT =
  (workspace.workspaceFolders as { uri: { fsPath: string } }[] | undefined)?.[0]?.uri.fsPath ?? process.cwd();

function setDocs(docs: { uri: { fsPath: string }; isDirty: boolean }[]) {
  wsMock.textDocuments = docs;
}

afterEach(() => {
  delete wsMock.textDocuments;
});

describe('checkDocumentGate', () => {
  it('returns not dirty when given an empty file list', () => {
    setDocs([]);
    const result = checkDocumentGate([]);
    expect(result.dirty).toBe(false);
    expect(result.dirtyFiles).toEqual([]);
  });

  it('returns not dirty when no documents are open', () => {
    setDocs([]);
    const result = checkDocumentGate(['src/app.ts']);
    expect(result.dirty).toBe(false);
  });

  it('returns dirty when a target file is open and has unsaved changes', () => {
    setDocs([{ uri: { fsPath: '/workspace/src/app.ts' }, isDirty: true }]);
    const result = checkDocumentGate(['/workspace/src/app.ts']);
    expect(result.dirty).toBe(true);
    expect(result.dirtyFiles).toContain('/workspace/src/app.ts');
  });

  it('returns not dirty when a target file is open but clean', () => {
    setDocs([{ uri: { fsPath: '/workspace/src/clean.ts' }, isDirty: false }]);
    const result = checkDocumentGate(['/workspace/src/clean.ts']);
    expect(result.dirty).toBe(false);
    expect(result.dirtyFiles).toHaveLength(0);
  });

  it('matches by basename when full paths differ', () => {
    setDocs([{ uri: { fsPath: '/workspace/src/utils.ts' }, isDirty: true }]);
    const result = checkDocumentGate(['utils.ts']);
    expect(result.dirty).toBe(true);
  });

  // #115: a target with a directory, relative to the workspace, never matched
  // the open document's absolute path.
  it('matches a workspace-relative target to the open absolute path', () => {
    setDocs([{ uri: { fsPath: path.resolve(ROOT, 'src/deep/mod.ts') }, isDirty: true }]);
    expect(checkDocumentGate(['src/deep/mod.ts']).dirtyFiles).toEqual(['src/deep/mod.ts']);
    expect(checkDocumentGate(['src/other/mod.ts']).dirty).toBe(false);
  });

  // Each platform's case rules, exercised on every machine through the
  // `platform` parameter. (The darwin case had no coverage at all; it was
  // verified by hand on a Mac before becoming this test.)
  it('ignores drive-letter and path case on Windows', () => {
    const abs = path.resolve(ROOT, 'Src/A.ts');
    setDocs([
      { uri: { fsPath: abs.replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`) }, isDirty: true },
    ]);
    const target = abs.replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toUpperCase()}:`).toLowerCase();
    expect(checkDocumentGate([target], 'win32').dirty).toBe(true);
  });

  it('ignores path case on macOS, for absolute and workspace-relative targets', () => {
    setDocs([{ uri: { fsPath: path.resolve(ROOT, 'Src/Deep/Mod.ts') }, isDirty: true }]);
    expect(checkDocumentGate([path.resolve(ROOT, 'src/deep/MOD.ts')], 'darwin').dirty).toBe(true);
    expect(checkDocumentGate(['src/deep/mod.ts'], 'darwin').dirty).toBe(true);
    expect(checkDocumentGate(['src/other/mod.ts'], 'darwin').dirty).toBe(false);
  });

  it('keeps path case on Linux, where Mod.ts and mod.ts are different files', () => {
    setDocs([{ uri: { fsPath: path.resolve(ROOT, 'Src/Deep/Mod.ts') }, isDirty: true }]);
    expect(checkDocumentGate(['Src/Deep/Mod.ts'], 'linux').dirty).toBe(true);
    expect(checkDocumentGate(['src/deep/mod.ts'], 'linux').dirty).toBe(false);
  });

  it('returns only the dirty files among multiple targets', () => {
    setDocs([
      { uri: { fsPath: '/workspace/src/dirty.ts' }, isDirty: true },
      { uri: { fsPath: '/workspace/src/clean.ts' }, isDirty: false },
    ]);
    const result = checkDocumentGate(['/workspace/src/dirty.ts', '/workspace/src/clean.ts']);
    expect(result.dirty).toBe(true);
    expect(result.dirtyFiles).toContain('/workspace/src/dirty.ts');
    expect(result.dirtyFiles).not.toContain('/workspace/src/clean.ts');
  });
});
