/**
 * Public data shapes for the workspace file index. `FileNode` is imported
 * across the retrieval/context layers, so it lives in a logic-free module
 * (re-exported from workspaceIndex.ts for the historical import surface).
 */

export interface FileNode {
  relativePath: string;
  sizeBytes: number;
  relevanceScore: number;
}

export interface RankedFile extends FileNode {
  /** Combined heuristic + semantic score for this query. */
  score: number;
}
