/**
 * Structured context rules implementation for SideCar
 *
 * This module handles reading and applying .sidecarrules files that define
 * typed constraints for context building, similar to .cursorrules or .clinerules.
 */

import { workspace, Uri } from 'vscode';
import { getConfig } from './settings.js';

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
    const rulesContent = Buffer.from(rulesBytes).toString('utf-8');

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
 * This is a placeholder implementation that would be extended based on rules
 */
export function applyContextRules(files: string[], rules: StructuredContextRules): string[] {
  if (!rules.rules || rules.rules.length === 0) {
    return files;
  }

  // For now, we'll just return all files - the actual implementation
  // would filter based on the rules
  const result = [...files];

  // Example rule application logic (to be expanded):
  // - "ban: any-type" would exclude files with any-type usage
  // - "prefer: functional-components" would boost relevance of functional components
  // - "require: test-file" would ensure test files are included when relevant

  return result;
}

/**
 * Get context rules that should be applied to the current workspace
 */
export async function getCurrentContextRules(): Promise<StructuredContextRules> {
  const config = getConfig();

  // If RAG is disabled, don't load rules
  if (!config.enableDocumentationRAG) {
    return { rules: [] };
  }

  return await readStructuredContextRules();
}
