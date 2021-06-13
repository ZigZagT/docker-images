#!/usr/bin/env bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo -n '' > $DIR/MAXMIND_VERSIONS

add_version() {
    local EDITION=$1
    local URL="https://download.maxmind.com/app/geoip_download?edition_id=${EDITION}&license_key=${LICENSE_KEY}&suffix=tar.gz"
    echo "$EDITION" >> $DIR/MAXMIND_VERSIONS
    curl -sI "$URL" | grep last-modified >> $DIR/MAXMIND_VERSIONS
}

add_version GeoLite2-Country
add_version GeoLite2-City
add_version GeoLite2-ASN

docker build . -t deaddev/ubuntu-base:geoip --build-arg "LICENSE_KEY=${LICENSE_KEY}"
