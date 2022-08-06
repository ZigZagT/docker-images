#!/bin/bash
set -e

VERSION_CODENAME=$(grep VERSION_CODENAME /etc/os-release | cut -d '=' -f 2)
SOURCE_LIST=$(cat <<-EOL
deb ${APT_MIRROR} ${VERSION_CODENAME} main restricted
deb ${APT_MIRROR} ${VERSION_CODENAME}-updates main restricted
deb ${APT_MIRROR} ${VERSION_CODENAME} universe
deb ${APT_MIRROR} ${VERSION_CODENAME}-updates universe
deb ${APT_MIRROR} ${VERSION_CODENAME} multiverse
deb ${APT_MIRROR} ${VERSION_CODENAME}-updates multiverse
deb ${APT_MIRROR} ${VERSION_CODENAME}-backports main restricted universe multiverse
deb ${APT_MIRROR} ${VERSION_CODENAME}-security main restricted
deb ${APT_MIRROR} ${VERSION_CODENAME}-security universe
deb ${APT_MIRROR} ${VERSION_CODENAME}-security multiverse
EOL
)

# set apt mirror
if [[ -n "$APT_MIRROR" ]]; then
    echo "$SOURCE_LIST" > /etc/apt/sources.list
fi
