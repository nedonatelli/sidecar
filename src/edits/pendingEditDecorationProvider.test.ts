import { describe, it, expect, beforeEach } from 'vitest';
import { Uri } from 'vscode';
import { PendingEditStore } from '../agent/pendingEdits.js';
import { PendingEditDecorationProvider } from './pendingEditDecorationProvider.js';

describe('PendingEditDecorationProvider', () => {
  let store: PendingEditStore;
  let provider: PendingEditDecorationProvider;

  beforeEach(() => {
    store = new PendingEditStore();
    provider = new PendingEditDecorationProvider(store);
  });

  it('returns undefined for files with no pending edit', () => {
    const deco = provider.provideFileDecoration(Uri.file('/tmp/nothing.ts'));
    expect(deco).toBeUndefined();
  });

  it('returns a P badge for files with a pending edit', () => {
    store.record('/tmp/app.ts', 'old', 'new', 'write_file');
    const deco = provider.provideFileDecoration(Uri.file('/tmp/app.ts'));
    expect(deco).toBeDefined();
    expect(deco?.badge).toBe('P');
    expect(deco?.tooltip).toContain('pending agent edit');
    expect(deco?.propagate).toBe(true);
  });

  it('ignores non-file URIs (git:/, untitled:, etc.)', () => {
    store.record('/tmp/app.ts', 'old', 'new', 'write_file');
    const fake = { scheme: 'git', fsPath: '/tmp/app.ts' } as Uri;
    const deco = provider.provideFileDecoration(fake);
    expect(deco).toBeUndefined();
  });

  it('fires onDidChangeFileDecorations when an edit is added', () => {
    const fired: Uri[][] = [];
    const sub = provider.onDidChangeFileDecorations((uris) => fired.push(uris));
    store.record('/tmp/new.ts', null, 'hello', 'write_file');
    sub.dispose();
    expect(fired).toHaveLength(1);
    expect(fired[0][0].fsPath).toBe('/tmp/new.ts');
  });

  it('fires a refresh for files whose pending edit was removed', () => {
    store.record('/tmp/app.ts', 'old', 'new', 'write_file');
    const fired: Uri[][] = [];
    const sub = provider.onDidChangeFileDecorations((uris) => fired.push(uris));
    store.remove('/tmp/app.ts');
    sub.dispose();
    expect(fired).toHaveLength(1);
    // The removed file should be in the refresh so its badge clears.
    expect(fired[0].some((u) => u.fsPath === '/tmp/app.ts')).toBe(true);
  });

  it('does not fire when a re-record lands on the same file with identical set membership', () => {
    store.record('/tmp/app.ts', 'old', 'v1', 'write_file');
    const fired: Uri[][] = [];
    const sub = provider.onDidChangeFileDecorations((uris) => fired.push(uris));
    // Second write to the same path — membership unchanged, so no
    // decoration refresh is needed.
    store.record('/tmp/app.ts', 'old', 'v2', 'edit_file');
    sub.dispose();
    expect(fired).toHaveLength(0);
  });

  it('clear() fires a single refresh covering all previously-decorated files', () => {
    store.record('/a.ts', null, 'one', 'write_file');
    store.record('/b.ts', null, 'two', 'write_file');
    const fired: Uri[][] = [];
    const sub = provider.onDidChangeFileDecorations((uris) => fired.push(uris));
    store.clear();
    sub.dispose();
    expect(fired).toHaveLength(1);
    const paths = fired[0].map((u) => u.fsPath).sort();
    expect(paths).toEqual(['/a.ts', '/b.ts']);
  });

  it('dispose() stops the provider from firing further events', () => {
    const fired: Uri[][] = [];
    const sub = provider.onDidChangeFileDecorations((uris) => fired.push(uris));
    provider.dispose();
    store.record('/after.ts', null, 'x', 'write_file');
    sub.dispose();
    expect(fired).toHaveLength(0);
  });
});
