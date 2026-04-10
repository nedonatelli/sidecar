import * as path from 'path';
import * as os from 'os';
import { workspace, Uri } from 'vscode';

/**
 * A loaded skill — a markdown prompt fragment that can be injected into
 * the system prompt when triggered by a slash command or keyword match.
 *
 * Compatible with Claude Code skill format:
 *   ~/.claude/commands/*.md  (user-level)
 *   .claude/commands/*.md    (project-level)
 *   .sidecar/skills/*.md     (SideCar native)
 */
export interface Skill {
  /** Skill identifier (filename without extension) */
  id: string;
  /** Human-readable name from frontmatter, or id if not set */
  name: string;
  /** Short description from frontmatter */
  description: string;
  /** The full prompt content (everything after frontmatter) */
  content: string;
  /** Where this skill was loaded from */
  source: 'builtin' | 'user' | 'project-claude' | 'project-sidecar';
  /** Original file path */
  filePath: string;
}

/**
 * Parse a skill markdown file. Extracts YAML frontmatter (name, description)
 * and the body content. Ignores Claude-specific frontmatter fields like
 * allowed-tools and disable-model-invocation.
 */
function parseSkillFile(filePath: string, raw: string, source: Skill['source']): Skill {
  const id = path.basename(filePath, '.md');
  let name = id;
  let description = '';
  let content = raw;

  // Parse YAML frontmatter
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (fmMatch) {
    const frontmatter = fmMatch[1];
    content = fmMatch[2].trim();

    // Extract known fields with simple line parsing (avoids YAML dependency)
    for (const line of frontmatter.split('\n')) {
      const kvMatch = line.match(/^(\w[\w-]*):\s*(.+)$/);
      if (!kvMatch) continue;
      const [, key, value] = kvMatch;
      const cleaned = value.replace(/^["']|["']$/g, '').trim();
      if (key === 'name') name = cleaned;
      else if (key === 'description') description = cleaned;
      // Silently ignore: allowed-tools, disable-model-invocation, etc.
    }
  }

  return { id, name, description, content, source, filePath };
}

/**
 * Scan a directory for .md skill files and parse them.
 * Returns an empty array if the directory doesn't exist.
 */
async function loadSkillsFromDir(dirPath: string, source: Skill['source']): Promise<Skill[]> {
  const skills: Skill[] = [];
  const dirUri = Uri.file(dirPath);

  try {
    const entries = await workspace.fs.readDirectory(dirUri);
    for (const [fileName, fileType] of entries) {
      if (fileType !== 1 || !fileName.endsWith('.md')) continue;
      try {
        const fileUri = Uri.joinPath(dirUri, fileName);
        const bytes = await workspace.fs.readFile(fileUri);
        const raw = Buffer.from(bytes).toString('utf-8');
        skills.push(parseSkillFile(path.join(dirPath, fileName), raw, source));
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory doesn't exist — that's fine
  }

  return skills;
}

/**
 * Manages loading and matching of skills from built-in defaults,
 * Claude Code directories, and SideCar skill directories.
 *
 * Scan order (later sources override earlier on name conflict):
 *   0. <extension>/skills/           (built-in default skills)
 *   1. ~/.claude/commands/           (user-level Claude Code skills)
 *   2. <workspace>/.claude/commands/ (project-level Claude Code skills)
 *   3. <workspace>/.sidecar/skills/  (SideCar native skills)
 */
export class SkillLoader {
  private skills = new Map<string, Skill>();
  private initialized = false;
  private builtinSkillsPath: string | null = null;

  /** Set the path to built-in skills bundled with the extension. */
  setBuiltinPath(skillsPath: string): void {
    this.builtinSkillsPath = skillsPath;
  }

  /**
   * Scan all skill directories and load skills into memory.
   * Call once during extension activation or on first use.
   */
  async initialize(): Promise<void> {
    this.skills.clear();

    const home = os.homedir();
    const root = workspace.workspaceFolders?.[0]?.uri.fsPath;

    // 0. Built-in default skills (lowest priority — user/project can override)
    if (this.builtinSkillsPath) {
      const builtinSkills = await loadSkillsFromDir(this.builtinSkillsPath, 'builtin');
      for (const s of builtinSkills) this.skills.set(s.id, s);
    }

    // 1. User-level Claude Code skills
    const userSkills = await loadSkillsFromDir(path.join(home, '.claude', 'commands'), 'user');
    for (const s of userSkills) this.skills.set(s.id, s);

    // 2. Project-level Claude Code skills
    if (root) {
      const projectClaude = await loadSkillsFromDir(path.join(root, '.claude', 'commands'), 'project-claude');
      for (const s of projectClaude) this.skills.set(s.id, s);
    }

    // 3. SideCar native skills
    if (root) {
      const sidecarSkills = await loadSkillsFromDir(path.join(root, '.sidecar', 'skills'), 'project-sidecar');
      for (const s of sidecarSkills) this.skills.set(s.id, s);
    }

    this.initialized = true;
    const count = this.skills.size;
    if (count > 0) {
      console.log(
        `[SideCar] Loaded ${count} skills from ${userSkills.length} user + ${root ? 'project' : '0 project'} directories`,
      );
    }
  }

  /** Get a skill by exact id (filename without .md). */
  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  /** Get all loaded skills. */
  getAll(): Skill[] {
    return [...this.skills.values()];
  }

  /** Number of loaded skills. */
  get count(): number {
    return this.skills.size;
  }

  /** Whether skills have been loaded. */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Match a user message against skills. Checks for:
   *   1. Explicit slash command: /skill-name or /skill:skill-name
   *   2. Keyword match against skill descriptions
   *
   * Returns the best matching skill, or null if none found.
   */
  match(userMessage: string): Skill | null {
    if (!this.initialized || this.skills.size === 0) return null;

    // 1. Explicit slash command: /skill-name or /skill:skill-name
    const slashMatch = userMessage.match(/^\/(?:skill:)?([a-zA-Z][\w-]*)/);
    if (slashMatch) {
      const id = slashMatch[1];
      const skill = this.skills.get(id);
      if (skill) return skill;
    }

    // 2. Keyword match against skill names and descriptions
    const lower = userMessage.toLowerCase();
    let bestSkill: Skill | null = null;
    let bestScore = 0;

    for (const skill of this.skills.values()) {
      let score = 0;
      const nameWords = skill.name.toLowerCase().split(/[\s_-]+/);
      const descWords = skill.description.toLowerCase().split(/\s+/);

      // Exact name match in message
      if (lower.includes(skill.name.toLowerCase())) {
        score += 3;
      }

      // Name word matches
      for (const word of nameWords) {
        if (word.length > 2 && lower.includes(word)) score += 1;
      }

      // Description keyword matches
      for (const word of descWords) {
        if (word.length > 3 && lower.includes(word)) score += 0.5;
      }

      if (score > bestScore) {
        bestScore = score;
        bestSkill = skill;
      }
    }

    // Only return if we have a reasonable match (at least 2 keyword hits)
    return bestScore >= 2 ? bestSkill : null;
  }

  /**
   * Get a formatted list of available skills for autocomplete or /skills command.
   */
  listFormatted(): string {
    if (this.skills.size === 0) return 'No skills loaded.';

    const lines: string[] = [];
    for (const skill of this.skills.values()) {
      const desc = skill.description ? ` — ${skill.description}` : '';
      const src = skill.source === 'user' ? '' : ` [${skill.source}]`;
      lines.push(`  /${skill.id}${desc}${src}`);
    }
    return `**Available skills (${this.skills.size}):**\n${lines.join('\n')}`;
  }
}
