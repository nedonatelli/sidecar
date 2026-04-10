---
name: Create Skill
description: Create a new SideCar skill file with proper frontmatter, structure, and best practices
---

# Create a New SideCar Skill

The user wants to create a new skill. Guide them through the process and generate the skill file.

## Skill File Format

Skills are Markdown files with YAML frontmatter. They live in one of these directories:
- `~/.claude/commands/` — personal skills (available in all projects)
- `<workspace>/.claude/commands/` — project-specific skills (shared via git)
- `<workspace>/.sidecar/skills/` — SideCar native project skills

## Required Structure

```markdown
---
name: Human-Friendly Name (max 64 chars)
description: When and how this skill should be used (max 200 chars)
---

# Skill Title

Instructions for the AI agent when this skill is invoked.
```

## Writing Effective Skills

1. **Focus on one task** — create separate skills for different workflows
2. **Be specific in the description** — SideCar uses the description to match skills to user queries
3. **Include context** — explain what files, patterns, or conventions to follow
4. **Add examples** — show sample inputs and expected outputs
5. **Use imperative instructions** — tell the agent what to DO, not what it IS

## Steps

1. Ask the user what the skill should do
2. Ask where it should be saved (personal `~/.claude/commands/` or project `.sidecar/skills/`)
3. Generate the skill file with:
   - A clear, concise `name` (max 64 chars)
   - A `description` that explains when to trigger it (max 200 chars)
   - Structured markdown body with step-by-step instructions
4. Write the file using `write_file`
5. Confirm the skill was created and explain how to use it (`/skill-id` in chat)

## Naming Convention

The filename (without `.md`) becomes the slash command. Use kebab-case:
- `fix-tests.md` → `/fix-tests`
- `add-component.md` → `/add-component`
- `review-pr.md` → `/review-pr`
