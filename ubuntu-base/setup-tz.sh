#!/usr/bin/env bash
set -e

# set correct time zone
if [[ -n "$TZ" ]]; then
    echo $TZ > /etc/timezone
    rm -f /etc/localtime
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime
    dpkg-reconfigure -f noninteractive tzdata 2>/dev/null
fi
