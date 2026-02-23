#!/usr/bin/env bash
# Discovers the latest cloud-hypervisor version from GitHub releases API.
set -euo pipefail

GITHUB_API="https://api.github.com/repos/cloud-hypervisor/cloud-hypervisor/releases/latest"

CURL_ARGS=(-s)
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    CURL_ARGS+=(-H "Authorization: token $GITHUB_TOKEN")
fi

VERSION=$(curl "${CURL_ARGS[@]}" "$GITHUB_API" \
    | jq -r '.tag_name' \
    | sed 's/^v//')

if [[ -z "$VERSION" || "$VERSION" == "null" ]]; then
    echo "ERROR: Could not determine latest cloud-hypervisor version" >&2
    exit 1
fi

echo "$VERSION"
