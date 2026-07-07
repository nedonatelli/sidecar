#!/usr/bin/env bash
#
# bump-version.sh — Bump SideCar version and update all stats across the codebase.
#
# Usage:
#   ./scripts/bump-version.sh 0.39.0 "Brief summary of what changed"
#
# What it does:
#   1. Runs tests and collects pass counts
#   2. Counts tools and skills from source
#   3. Updates: package.json, CHANGELOG.md, ROADMAP.md, README.md,
#      docs/index.html, docs/agent-mode.md, docs/troubleshooting.md
#   4. Prints a summary of changes for review before committing
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- Args ---
NEW_VERSION="${1:-}"
SUMMARY="${2:-}"

if [[ -z "$NEW_VERSION" ]]; then
  echo "Usage: $0 <version> [summary]"
  echo "Example: $0 0.39.0 \"ask_user tool, security hardening, perf optimizations\""
  exit 1
fi

OLD_VERSION=$(node -p "require('./package.json').version")
TODAY=$(date +%Y-%m-%d)

# --- Validate version is a legal next step from the latest git tag ---
LATEST_TAG=$(git tag | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
if [[ -n "$LATEST_TAG" ]]; then
  TAG_VER="${LATEST_TAG#v}"
  IFS='.' read -r TAG_MAJOR TAG_MINOR TAG_PATCH <<< "$TAG_VER"
  IFS='.' read -r NEW_MAJOR NEW_MINOR NEW_PATCH <<< "$NEW_VERSION"

  VALID_NEXT=(
    "$TAG_MAJOR.$TAG_MINOR.$((TAG_PATCH + 1))"          # patch bump
    "$TAG_MAJOR.$((TAG_MINOR + 1)).0"                   # minor bump
    "$((TAG_MAJOR + 1)).0.0"                            # major bump
  )

  OK=0
  for v in "${VALID_NEXT[@]}"; do
    [[ "$NEW_VERSION" == "$v" ]] && OK=1 && break
  done

  if [[ $OK -eq 0 ]]; then
    echo "ERROR: version skip detected."
    echo "  Latest tag : $LATEST_TAG"
    echo "  Requested  : v$NEW_VERSION"
    echo "  Valid next : ${VALID_NEXT[*]}"
    echo "Fix the version or delete stale tags before proceeding."
    exit 1
  fi
fi

echo "=== SideCar Version Bump: $OLD_VERSION → $NEW_VERSION ==="
echo ""

# --- 1. Collect stats from source ---
echo "Collecting stats..."

# Test counts (run tests)
TEST_OUTPUT=$(npx vitest run 2>&1 || true)
TEST_FILES=$(echo "$TEST_OUTPUT" | grep "Test Files" | grep -o '[0-9]* passed' | grep -o '[0-9]*' || echo "?")
TEST_TOTAL=$(echo "$TEST_OUTPUT" | grep "Tests" | head -1 | grep -o '[0-9]* passed' | grep -o '[0-9]*' || echo "?")
TEST_SKIPPED=$(echo "$TEST_OUTPUT" | grep "Tests" | head -1 | grep -o '[0-9]* skipped' | grep -o '[0-9]*' || echo "0")

# Tool count — every built-in tool is declared with a line-leading
# `name: '<snake_case>'` key, either in a per-module array under
# src/agent/tools/*.ts or inline in tools.ts (ask_user, describe_tool,
# delegate_task, spawn_agent). Count those keys directly. The old
# `{ definition:` heuristic missed the separate-const and inline tools
# and undercounted by ~half (40 vs the real 80). Excludes *.test.ts
# fixtures, which also contain `name: '...'` literals.
TOOL_COUNT=$(
  {
    find src/agent/tools -name '*.ts' ! -name '*.test.ts' -exec grep -hoE "^[[:space:]]*name: ['\"][a-z_]+['\"]" {} +
    grep -hoE "^[[:space:]]*name: ['\"][a-z_]+['\"]" src/agent/tools.ts
  } | wc -l | tr -d ' '
)

# Skill count
SKILL_COUNT=$(ls skills/*.md 2>/dev/null | wc -l | tr -d ' ')

echo "  Tests:  $TEST_TOTAL passed ($TEST_FILES files, $TEST_SKIPPED skipped)"
echo "  Tools:  $TOOL_COUNT built-in"
echo "  Skills: $SKILL_COUNT built-in"
echo ""

# --- 2. Update package.json ---
echo "Updating package.json..."
sed -i '' "s/\"version\": \"$OLD_VERSION\"/\"version\": \"$NEW_VERSION\"/" package.json

# --- 3. Update ROADMAP.md ---
echo "Updating ROADMAP.md..."
sed -i '' "s/Last updated: .* (v$OLD_VERSION)/Last updated: $TODAY (v$NEW_VERSION)/" ROADMAP.md

# --- 4. Update docs/index.html (landing page stats) ---
echo "Updating docs/index.html..."
# Update test count in stat strip
sed -i '' "s/<span class=\"stat-num\">[0-9]*<\/span>\n*[[:space:]]*<span class=\"stat-label\">tests passing/<span class=\"stat-num\">$TEST_TOTAL<\/span>\n    <span class=\"stat-label\">tests passing/" docs/index.html 2>/dev/null || true
# Simpler approach — just replace the number before "tests passing"
python3 -c "
import re
with open('docs/index.html', 'r') as f:
    content = f.read()
content = re.sub(
    r'(<span class=\"stat-num\">)\d+(</span>\s*<span class=\"stat-label\">tests passing)',
    r'\g<1>${TEST_TOTAL}\g<2>',
    content
)
content = re.sub(
    r'(<span class=\"stat-num\">)\d+(</span>\s*<span class=\"stat-label\">built-in tools)',
    r'\g<1>${TOOL_COUNT}\g<2>',
    content
)
# Update ticker
content = re.sub(r'\d+ Built-in Tools', '${TOOL_COUNT} Built-in Tools', content)
with open('docs/index.html', 'w') as f:
    f.write(content)
"
# Bump the hero version string (e.g. the "v0.116.0" eyebrow). Only the exact
# current-version string matches, so older "new in vX.Y" feature badges are
# left alone.
sed -i '' "s/v$OLD_VERSION/v$NEW_VERSION/g" docs/index.html 2>/dev/null || true

# --- 5. Update docs/agent-mode.md ---
echo "Updating docs/agent-mode.md..."
sed -i '' "s/SideCar has [0-9]* built-in tools/SideCar has $TOOL_COUNT built-in tools/" docs/agent-mode.md 2>/dev/null || true

# --- 6. Update docs/troubleshooting.md ---
echo "Updating docs/troubleshooting.md..."
sed -i '' "s/[0-9]* tool definitions add/~$TOOL_COUNT tool definitions add/" docs/troubleshooting.md 2>/dev/null || true

# --- 7. Update README.md tool count ---
# README uses "**<N> built-in tools**" (no trailing '+'); match the bare
# number form. The old pattern required a literal '+' and never matched.
echo "Updating README.md..."
sed -i '' "s/[0-9][0-9]* built-in tools/$TOOL_COUNT built-in tools/g" README.md 2>/dev/null || true

# --- 7b. Update SECURITY.md supported-version table ---
# Only the supported-version rows are mechanical. The SECRET_PATTERNS "unchanged
# through vX" line is a manual judgment (assert only when the patterns really
# didn't change) — see the CONTRIBUTING doc-sync checklist.
echo "Updating SECURITY.md..."
MINOR=$(echo "$NEW_VERSION" | cut -d. -f1-2)
sed -i '' "s/| [0-9][0-9.]*\.x (current) | ✅ |/| ${MINOR}.x (current) | ✅ |/" SECURITY.md 2>/dev/null || true
sed -i '' "s/| < [0-9][0-9.]* | ❌ |/| < ${MINOR} | ❌ |/" SECURITY.md 2>/dev/null || true

# --- 8. Prepend CHANGELOG entry ---
echo "Updating CHANGELOG.md..."
CHANGELOG_ENTRY="## [$NEW_VERSION] - $TODAY

### Added
${SUMMARY:+- $SUMMARY}

### Stats
- $TEST_TOTAL total tests ($TEST_FILES test files)
- $TOOL_COUNT built-in tools, $SKILL_COUNT skills

"

# Insert after the first "All notable changes..." line
python3 -c "
with open('CHANGELOG.md', 'r') as f:
    content = f.read()
marker = '## [$OLD_VERSION]'
idx = content.find(marker)
if idx == -1:
    # Fallback: insert after header
    idx = content.find('\n\n') + 2
entry = '''$CHANGELOG_ENTRY'''
content = content[:idx] + entry + content[idx:]
with open('CHANGELOG.md', 'w') as f:
    f.write(content)
" 2>/dev/null || echo "  (manual CHANGELOG update needed)"

# --- Summary ---
echo ""
echo "=== Done! ==="
echo ""
echo "Updated files:"
git diff --name-only 2>/dev/null || true
echo ""
echo "Review changes with: git diff"
echo "Then commit with: git add -A && git commit -m 'v$NEW_VERSION: $SUMMARY'"
