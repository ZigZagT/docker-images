#!/usr/bin/env bash
# Discovers the latest stable QEMU version from GitHub tags API.
# Filters out release candidates (-rc).
set -euo pipefail

GITHUB_API="https://api.github.com/repos/qemu/qemu/tags?per_page=30"

CURL_ARGS=(-s)
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    CURL_ARGS+=(-H "Authorization: token $GITHUB_TOKEN")
fi

VERSION=$(curl "${CURL_ARGS[@]}" "$GITHUB_API" \
    | jq -r '.[].name' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | head -1 \
    | sed 's/^v//')

if [[ -z "$VERSION" ]]; then
    echo "ERROR: Could not determine latest QEMU version" >&2
    exit 1
fi

echo "$VERSION"
