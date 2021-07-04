#!/usr/bin/env bash
set -e

# set apt mirror
if [[ -n "$APT_MIRROR" ]]; then
    sed -i "s#$(cat apt-mirror.txt)#$APT_MIRROR#g" /etc/apt/sources.list
    echo "$APT_MIRROR" > /apt-mirror.txt
fi
