/**
 * DESIGN.md loader — parse the Google Labs design system format and render
 * it for injection into the agent's system prompt.
 *
 * DESIGN.md format: optional YAML front matter (design tokens) + markdown body
 * (rationale sections). Spec: https://github.com/google-labs-code/design.md
 *
 * Injection strategy:
 *   - Tokens block (compact YAML) → always injected when file is present
 *   - Prose body → only when the active file is a UI file (*.css, *.tsx, etc.)
 */

const UI_EXTENSIONS = new Set([
  '.css',
  '.scss',
  '.less',
  '.sass',
  '.tsx',
  '.jsx',
  '.svelte',
  '.vue',
  '.astro',
  '.html',
  '.htm',
]);

/** Returns true when the active file is a UI/component file. */
export function isUiFile(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return UI_EXTENSIONS.has(ext);
}

export interface DesignMdParsed {
  /** Raw YAML front-matter content (between the --- fences), or null. */
  readonly frontmatter: string | null;
  /** Markdown body after the front-matter block. */
  readonly body: string;
}

/** Split DESIGN.md into its front-matter tokens and prose body. */
export function parseDesignMd(content: string): DesignMdParsed {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: null, body: content.trim() };
  }

  const fenceEnd = trimmed.indexOf('\n---', 3);
  if (fenceEnd === -1) {
    return { frontmatter: null, body: content.trim() };
  }

  const frontmatter = trimmed.slice(3, fenceEnd).trim();
  const body = trimmed.slice(fenceEnd + 4).trim();
  return { frontmatter: frontmatter || null, body };
}

export interface RenderDesignMdOptions {
  readonly activeFilePath?: string;
  readonly maxChars: number;
}

/**
 * Render DESIGN.md content for system prompt injection.
 *
 * Returns an empty string when the file has no usable content.
 * The tokens block is always included (low cost, ~150–300 chars).
 * The prose body is only appended when the active file is a UI file.
 */
export function renderDesignMdContext(content: string, opts: RenderDesignMdOptions): string {
  const { frontmatter, body } = parseDesignMd(content);
  const uiActive = isUiFile(opts.activeFilePath);

  const parts: string[] = [];

  if (frontmatter) {
    parts.push(`<design_tokens source="DESIGN.md">\n${frontmatter}\n</design_tokens>`);
  }

  if (uiActive && body) {
    parts.push(body);
  } else if (!frontmatter && body) {
    // No tokens but has body-only content (uncommon but valid).
    parts.push(body);
  }

  if (parts.length === 0) return '';

  const joined = parts.join('\n\n');
  if (joined.length <= opts.maxChars) return joined;
  return joined.slice(0, Math.max(0, opts.maxChars - 40)) + '\n... (DESIGN.md truncated)';
}
