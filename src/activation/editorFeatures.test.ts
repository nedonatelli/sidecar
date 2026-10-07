import { describe, it, expect, vi } from 'vitest';
import { languages } from 'vscode';
import { registerCompletionProvider } from './editorFeatures.js';
import type { SideCarCompletionProvider } from '../completions/provider.js';

// #119: the completion provider was re-created on every setting change and
// only its registration was disposed, leaking its document-change listener.
describe('registerCompletionProvider', () => {
  it('disposes the provider along with its registration', () => {
    const unregister = vi.fn();
    vi.spyOn(languages, 'registerInlineCompletionItemProvider').mockReturnValue({ dispose: unregister } as never);
    const provider = { dispose: vi.fn() } as unknown as SideCarCompletionProvider;
    registerCompletionProvider(provider).dispose();
    expect(unregister).toHaveBeenCalledOnce();
    expect(provider.dispose).toHaveBeenCalledOnce();
  });
});
