#!/usr/bin/env bash
# bump-version.sh -- POSIX entry point. The implementation is
# scripts/bump-version.mjs (one script for every platform); this only forwards
# to it. The previous sed/python3 implementation used the macOS `sed -i ''`
# form and could not run under GNU sed -- see scripts/bump-version.mjs.
exec node "$(dirname "$0")/bump-version.mjs" "$@"
