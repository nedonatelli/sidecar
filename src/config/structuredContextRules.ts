/**
 * Structured context rules implementation for SideCar
 *
 * This module handles reading and applying .sidecarrules files that define
 * typed constraints for context building, similar to .cursorrules or .clinerules.
 */

import { workspace, Uri } from 'vscode';

export interface ContextRule {
  /** Rule type - e.g., "prefer", "ban", "require" */
  type: 'prefer' | 'ban' | 'require';
  /** The constraint to apply - e.g., "functional-components", "any-type" */
  constraint: string;
  /** Optional description of the rule */
  description?: string;
}

export interface StructuredContextRules {
  /** List of rules to apply to context building */
  rules: ContextRule[];
}

/**
 * Read structured context rules from .sidecarrules file in workspace root
 * Returns empty rules if file doesn't exist or is invalid
 */
export async function readStructuredContextRules(): Promise<StructuredContextRules> {
  const folders = workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { rules: [] };
  }

  const rootUri = folders[0].uri;
  const rulesUri = Uri.joinPath(rootUri, '.sidecarrules');

  try {
    const rulesBytes = await workspace.fs.readFile(rulesUri);
    const rulesContent = new TextDecoder().decode(rulesBytes);

    // Parse the rules file (simple JSON format for now)
    const parsed = JSON.parse(rulesContent);

    // Validate structure
    if (!Array.isArray(parsed.rules)) {
      console.warn('[SideCar] Invalid .sidecarrules format: rules must be an array');
      return { rules: [] };
    }

    // Validate individual rules
    const validRules: ContextRule[] = [];
    for (const rule of parsed.rules) {
      if (rule.type && (rule.type === 'prefer' || rule.type === 'ban' || rule.type === 'require') && rule.constraint) {
        validRules.push({
          type: rule.type,
          constraint: rule.constraint,
          description: rule.description,
        });
      }
    }

    return { rules: validRules };
  } catch {
    // File doesn't exist or is invalid - return empty rules
    return { rules: [] };
  }
}

/**
 * Apply context rules to determine which files should be included in context
 * This function filters and scores files based on the defined rules
 */
export function applyContextRules(files: string[], rules: StructuredContextRules): string[] {
  if (!rules.rules || rules.rules.length === 0) {
    return files;
  }

  // Create a map to track scores for each file
  const fileScores = new Map<string, number>();

  // Initialize all files with base score of 1
  for (const file of files) {
    fileScores.set(file, 1);
  }

  // Apply rules based on constraint types
  for (const rule of rules.rules) {
    if (rule.type === 'prefer') {
      // Boost score for files matching the constraint
      if (rule.constraint === 'functional-components') {
        // For now, we'll just boost files that look like functional components
        // In a real implementation, this would analyze file content
        for (const file of files) {
          if (file.endsWith('.tsx') || file.endsWith('.ts')) {
            const score = fileScores.get(file) || 1;
            fileScores.set(file, score * 1.5); // Boost by 50%
          }
        }
      }
    } else if (rule.type === 'ban') {
      // Remove files matching the constraint
      if (rule.constraint === 'any-type') {
        // In a real implementation, this would check for any-type usage in files
        // For now, we'll just filter out files that contain "any" in their name
        // This is a placeholder - real implementation would analyze content
        const filteredFiles = Array.from(fileScores.keys()).filter((file) => !file.includes('any'));
        const newScores = new Map<string, number>();
        for (const file of filteredFiles) {
          newScores.set(file, fileScores.get(file) || 1);
        }
        fileScores.clear();
        for (const [file, score] of newScores.entries()) {
          fileScores.set(file, score);
        }
      }
    } else if (rule.type === 'require') {
      // Ensure files matching the constraint are included when relevant
      if (rule.constraint === 'test-file') {
        // For now, we'll ensure test files are included
        // In a real implementation, this would check if test files are relevant to the query
        // and include them if they are
        for (const file of files) {
          if (file.includes('.test.') || file.includes('-test.') || file.endsWith('.spec.ts')) {
            const score = fileScores.get(file) || 1;
            fileScores.set(file, Math.max(score, 2)); // Ensure test files get higher score
          }
        }
      }
    }
  }

  // Sort files by score (descending) and return top files
  const sortedFiles = Array.from(fileScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map((entry) => entry[0]);

  return sortedFiles;
}

/**
 * Get context rules that should be applied to the current workspace
 */
export async function getCurrentContextRules(): Promise<StructuredContextRules> {
  // Load rules regardless of RAG setting - context rules are independent of documentation RAG
  return await readStructuredContextRules();
}
