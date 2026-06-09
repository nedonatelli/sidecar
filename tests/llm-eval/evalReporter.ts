import * as fs from 'fs';
import * as path from 'path';

/**
 * Writes eval failure details to a markdown file so Claude Code can read
 * them directly without copy-paste. Each eval runner appends its section.
 *
 * File path: eval-failures.md at the project root (gitignored).
 * Cleared on the first call per process, then appended.
 */

const REPORT_PATH =
  process.env.SIDECAR_EVAL_REPORT ?? path.join(process.cwd(), 'eval-failures.md');

let cleared = false;

function ensureCleared(): void {
  if (!cleared) {
    fs.writeFileSync(REPORT_PATH, '', 'utf8');
    cleared = true;
  }
}

export function appendFailure(suiteName: string, caseId: string, detail: string): void {
  ensureCleared();
  const block = `### ${suiteName} — ${caseId}\n\n${detail}\n\n---\n`;
  fs.appendFileSync(REPORT_PATH, block, 'utf8');
}

export function writeHeader(suiteName: string): void {
  ensureCleared();
  fs.appendFileSync(REPORT_PATH, `## ${suiteName}\n\n`, 'utf8');
}

export function writeSummary(passed: number, total: number): void {
  ensureCleared();
  const emoji = passed === total ? '✅' : '❌';
  fs.appendFileSync(REPORT_PATH, `**${emoji} ${passed} / ${total} passed**\n\n`, 'utf8');
}
