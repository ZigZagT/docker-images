ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY MAXMIND_VERSIONS /MAXMIND_VERSIONS
COPY databases/ /usr/share/GeoIP/
RUN test -f /usr/share/GeoIP/GeoLite2-Country.mmdb \
    && test -f /usr/share/GeoIP/GeoLite2-City.mmdb \
    && test -f /usr/share/GeoIP/GeoLite2-ASN.mmdb \
    || { echo "ERROR: GeoIP databases missing from image" >&2 ; exit 1 ; }
