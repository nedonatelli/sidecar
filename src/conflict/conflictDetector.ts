import * as fs from 'fs';
import * as path from 'path';

export interface ConflictBlock {
  readonly index: number;
  readonly ours: string;
  readonly base: string | null;
  readonly theirs: string;
  readonly oursLabel: string;
  readonly theirsLabel: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface ConflictFile {
  readonly fsPath: string;
  readonly relativePath: string;
  readonly blocks: readonly ConflictBlock[];
  readonly originalContent: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.sidecar']);

/**
 * Parse a file's text into ConflictBlocks using a line-by-line state machine.
 * Supports both standard 2-way format and diff3 format (with ||||||| base section).
 * Returns an empty array when no conflict markers are found.
 */
export function parseConflictBlocks(content: string): ConflictBlock[] {
  type State = 'normal' | 'ours' | 'base' | 'theirs';

  const blocks: ConflictBlock[] = [];
  const lines = content.split('\n');

  let state: State = 'normal';
  let blockIndex = 0;
  let startOffset = 0;
  let currentOffset = 0;
  let oursLabel = '';
  let theirsLabel = '';
  let oursLines: string[] = [];
  let baseLines: string[] = [];
  let theirsLines: string[] = [];
  let inBase = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLen = line.length + 1; // +1 for the \n that was removed by split

    if (state === 'normal') {
      if (line.startsWith('<<<<<<<')) {
        state = 'ours';
        startOffset = currentOffset;
        oursLabel = line.slice(8).trim();
        oursLines = [];
        baseLines = [];
        theirsLines = [];
        inBase = false;
      }
    } else if (state === 'ours') {
      if (line.startsWith('|||||||')) {
        state = 'base';
        inBase = true;
      } else if (line.startsWith('=======')) {
        state = 'theirs';
      } else {
        oursLines.push(line);
      }
    } else if (state === 'base') {
      if (line.startsWith('=======')) {
        state = 'theirs';
      } else {
        baseLines.push(line);
      }
    } else if (state === 'theirs') {
      if (line.startsWith('>>>>>>>')) {
        theirsLabel = line.slice(8).trim();
        const endOffset = currentOffset + lineLen;
        blocks.push({
          index: blockIndex++,
          ours: oursLines.join('\n'),
          base: inBase ? baseLines.join('\n') : null,
          theirs: theirsLines.join('\n'),
          oursLabel,
          theirsLabel,
          startOffset,
          endOffset,
        });
        state = 'normal';
      } else {
        theirsLines.push(line);
      }
    }

    currentOffset += lineLen;
  }

  return blocks;
}

/**
 * Recursively scan `dir` for files containing conflict markers.
 * Skips binary files, gitignored-style directories, and files > maxFileBytes.
 */
async function scanDir(
  dir: string,
  workspaceRoot: string,
  exclude: string[],
  results: ConflictFile[],
  maxFiles: number,
  maxFileBytes: number,
): Promise<void> {
  if (results.length >= maxFiles) return;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxFiles) return;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || exclude.includes(entry.name)) continue;
      await scanDir(fullPath, workspaceRoot, exclude, results, maxFiles, maxFileBytes);
    } else if (entry.isFile()) {
      // Quick size check before reading
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(fullPath);
      } catch {
        continue;
      }
      if (stat.size > maxFileBytes) continue;

      let content: string;
      try {
        const buf = await fs.promises.readFile(fullPath);
        // Skip binary files (check for null bytes in first 8KB)
        const probe = buf.slice(0, 8192);
        if (probe.includes(0)) continue;
        content = buf.toString('utf8');
      } catch {
        continue;
      }

      if (!content.includes('<<<<<<<')) continue;

      const blocks = parseConflictBlocks(content);
      if (blocks.length === 0) continue;

      results.push({
        fsPath: fullPath,
        relativePath: path.relative(workspaceRoot, fullPath),
        blocks,
        originalContent: content,
      });
    }
  }
}

/**
 * Scan the workspace for files containing conflict markers.
 */
export async function findConflictedFiles(
  workspaceRoot: string,
  options: { exclude?: string[]; maxFiles?: number } = {},
): Promise<ConflictFile[]> {
  const results: ConflictFile[] = [];
  await scanDir(
    workspaceRoot,
    workspaceRoot,
    options.exclude ?? [],
    results,
    options.maxFiles ?? 500,
    1_048_576, // 1 MB per file
  );
  return results;
}
