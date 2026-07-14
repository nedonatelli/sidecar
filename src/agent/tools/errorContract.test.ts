import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// The errors-as-success contract.
//
// A tool signals failure by THROWING. The executor turns a throw into
// `is_error: true`; a returned string is recorded as `is_error: false` — a
// SUCCESS — no matter what it says. This bit four separate times in the v0.119
// dogfood pass, and every time the damage was the same: the loop could not see
// the failure.
//
//   • validateFilePath rejections (absolute path, traversal) were RETURNED, so
//     rejected calls looked successful to bounce escalation and the gates.
//   • edit_file's search-not-found / ambiguous / identical failures were
//     RETURNED — ten corrupting "ok" edits in a row, no gate ever fired.
//   • edit_file's shape validation ("requires both 'search' and 'replace'") was
//     RETURNED: the JSDoc task reported success while writing nothing at all.
//   • write_file's clobber and unverified-rewrite refusals were RETURNED, so a
//     refused write read as a completed one.
//
// A unit test per site would have missed each new one. This is a STATIC check
// over the whole tool surface instead: no executor may `return` a string that
// begins with an error marker. It is deliberately a source scan — it cannot be
// satisfied by a mock, and it fails the moment someone adds a new one.
// ---------------------------------------------------------------------------

const TOOLS_DIR = path.join(__dirname);

/** Lines that RETURN an error-shaped string. Matches both `return '…'` and multiline `return (\n '…'`. */
const RETURNED_ERROR = /return\s*\(?\s*[`'"]\s*(?:\$\{unreadPrefix\})?Error[:\s]/;

/**
 * Phrases that mean "the operation did not happen" even without an `Error:`
 * prefix. A refusal is a failure regardless of how politely it is worded.
 */
const RETURNED_REFUSAL = /return\s*\(?\s*[`'"][^`'"]*\b(was NOT applied|is NOT permitted|cannot be edited)\b/i;

/**
 * A catch block that swallows a thrown failure into a returned string:
 *   } catch (err) { return `git commit failed: ${formatToolError(err)}`; }
 * A FAILED COMMIT then reads as a success. Same class, one level up.
 */
const RETURNED_CATCH = /return\s*`[^`]*\bfailed:\s*\$\{(?:formatToolError|err)/;

/**
 * KNOWN DEBT — files that still report failures as successes.
 *
 * The contract is enforced for everything NOT on this list, so no NEW violation
 * can land. These are the pre-existing ones, ranked by blast radius: a returned
 * failure is worst on tools that MUTATE state or produce VERIFICATION evidence
 * (the loop believes work happened / tests ran), and least harmful on read-only
 * query tools, where the model simply sees the message and retries.
 *
 * Cleared so far: fs.ts, git.ts, shell.ts, shared.ts (path validation).
 * Next by risk: database.ts (db_execute / db_migrate_up mutate), docTests.ts and
 * mutationTest.ts / propertyTest.ts (verification evidence), latex.ts, plan.ts.
 */
const KNOWN_DEBT = new Set([
  'citation.ts',
  'codeGraphQuery.ts',
  'database.ts',
  'docTests.ts',
  'history.ts',
  'impact.ts',
  'kickstand.ts',
  'knowledge.ts',
  'latex.ts',
  'mutationTest.ts',
  'notebook.ts',
  'pdf.ts',
  'plan.ts',
  'profiling.ts',
  'projectKnowledge.ts',
  'propertyTest.ts',
  'research.ts',
  'search.ts',
  'settings.ts',
  'vision.ts',
  'visionHelpers.ts',
  'vizSpec.ts',
  'zotero.ts',
]);

function sourceFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(dir, f));
}

describe('tool error contract: failures throw, they are never returned', () => {
  it('no tool executor returns an error-shaped string', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(TOOLS_DIR)) {
      if (KNOWN_DEBT.has(path.basename(file))) continue;
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
        if (RETURNED_ERROR.test(line) || RETURNED_REFUSAL.test(line) || RETURNED_CATCH.test(line)) {
          offenders.push(`${path.basename(file)}:${i + 1}  ${line.trim().slice(0, 100)}`);
        }
      });
    }

    // Any hit here is a tool that reports a failure as `is_error: false`. The
    // loop cannot see it: bounce escalation never counts it, cycle detection
    // never trips on it, and the completion gate treats it as work done.
    expect(
      offenders,
      `Return an Error string → the executor records it as SUCCESS. Throw instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the debt list carries no stale entries — a cleared file must be removed from it', () => {
    const stillDirty: string[] = [];
    for (const file of sourceFiles(TOOLS_DIR)) {
      const name = path.basename(file);
      if (!KNOWN_DEBT.has(name)) continue;
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      const hasViolation = lines.some(
        (l) =>
          !l.trim().startsWith('//') &&
          !l.trim().startsWith('*') &&
          (RETURNED_ERROR.test(l) || RETURNED_REFUSAL.test(l) || RETURNED_CATCH.test(l)),
      );
      if (hasViolation) stillDirty.push(name);
    }
    const cleared = [...KNOWN_DEBT].filter((n) => !stillDirty.includes(n));
    expect(cleared, `these files no longer violate the contract — remove them from KNOWN_DEBT`).toEqual([]);
  });

  it('the scan actually detects a violation (guards the guard)', () => {
    // A regex that matches nothing would pass the test above forever.
    expect(RETURNED_ERROR.test(`    return \`Error: something failed\`;`)).toBe(true);
    expect(RETURNED_ERROR.test(`    return \`\${unreadPrefix}Error: nope\`;`)).toBe(true);
    expect(RETURNED_ERROR.test(`      return (\n        \`Error: multiline\` +`)).toBe(true);
    expect(RETURNED_REFUSAL.test('    return `write_file to x was NOT applied. …`;')).toBe(true);

    // …and does not fire on legitimate successes or on throws.
    expect(RETURNED_ERROR.test('    return `File edited: ${filePath}`;')).toBe(false);
    expect(RETURNED_ERROR.test('    throw new Error(`Error: this is correct`);')).toBe(false);
    expect(RETURNED_REFUSAL.test('    return `File written: ${filePath}`;')).toBe(false);
    expect(RETURNED_CATCH.test('    return `git commit failed: ${formatToolError(err)}`;')).toBe(true);
    expect(RETURNED_CATCH.test('    throw new Error(`git commit failed: ${formatToolError(err)}`);')).toBe(false);
  });
});
