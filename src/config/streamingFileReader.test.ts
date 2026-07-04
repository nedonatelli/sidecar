import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { workspace, Uri } from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { readFileStreaming, streamFile } from './streamingFileReader.js';

// workspace.fs (stat/readFile) is mocked to a size + content. The file:// summary
// branch uses real fs byte-offset reads, so that one case writes a real temp file.

function mockStat(size: number) {
  vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ size } as never);
}
function mockContent(content: string) {
  vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(content) as never);
}

let tmpCounter = 0;

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('readFileStreaming — small files (full read + limits)', () => {
  it('returns the whole file when it fits', async () => {
    mockStat(500);
    mockContent('line1\nline2\nline3');
    const r = await readFileStreaming(Uri.file('/x.txt'), { chunkSizeBytes: 1000 });
    expect(r.content).toBe('line1\nline2\nline3');
    expect(r.isComplete).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.totalBytes).toBe(500);
  });

  it('truncates by maxBytes and appends the truncation marker', async () => {
    mockStat(500);
    mockContent('X'.repeat(500));
    const r = await readFileStreaming(Uri.file('/x.txt'), { chunkSizeBytes: 1000, maxBytes: 10 });
    expect(r.truncated).toBe(true);
    expect(r.isComplete).toBe(false);
    expect(r.content).toBe('X'.repeat(10) + '\n... (truncated)');
  });

  it('truncates by maxLines', async () => {
    mockStat(50);
    mockContent('a\nb\nc\nd\ne');
    const r = await readFileStreaming(Uri.file('/x.txt'), { chunkSizeBytes: 1000, maxLines: 2 });
    expect(r.truncated).toBe(true);
    expect(r.content).toBe('a\nb\n... (truncated)');
  });
});

describe('readFileStreaming — large files', () => {
  it('summarizes a non-file:// URI via head + tail (full read fallback)', async () => {
    const lines = Array.from({ length: 8 }, (_, i) => `line${i + 1}`).join('\n');
    mockStat(50_000); // > chunkSize*2 → "large"
    mockContent(lines);
    const uri = Uri.parse('vscode-vfs://host/remote.txt');
    const r = await readFileStreaming(uri, { summaryMode: true, summaryHeadLines: 2, summaryTailLines: 1 });

    expect(r.truncated).toBe(true);
    expect(r.isComplete).toBe(false);
    expect(r.content).toContain('line1');
    expect(r.content).toContain('line8'); // tail
    expect(r.content).toContain('lines omitted');
  });

  it('summarizes a file:// URI via real byte-offset head/tail reads', async () => {
    const tmp = path.join(os.tmpdir(), `sidecar-sfr-${process.pid}-${tmpCounter++}.txt`);
    const lines = Array.from({ length: 200 }, (_, i) => `row-${i}`).join('\n');
    fs.writeFileSync(tmp, lines, 'utf-8');
    try {
      mockStat(fs.statSync(tmp).size);
      // small chunkSize so the ~1.4KB file counts as "large" and hits the summary path
      const r = await readFileStreaming(Uri.file(tmp), {
        chunkSizeBytes: 10,
        summaryMode: true,
        summaryHeadLines: 3,
        summaryTailLines: 2,
      });
      expect(r.content).toContain('row-0'); // head
      expect(r.content).toContain('row-199'); // tail
      expect(r.content).toContain('lines omitted');
      expect(r.truncated).toBe(true);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('falls back to a byte-limited read for a large-but-under-maxBytes file', async () => {
    mockStat(100); // > chunkSize*2 (20) but <= maxBytes (200) and not summaryMode
    mockContent('full body content');
    const r = await readFileStreaming(Uri.file('/x.txt'), { chunkSizeBytes: 10, maxBytes: 200 });
    expect(r.content).toBe('full body content');
    expect(r.isComplete).toBe(true);
    expect(r.truncated).toBe(false);
  });
});

describe('readFileStreaming / streamFile — errors + streaming', () => {
  it('wraps a stat failure in a descriptive error', async () => {
    vi.spyOn(workspace.fs, 'stat').mockRejectedValue(new Error('ENOENT'));
    await expect(readFileStreaming(Uri.file('/missing.txt'))).rejects.toThrow('Failed to read file /missing.txt');
  });

  it('streamFile yields the content in chunk-sized pieces', async () => {
    mockContent('abcdefgh');
    const chunks: string[] = [];
    for await (const c of streamFile(Uri.file('/x.txt'), 3)) chunks.push(c);
    expect(chunks).toEqual(['abc', 'def', 'gh']);
  });

  it('streamFile wraps a read failure in a descriptive error', async () => {
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValue(new Error('boom'));
    const iterate = async () => {
      for await (const _c of streamFile(Uri.file('/x.txt'))) void _c;
    };
    await expect(iterate()).rejects.toThrow('Failed to stream file /x.txt');
  });
});
