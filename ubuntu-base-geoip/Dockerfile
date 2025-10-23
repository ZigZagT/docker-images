ARG UPSTREAM_TAG
FROM deaddev/ubuntu-base:$UPSTREAM_TAG as builder
# invalidate build cache if versions has changed
COPY MAXMIND_VERSIONS /MAXMIND_VERSIONS
RUN --mount=type=secret,id=maxmind_license_key \
    cd /tmp \
    && LICENSE_KEY=$(cat /run/secrets/maxmind_license_key) \
    && mkdir -p /usr/share/GeoIP \
    && echo download GeoLite2-Country ... \
    && wget "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-Country&license_key=${LICENSE_KEY}&suffix=tar.gz" -O GeoLite2-Country.tar.gz \
    && tar -xzvf GeoLite2-Country.tar.gz \
    && mv GeoLite2-Country*/GeoLite2-Country.mmdb /usr/share/GeoIP/ \
    && echo download GeoLite2-City ... \
    && wget "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${LICENSE_KEY}&suffix=tar.gz" -O GeoLite2-City.tar.gz \
    && tar -xzvf GeoLite2-City.tar.gz \
    && mv GeoLite2-City_*/GeoLite2-City.mmdb /usr/share/GeoIP/ \
    && echo download GeoLite2-ASN ... \
    && wget "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-ASN&license_key=${LICENSE_KEY}&suffix=tar.gz" -O GeoLite2-ASN.tar.gz \
    && tar -xzvf GeoLite2-ASN.tar.gz \
    && mv GeoLite2-ASN*/GeoLite2-ASN.mmdb /usr/share/GeoIP/ \
    && rm -rf GeoLite2-*

FROM deaddev/ubuntu-base:$UPSTREAM_TAG
COPY --from=builder /MAXMIND_VERSIONS /MAXMIND_VERSIONS
COPY --from=builder /usr/share/GeoIP /usr/share/GeoIP
