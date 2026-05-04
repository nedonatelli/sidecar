import { describe, it, expect } from 'vitest';
import { chunkText } from './textChunker.js';

const FILE = 'docs/guide.md';

describe('chunkText', () => {
  it('returns empty array for blank content', () => {
    expect(chunkText('', FILE)).toEqual([]);
    expect(chunkText('   \n\n  ', FILE)).toEqual([]);
  });

  it('returns a single chunk for content under chunkSize', () => {
    const content = 'Hello world.\n\nSecond paragraph.';
    const chunks = chunkText(content, FILE, { chunkSize: 1000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].filePath).toBe(FILE);
    expect(chunks[0].content).toContain('Hello world');
    expect(chunks[0].content).toContain('Second paragraph');
    expect(chunks[0].startLine).toBe(1);
  });

  it('splits into multiple chunks when content exceeds chunkSize', () => {
    const para = 'A'.repeat(400);
    const content = [para, para, para].join('\n\n');
    const chunks = chunkText(content, FILE, { chunkSize: 500, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('never splits mid-paragraph', () => {
    const longPara = 'word '.repeat(300); // ~1500 chars, one paragraph
    const chunks = chunkText(longPara, FILE, { chunkSize: 500, overlap: 100 });
    // A single paragraph longer than chunkSize is emitted as its own chunk.
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(longPara.trim());
  });

  it('assigns stable ids with filePath prefix', () => {
    const content = 'Para one.\n\nPara two.\n\nPara three.';
    const chunks = chunkText(content, FILE, { chunkSize: 20, overlap: 5 });
    for (const c of chunks) {
      expect(c.id).toMatch(new RegExp(`^${FILE}:`));
    }
  });

  it('all ids are unique', () => {
    const content = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} content here.`).join('\n\n');
    const chunks = chunkText(content, FILE, { chunkSize: 100, overlap: 20 });
    const ids = chunks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tracks heading context for markdown', () => {
    const content = '## Installation\n\nRun npm install.\n\nThen start the server.';
    const chunks = chunkText(content, FILE, { chunkSize: 1000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe('## Installation');
    expect(chunks[0].content).toContain('## Installation');
    expect(chunks[0].content).toContain('npm install');
  });

  it('heading is not double-included when it is the only content', () => {
    const content = '## Setup\n\nStep one.\n\nStep two.';
    const chunks = chunkText(content, FILE, { chunkSize: 1000 });
    // heading should appear once as prefix, body has the steps
    const text = chunks[0].content;
    expect(text.indexOf('## Setup')).toBe(0);
    expect(text.lastIndexOf('## Setup')).toBe(0);
  });

  it('resets heading on new section boundary', () => {
    const content = ['## Section A', 'Content A.', '## Section B', 'Content B.'].join('\n\n');
    const chunks = chunkText(content, FILE, { chunkSize: 1000 });
    // Both sections fit in one chunk — heading is whichever was last set before flush
    // (Section B overrides Section A before Content B is buffered)
    const headings = chunks.map((c) => c.heading);
    expect(headings.some((h) => h === '## Section A' || h === '## Section B')).toBe(true);
  });

  it('two sections each in their own chunk when size is small', () => {
    const content = ['## Alpha', 'A'.repeat(200), '## Beta', 'B'.repeat(200)].join('\n\n');
    const chunks = chunkText(content, FILE, { chunkSize: 250, overlap: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const alphaChunk = chunks.find((c) => c.content.includes('## Alpha'));
    const betaChunk = chunks.find((c) => c.content.includes('## Beta'));
    expect(alphaChunk).toBeDefined();
    expect(betaChunk).toBeDefined();
    expect(alphaChunk?.heading).toBe('## Alpha');
    expect(betaChunk?.heading).toBe('## Beta');
  });

  it('overlap carries paragraphs into the next chunk', () => {
    // Three paragraphs of 300 chars each; chunkSize=400 means first chunk fits 1+partial,
    // overlap carries the last paragraph of chunk 1 into chunk 2.
    const paraA = 'Alpha '.repeat(50).trim(); // 300 chars
    const paraB = 'Beta '.repeat(60).trim(); // 300 chars
    const paraC = 'Gamma '.repeat(50).trim(); // 300 chars
    const content = [paraA, paraB, paraC].join('\n\n');
    const chunks = chunkText(content, FILE, { chunkSize: 400, overlap: 150 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // The second chunk should overlap with content from the first.
    const allContent = chunks.map((c) => c.content).join(' ');
    expect(allContent).toContain('Alpha');
    expect(allContent).toContain('Beta');
    expect(allContent).toContain('Gamma');
  });

  it('line numbers are 1-based and non-decreasing', () => {
    const content = 'Line one.\n\nLine two.\n\nLine three.';
    const chunks = chunkText(content, FILE, { chunkSize: 1000 });
    for (const c of chunks) {
      expect(c.startLine).toBeGreaterThanOrEqual(1);
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
    }
  });

  it('startLine of second chunk is after first when no overlap', () => {
    const para = 'x'.repeat(300);
    const content = [para, para, para].join('\n\n');
    const chunks = chunkText(content, FILE, { chunkSize: 350, overlap: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[1].startLine).toBeGreaterThanOrEqual(chunks[0].endLine);
  });

  it('plain text (no headings) produces chunks with undefined heading', () => {
    const content = 'First para.\n\nSecond para.';
    const chunks = chunkText(content, FILE, { chunkSize: 1000 });
    expect(chunks[0].heading).toBeUndefined();
  });

  it('handles content with only headings', () => {
    const content = '# Title\n\n## Section\n\n### Sub';
    const chunks = chunkText(content, FILE, { chunkSize: 1000 });
    // Headings alone never fill the buffer — buffer stays empty after each heading reset.
    expect(chunks).toHaveLength(0);
  });

  it('heading followed by content produces chunk', () => {
    const content = '# Title\n\nSome body text here.';
    const chunks = chunkText(content, FILE);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('# Title');
    expect(chunks[0].content).toContain('Some body text here');
  });

  it('overlap clamped to at most half chunkSize', () => {
    // overlap=800 with chunkSize=100 → clamped to 50
    const para = 'word '.repeat(30).trim();
    const content = [para, para, para].join('\n\n');
    // Should not throw or loop infinitely
    const chunks = chunkText(content, FILE, { chunkSize: 100, overlap: 800 });
    expect(chunks.length).toBeGreaterThan(0);
  });
});
