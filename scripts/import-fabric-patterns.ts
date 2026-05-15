#!/usr/bin/env npx tsx
/**
 * Import Fabric patterns as SideCar skills.
 *
 * Usage:
 *   npx tsx scripts/import-fabric-patterns.ts [options]
 *
 * Options:
 *   --patterns-dir <path>   Directory containing Fabric pattern subdirs
 *                           (default: /tmp/fabric/data/patterns)
 *   --output-dir <path>     Where to write skill .md files
 *                           (default: .sidecar/skills/fabric)
 *   --filter <name,...>     Comma-separated list of pattern names to import
 *                           (default: import all)
 *   --dry-run               Print what would be written without writing
 *
 * Each Fabric pattern lives at <patterns-dir>/<name>/system.md.
 * The script converts it to a SideCar skill with YAML frontmatter:
 *   ---
 *   name: <title-cased pattern name>
 *   description: <first meaningful sentence from the file>
 *   source: fabric/<pattern-name>
 *   ---
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_PATTERNS_DIR = '/tmp/fabric/data/patterns';
const DEFAULT_OUTPUT_DIR = 'skills/fabric';

function parseArgs(): {
  patternsDir: string;
  outputDir: string;
  filter: Set<string> | null;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let patternsDir = DEFAULT_PATTERNS_DIR;
  let outputDir = DEFAULT_OUTPUT_DIR;
  let filter: Set<string> | null = null;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--patterns-dir' && args[i + 1]) {
      patternsDir = args[++i];
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      outputDir = args[++i];
    } else if (args[i] === '--filter' && args[i + 1]) {
      filter = new Set(args[++i].split(',').map((s) => s.trim()));
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  return { patternsDir, outputDir, filter, dryRun };
}

function titleCase(name: string): string {
  return name
    .split(/[-_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function extractDescription(content: string): string {
  const lines = content.split('\n');

  // Try: "You are an X that/who <does something useful>" → keep the <does something useful> part.
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;
    const m = trimmed.match(/^You are (?:an? [\w\s,]+?)\s+(?:that|who|and you)\s+([^.!?]{20,180}[.!?])/i);
    if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1);
    break; // only check first prose block
  }

  // Try: find a # TASK or # GOAL section.
  let inTarget = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      inTarget = /^#+ ?(task|goal)\b/i.test(trimmed);
      continue;
    }
    if (inTarget && trimmed && !trimmed.startsWith('-') && !trimmed.startsWith('*')) {
      const clean = trimmed.replace(/\*\*/g, '');
      if (clean.length > 20 && clean.length < 180) {
        const sentence = clean.split(/(?<=[.!?])\s/)[0];
        return sentence;
      }
    }
  }

  return '';
}

function buildSkillContent(patternName: string, systemMd: string): string {
  const name = titleCase(patternName);
  const description = extractDescription(systemMd);

  const frontmatter = [
    '---',
    `name: ${name}`,
    description ? `description: ${description}` : '',
    `source: fabric/${patternName}`,
    '---',
  ]
    .filter(Boolean)
    .join('\n');

  return `${frontmatter}\n\n${systemMd.trim()}\n`;
}

function run(): void {
  const { patternsDir, outputDir, filter, dryRun } = parseArgs();

  if (!fs.existsSync(patternsDir)) {
    console.error(`Patterns directory not found: ${patternsDir}`);
    console.error('Clone the Fabric repo first: git clone --depth=1 https://github.com/danielmiessler/fabric.git /tmp/fabric');
    process.exit(1);
  }

  const patternNames = fs
    .readdirSync(patternsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => filter === null || filter.has(name))
    .sort();

  if (patternNames.length === 0) {
    console.error('No patterns found' + (filter ? ` matching filter: ${[...filter].join(', ')}` : ''));
    process.exit(1);
  }

  if (!dryRun) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let written = 0;
  let skipped = 0;

  for (const name of patternNames) {
    const systemMdPath = path.join(patternsDir, name, 'system.md');
    if (!fs.existsSync(systemMdPath)) {
      skipped++;
      continue;
    }

    const systemMd = fs.readFileSync(systemMdPath, 'utf8');
    const skillContent = buildSkillContent(name, systemMd);
    const outPath = path.join(outputDir, `${name}.md`);

    if (dryRun) {
      console.log(`\n── ${name} → ${outPath}`);
      console.log(skillContent.split('\n').slice(0, 8).join('\n'));
      console.log('...');
    } else {
      fs.writeFileSync(outPath, skillContent, 'utf8');
      console.log(`  ✓ ${name}`);
    }
    written++;
  }

  console.log(`\n${dryRun ? '[dry-run] ' : ''}${written} patterns written to ${outputDir}, ${skipped} skipped (no system.md)`);
}

run();
