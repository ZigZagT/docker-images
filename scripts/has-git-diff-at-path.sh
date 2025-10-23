#!/usr/bin/env bash
set -e

# Check if there are git differences at a specified path
# Usage: has-git-diff-at-path.sh <path> <base_ref>
# Returns: 0 if differences found, 1 if no differences

if [[ $# -lt 2 ]]; then
  echo "Usage: has-git-diff-at-path.sh <path> <base_ref>" >&2
  exit 2
fi

PATH_TO_CHECK="${1}"
BASE_REF="${2}"

echo "Checking for changes in ${PATH_TO_CHECK} since ${BASE_REF}"

# Check if path exists
if [[ ! -e "${PATH_TO_CHECK}" ]]; then
  echo "Error: Path ${PATH_TO_CHECK} does not exist" >&2
  exit 2
fi

# Check for file changes at the specified path
CHANGED_FILES=$(git diff --name-only "${BASE_REF}" HEAD -- "${PATH_TO_CHECK}" || echo "")

if [[ -n "${CHANGED_FILES}" ]]; then
  echo "Changes detected in ${PATH_TO_CHECK}:"
  echo "${CHANGED_FILES}"
  exit 0
fi

echo "No changes detected in ${PATH_TO_CHECK}"
exit 1
