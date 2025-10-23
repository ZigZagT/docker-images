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
# Output:
#   Writes current versions to output file
#   If input file provided, prints "changed=true" or "changed=false" to stdout
#   Exit code 0 on success

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
  curl -sI "${URL}" | grep -i last-modified | tr -d '\r'
}

# Get current versions from MaxMind API
CURRENT_VERSIONS=$(
  echo "GeoLite2-Country"
  get_version GeoLite2-Country
  echo "GeoLite2-City"
  get_version GeoLite2-City
  echo "GeoLite2-ASN"
  get_version GeoLite2-ASN
)

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
