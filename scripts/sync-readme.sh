#!/usr/bin/env bash
set -e

# Sync README.md to DockerHub repository description
# Usage: sync-readme.sh <readme_path> <dockerhub_repo>
# Requires: DOCKERHUB_USERNAME and DOCKERHUB_TOKEN environment variables

if [[ $# -lt 2 ]]; then
  echo "Usage: sync-readme.sh <readme_path> <dockerhub_repo>" >&2
  exit 1
fi

README_PATH="${1}"
DOCKERHUB_REPO="${2}"

if [[ -z "${DOCKERHUB_USERNAME}" ]]; then
  echo "Error: DOCKERHUB_USERNAME environment variable not set"
  exit 1
fi

if [[ -z "${DOCKERHUB_TOKEN}" ]]; then
  echo "Error: DOCKERHUB_TOKEN environment variable not set"
  exit 1
fi

if [[ ! -f "${README_PATH}" ]]; then
  echo "Error: README file not found: ${README_PATH}"
  exit 1
fi

echo "Syncing ${README_PATH} to DockerHub repository: ${DOCKERHUB_REPO}"

# Read README content
README_CONTENT=$(cat "${README_PATH}")

# Get JWT token from DockerHub
echo "Authenticating with DockerHub..."
TOKEN_RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${DOCKERHUB_USERNAME}\",\"password\":\"${DOCKERHUB_TOKEN}\"}" \
  https://hub.docker.com/v2/users/login/)

JWT_TOKEN=$(echo "${TOKEN_RESPONSE}" | grep -o '"token":"[^"]*' | cut -d'"' -f4)

if [[ -z "${JWT_TOKEN}" ]]; then
  echo "Error: Failed to authenticate with DockerHub"
  echo "Response: ${TOKEN_RESPONSE}"
  exit 1
fi

echo "Authentication successful"

# Update repository description
echo "Updating repository description..."
UPDATE_RESPONSE=$(curl -s -X PATCH \
  -H "Authorization: JWT ${JWT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"full_description\":$(echo "${README_CONTENT}" | jq -Rs .)}" \
  "https://hub.docker.com/v2/repositories/${DOCKERHUB_REPO}/")

# Check if update was successful
if echo "${UPDATE_RESPONSE}" | grep -q "full_description"; then
  echo "Successfully synced README to DockerHub"
  exit 0
else
  echo "Error: Failed to update repository description"
  echo "Response: ${UPDATE_RESPONSE}"
  exit 1
fi
