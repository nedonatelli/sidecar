import { describe, it, expect, afterEach } from 'vitest';
import { workspace } from 'vscode';
import { checkDocumentGate } from './documentGate.js';

const wsMock = workspace as Record<string, unknown>;

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
