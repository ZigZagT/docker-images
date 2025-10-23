# Ubuntu Base with GeoIP

Ubuntu base image with MaxMind GeoLite2 databases pre-installed.

You must build the image with your own maxmind license key.

```bash
docker pull deaddev/ubuntu-base-geoip
docker pull deaddev/ubuntu-base-geoip:22.04
docker pull deaddev/ubuntu-base-geoip:latest
```

All images are built for **linux/amd64** and **linux/arm64** platforms.

## Included GeoIP Databases

This image includes the following MaxMind GeoLite2 databases:

- `/usr/share/GeoIP/GeoLite2-ASN.mmdb` - Autonomous System Number database
- `/usr/share/GeoIP/GeoLite2-City.mmdb` - City-level geolocation database
- `/usr/share/GeoIP/GeoLite2-Country.mmdb` - Country-level geolocation database

### Database Versions

To check which versions of the databases are included in your image:

```bash
docker run --rm deaddev/ubuntu-base-geoip:latest cat /MAXMIND_VERSIONS
```

This will display the last-modified dates of each database, for example:
```
GeoLite2-Country
last-modified: Fri, 10 Oct 2025 15:16:15 GMT
GeoLite2-City
last-modified: Fri, 10 Oct 2025 15:15:54 GMT
GeoLite2-ASN
last-modified: Mon, 13 Oct 2025 08:30:40 GMT
```

## Features

This image inherits all features from [ubuntu-base](../ubuntu-base/README.md):

See the [ubuntu-base README](../ubuntu-base/README.md) for detailed usage instructions.
