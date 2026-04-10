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

echo "=== SideCar Version Bump: $OLD_VERSION → $NEW_VERSION ==="
echo ""

# --- 1. Collect stats from source ---
echo "Collecting stats..."

# Test counts (run tests)
TEST_OUTPUT=$(npx vitest run 2>&1 || true)
TEST_FILES=$(echo "$TEST_OUTPUT" | grep "Test Files" | grep -o '[0-9]* passed' | grep -o '[0-9]*' || echo "?")
TEST_TOTAL=$(echo "$TEST_OUTPUT" | grep "Tests" | head -1 | grep -o '[0-9]* passed' | grep -o '[0-9]*' || echo "?")
TEST_SKIPPED=$(echo "$TEST_OUTPUT" | grep "Tests" | head -1 | grep -o '[0-9]* skipped' | grep -o '[0-9]*' || echo "0")

# Tool count (from TOOL_REGISTRY + spawn_agent)
TOOL_REGISTRY_COUNT=$(grep -c "{ definition:" src/agent/tools.ts || echo "0")
# spawn_agent is defined separately, add 1
TOOL_COUNT=$((TOOL_REGISTRY_COUNT + 1))

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

# --- 5. Update docs/agent-mode.md ---
echo "Updating docs/agent-mode.md..."
sed -i '' "s/SideCar has [0-9]* built-in tools/SideCar has $TOOL_COUNT built-in tools/" docs/agent-mode.md 2>/dev/null || true

# --- 6. Update docs/troubleshooting.md ---
echo "Updating docs/troubleshooting.md..."
sed -i '' "s/[0-9]* tool definitions add/~$TOOL_COUNT tool definitions add/" docs/troubleshooting.md 2>/dev/null || true

# --- 7. Update README.md tool count ---
echo "Updating README.md..."
sed -i '' "s/[0-9]*+ built-in tools/${TOOL_COUNT}+ built-in tools/" README.md 2>/dev/null || true

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
