#!/usr/bin/env bash
set -e

# Get current MaxMind database versions and optionally compare with cached versions
# Usage: get-and-compare-maxmind-versions.sh --key <license_key> --output <output_file> [--input <input_file>]
#
# Parameters:
#   --key: MaxMind license key (required)
#   --output: Path to write current versions (required)
#   --input: Path to cached versions for comparison (optional)
#
# Output (stdout, one per line):
#   On fetch failure: "fetch_failed=true" (output file NOT written)
#   On success with --input: "changed=true" or "changed=false"
#   On success without --input: (nothing)

# Parse arguments
LICENSE_KEY=""
OUTPUT_FILE=""
INPUT_FILE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --key)
      LICENSE_KEY="$2"
      shift 2
      ;;
    --output)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    --input)
      INPUT_FILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: get-and-compare-maxmind-versions.sh --key <license_key> --output <output_file> [--input <input_file>]" >&2
      exit 1
      ;;
  esac
done

# Validate required arguments
if [[ -z "${LICENSE_KEY}" ]]; then
  echo "Error: --key is required" >&2
  exit 1
fi

if [[ -z "${OUTPUT_FILE}" ]]; then
  echo "Error: --output is required" >&2
  exit 1
fi

# Function to get last-modified header for a MaxMind edition
get_version() {
  local EDITION=$1
  local URL="https://download.maxmind.com/app/geoip_download?edition_id=${EDITION}&license_key=${LICENSE_KEY}&suffix=tar.gz"
  local RESPONSE=$(curl -sI "${URL}" 2>&1)
  local HTTP_CODE=$(echo "${RESPONSE}" | grep -i "^HTTP" | tail -1 | awk '{print $2}')

  # Check for rate limiting (429)
  if [[ "${HTTP_CODE}" == "429" ]]; then
    echo "Rate limited (429)" >&2
    return 1
  fi
  if [[ "${HTTP_CODE}" != 20* ]]; then
    echo "Error: Failed to get version for ${EDITION}, HTTP code ${HTTP_CODE}" >&2
    return 1
  fi

  echo "${RESPONSE}" | tee /dev/stderr | grep -i last-modified | tr -d '\r'
}

# Get current versions from MaxMind API
VERSION_FETCH_FAILED=false
CURRENT_VERSIONS=""

for EDITION in GeoLite2-Country GeoLite2-City GeoLite2-ASN; do
  CURRENT_VERSIONS="${CURRENT_VERSIONS}${EDITION}"$'\n'
  if VERSION=$(get_version "${EDITION}"); then
    CURRENT_VERSIONS="${CURRENT_VERSIONS}${VERSION}"$'\n'
  else
    echo "Warning: Failed to get version for ${EDITION}, likely rate limited" >&2
    VERSION_FETCH_FAILED=true
    break
  fi
done

# On fetch failure, leave output file untouched (caller keeps cached version)
if [[ "${VERSION_FETCH_FAILED}" == "true" ]]; then
  echo "fetch_failed=true"
  exit 0
fi

# Write current versions to output file
echo "${CURRENT_VERSIONS}" > "${OUTPUT_FILE}"

# If input file provided, compare versions
if [[ -n "${INPUT_FILE}" ]]; then
  if [[ -f "${INPUT_FILE}" ]]; then
    CACHED_VERSIONS=$(cat "${INPUT_FILE}")

    if [[ "${CURRENT_VERSIONS}" == "${CACHED_VERSIONS}" ]]; then
      echo "MaxMind databases unchanged"
      echo "changed=false"
    else
      echo "MaxMind databases updated"
      echo "changed=true"
    fi
  else
    echo "No cached versions found, assuming changed"
    echo "changed=true"
  fi
fi
