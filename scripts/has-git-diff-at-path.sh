#!/usr/bin/env bash
set -e

# Check if there are git differences at a specified path.
# Usage: has-git-diff-at-path.sh <path> <base_ref>
# Exit codes:
#   0 = differences found OR base_ref unreachable (safe default: rebuild)
#   1 = no differences
#   2 = usage error

if [[ $# -lt 2 ]]; then
  echo "Usage: has-git-diff-at-path.sh <path> <base_ref>" >&2
  exit 2
fi

PATH_TO_CHECK="${1}"
BASE_REF="${2}"

echo "Checking for changes in ${PATH_TO_CHECK} since ${BASE_REF}"

if [[ ! -e "${PATH_TO_CHECK}" ]]; then
  echo "Error: Path ${PATH_TO_CHECK} does not exist" >&2
  exit 2
fi

# Resolve BASE_REF to a commit object. Even with fetch-depth: 0, an
# orphaned commit (e.g. one replaced by `git push --force` or amended away)
# isn't reachable from any ref and won't be in the local clone. Fetch it
# explicitly by SHA — GitHub retains unreferenced commits for some time
# and allows fetching them by their full SHA.
if ! git rev-parse --verify --quiet "${BASE_REF}^{commit}" > /dev/null; then
  echo "Base ref ${BASE_REF} not in local clone, attempting to fetch by SHA"
  git fetch --no-tags origin "${BASE_REF}" 2>&1 || true
fi

# Re-check after fetch attempts. If the commit is STILL unreachable
# (deleted by GitHub's gc, or some other issue), we cannot diff and
# must default to "changes detected" so the build runs — never silently
# skip a build because we couldn't verify the diff.
if ! git rev-parse --verify --quiet "${BASE_REF}^{commit}" > /dev/null; then
  echo "Base ref ${BASE_REF} unreachable after fetch — defaulting to 'changes detected' to avoid skipping a build" >&2
  exit 0
fi

# Run the diff. If the diff command itself fails (unexpected at this point
# since the object is reachable), default to "changes detected" too.
if ! CHANGED_FILES=$(git diff --name-only "${BASE_REF}" HEAD -- "${PATH_TO_CHECK}" 2>&1); then
  echo "git diff failed unexpectedly: ${CHANGED_FILES}" >&2
  echo "Defaulting to 'changes detected' to avoid skipping a build" >&2
  exit 0
fi

if [[ -n "${CHANGED_FILES}" ]]; then
  echo "Changes detected in ${PATH_TO_CHECK}:"
  echo "${CHANGED_FILES}"
  exit 0
fi

echo "No changes detected in ${PATH_TO_CHECK}"
exit 1
