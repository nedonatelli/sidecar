// The text transforms a version bump applies, as pure functions on strings.
//
// bump-version.sh did these with `sed -i ''` — the macOS form, which GNU sed
// rejects — and two inline python3 programs. It could not run on a Windows
// workstation (or a Linux one), so v0.124.0 was bumped by hand against the
// same files. Pure functions here, IO in scripts/bump-version.mjs, and a test
// per transform, so the next bump is one command on every platform and the
// transforms cannot silently stop matching (the README pattern once required a
// literal '+' and never matched; nothing noticed).

/** The three legal next versions after `latestTag` (vX.Y.Z), or null when untagged. */
export function validNextVersions(latestTag) {
  if (!latestTag) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(latestTag);
  if (!m) return null;
  const [major, minor, patch] = m.slice(1).map(Number);
  return [`${major}.${minor}.${patch + 1}`, `${major}.${minor + 1}.0`, `${major + 1}.0.0`];
}

/** Pick the highest vX.Y.Z tag from `git tag` output. */
export function latestReleaseTag(tagList) {
  const tags = tagList
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  tags.sort((a, b) => {
    const pa = a.slice(1).split('.').map(Number);
    const pb = b.slice(1).split('.').map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  });
  return tags.at(-1) ?? null;
}

/** docs/index.html: stat strip numbers, ticker, and the exact hero version string. */
export function bumpLandingPage(html, { oldVersion, newVersion, tests, tools }) {
  let out = html;
  if (tests !== undefined) {
    out = out.replace(
      /(<span class="stat-num">)\d+(<\/span>\s*<span class="stat-label">tests passing)/,
      `$1${tests}$2`,
    );
  }
  out = out.replace(/(<span class="stat-num">)\d+(<\/span>\s*<span class="stat-label">built-in tools)/, `$1${tools}$2`);
  out = out.replace(/\d+ Built-in Tools/g, `${tools} Built-in Tools`);
  // Only the exact current-version string, so older "new in vX.Y" badges stay.
  out = out.split(`v${oldVersion}`).join(`v${newVersion}`);
  return out;
}

/** docs/agent-mode.md */
export function bumpAgentModeDoc(md, { tools }) {
  return md.replace(/SideCar has \d+ built-in tools/, `SideCar has ${tools} built-in tools`);
}

/** docs/troubleshooting.md */
export function bumpTroubleshootingDoc(md, { tools }) {
  return md.replace(/\d+ tool definitions add/, `~${tools} tool definitions add`);
}

/** README.md — the bare-number form ("87 built-in tools"); "80+" prose is left alone. */
export function bumpReadme(md, { tools }) {
  return md.replace(/\b\d\d+ built-in tools/g, `${tools} built-in tools`);
}

/** SECURITY.md supported-version table. Rows are padded to the table width; keep it. */
export function bumpSecurityTable(md, { newVersion }) {
  const minor = newVersion.split('.').slice(0, 2).join('.');
  return md
    .replace(/\| (\d+\.\d+)\.x \(current\)(\s*)\|/, (_m, _v, pad) => `| ${minor}.x (current)${pad}|`)
    .replace(/\| < (\d+\.\d+)(\s*)\|/, (_m, _v, pad) => `| < ${minor}${pad}|`);
}

/**
 * CHANGELOG.md. If an `## [Unreleased]` section has content, that content
 * BECOMES the new version's body (the header is inserted right after the
 * Unreleased header, and Unreleased is left empty); otherwise the new section
 * is inserted before `## [oldVersion]`. The optional summary goes in first;
 * the Stats block goes last.
 */
export function bumpChangelog(md, { oldVersion, newVersion, today, summary, tests, testFiles, tools, skills }) {
  const header = `## [${newVersion}] - ${today}\n`;
  const added = summary ? `\n### Added\n- ${summary}\n` : '';
  const stats = `\n### Stats\n- ${tests} total tests (${testFiles} test files)\n- ${tools} built-in tools, ${skills} skills\n`;
  const unreleased = md.indexOf('## [Unreleased]\n');
  const oldIdx = md.indexOf(`## [${oldVersion}]`);
  const nextSection = (from) => {
    const i = md.indexOf('\n## [', from);
    return i === -1 ? md.length : i + 1;
  };
  if (unreleased !== -1) {
    const bodyStart = unreleased + '## [Unreleased]\n'.length;
    const bodyEnd = nextSection(bodyStart);
    const body = md.slice(bodyStart, bodyEnd).replace(/^\n+/, '').replace(/\n+$/, '\n');
    const hasBody = body.trim().length > 0;
    return (
      md.slice(0, bodyStart) + '\n' + header + added + (hasBody ? '\n' + body : '') + stats + '\n' + md.slice(bodyEnd)
    );
  }
  const at = oldIdx === -1 ? md.indexOf('\n\n') + 2 : oldIdx;
  return md.slice(0, at) + header + added + stats + '\n' + md.slice(at);
}
