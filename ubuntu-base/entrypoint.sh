#!/usr/bin/env bash

# set correct time zone
echo $TZ > /etc/timezone
rm -f /etc/localtime
ln -snf /usr/share/zoneinfo/$TZ /etc/localtime
dpkg-reconfigure -f noninteractive tzdata 2>/dev/null

# set apt mirror
if [[ -n $APT_MIRROR ]]; then
    sed -i "s#$(cat apt-mirror.txt)#$APT_MIRROR#g" /etc/apt/sources.list
fi

exec "$@"
