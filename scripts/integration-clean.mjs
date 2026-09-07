#!/usr/bin/env node
// Clean-up steps for `npm run test:integration`, in portable form.
//
// The script used to inline them as shell:
//
//   rm -rf out/src/test/integration && ... && { find src -name '*.js' \
//     -not -path 'src/test/*' -delete 2>/dev/null || true; } && vscode-test
//
// npm runs scripts through cmd.exe on Windows, where `rm`, `find` and
// `/dev/null` do not exist and `{ ...; }` is not a group -- so the whole
// integration suite was unrunnable there. Same class of bug as the `mkdir -p`
// in copy-grammars, which silently skipped every tree-sitter suite.
//
// Two modes because the two steps happen at different points in the pipeline:
//   pre   remove the previous integration build output
//   post  delete stray compiled .js next to their sources, EXCEPT under
//         src/test, whose compiled output is what vscode-test runs
import { rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];

if (mode === 'pre') {
  rmSync(join(root, 'out', 'src', 'test', 'integration'), { recursive: true, force: true });
  console.log('integration-clean: removed out/src/test/integration');
} else if (mode === 'post') {
  const keep = join(root, 'src', 'test') + sep;
  let removed = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(p);
      } else if (entry.name.endsWith('.js') && !p.startsWith(keep)) {
        // Best-effort, matching the `|| true` the shell version ended with:
        // a stray file that cannot be removed must not fail the test run.
        try {
          rmSync(p);
          removed++;
        } catch {
          /* leave it */
        }
      }
    }
  };
  try {
    statSync(join(root, 'src'));
    walk(join(root, 'src'));
  } catch {
    /* no src, nothing to prune */
  }
  console.log(`integration-clean: pruned ${removed} stray .js file(s) outside src/test`);
} else {
  console.error("integration-clean: expected 'pre' or 'post'");
  process.exit(1);
}
