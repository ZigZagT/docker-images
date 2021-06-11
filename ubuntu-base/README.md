# Ubuntu Base

A minimal ubuntu images that achieve the following things:

```bash
docker pull deaddev/ubuntu-base
```

1. Support set timezone via `TZ` environment variable. For example, `docker run -e TZ=America/Vancouver` will set the container time zone to pacific time.
2. Support set apt mirror via `APT_MIRROR` environment variable at both build time and run time:
    - for build time, set mirror with `docker build --build-arg APT_MIRROR=us.archive.ubuntu.com`
    - for run time, set mirror with `docker run -e APT_MIRROR=us.archive.ubuntu.com`
    - you may find a mirror near to you from https://launchpad.net/ubuntu/+archivemirrors
3. Disable installing recommends and suggests for `apt-get`. The recommends and suggests are usually useless for serious server setups, and are usually severely slowing down image build speed.
4. Be HTTP ready. Adding `curl` and `wget` to the image. Anyone that doesn't trust `curl` or `wget` should just stay away from the internet.
