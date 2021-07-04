# Ubuntu Base

A minimal ubuntu images with life-quality-improvements built in.

```bash
docker pull deaddev/ubuntu-base
```

## Usage

1. Timezone can be set via `TZ` environment variable. Either at build or run time.
    - for build time, use something like `docker build --build-arg TZ=America/Vancouver`
    - for run time, use something like `docker run -e TZ=America/Vancouver`
2. Set apt mirror via `APT_MIRROR` environment variable, also at either build time and run time:
    - for build time, set mirror with `docker build --build-arg APT_MIRROR=us.archive.ubuntu.com`
    - for run time, set mirror with `docker run -e APT_MIRROR=us.archive.ubuntu.com`
    - you may find a mirror near to you from https://launchpad.net/ubuntu/+archivemirrors
3. Use `UID` and `GID` environment variables to run as non-root user.
4. Never installing recommends and suggests for `apt-get`. Recommends and suggests are usually useless for serious server setups, and are usually severely slowing down image build speed.
5. HTTP ready. Adding `curl` and `wget` to the image. Anyone that doesn't trust `curl` or `wget` should just stay away from the internet.

## Caveats
Never use `USER` command in `Dockerfile` that based on this image. The run-time setup of `TZ` and `APT_MIRROR` needs root access and `USER` commend just breaks everything.

Alter natively, set `UID` and `GID` environment variables to use an non-root user in container.

## Geoip variant
The `:geoip` tag is a version includes the common MaxMind GeoLite databases. Including:
- `/usr/share/GeoIP/GeoLite2-ASN.mmdb`
- `/usr/share/GeoIP/GeoLite2-City.mmdb`
- `/usr/share/GeoIP/GeoLite2-Country.mmdb`
