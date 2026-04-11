import { describe, it, expect } from 'vitest';
import { ProposedContentProvider } from './proposedContentProvider.js';
import { Uri } from 'vscode';

describe('ProposedContentProvider', () => {
  it('returns empty string for unknown URIs', () => {
    const provider = new ProposedContentProvider();
    const uri = Uri.parse('sidecar-proposed:/unknown');
    expect(provider.provideTextDocumentContent(uri)).toBe('');
  });

  it('addProposal stores content and returns a URI', () => {
    const provider = new ProposedContentProvider();
    const uri = provider.addProposal('/src/app.ts', 'proposed code');
    expect(uri).toBeDefined();
    expect(provider.provideTextDocumentContent(uri)).toBe('proposed code');
  });

  it('removeProposal deletes stored content', () => {
    const provider = new ProposedContentProvider();
    const uri = provider.addProposal('/src/app.ts', 'code');
    provider.removeProposal('/src/app.ts');
    expect(provider.provideTextDocumentContent(uri)).toBe('');
  });

  it('dispose clears all content', () => {
    const provider = new ProposedContentProvider();
    provider.addProposal('/a.ts', 'a');
    provider.addProposal('/b.ts', 'b');
    provider.dispose();
    // After dispose, content map is empty
    const uri = Uri.parse('sidecar-proposed:/a.ts');
    expect(provider.provideTextDocumentContent(uri)).toBe('');
  });

  it('overwrites existing proposal for same key', () => {
    const provider = new ProposedContentProvider();
    provider.addProposal('/x.ts', 'first');
    const uri = provider.addProposal('/x.ts', 'second');
    expect(provider.provideTextDocumentContent(uri)).toBe('second');
  });
});
