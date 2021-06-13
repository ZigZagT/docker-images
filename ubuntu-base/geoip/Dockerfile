FROM deaddev/ubuntu-base
ARG LICENSE_KEY
# invalidate build cache if versions has changed
COPY MAXMIND_VERSIONS /MAXMIND_VERSIONS
RUN cd /tmp \
    && echo download GeoLite2-Country ... \
    && wget "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-Country&license_key=${LICENSE_KEY}&suffix=tar.gz" -O GeoLite2-Country.tar.gz \
    && tar -xzvf GeoLite2-Country.tar.gz \
    && mv GeoLite2-Country*/GeoLite2-Country.mmdb /var/ \
    && echo download GeoLite2-City ... \
    && wget "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${LICENSE_KEY}&suffix=tar.gz" -O GeoLite2-City.tar.gz \
    && tar -xzvf GeoLite2-City.tar.gz \
    && mv GeoLite2-City_*/GeoLite2-City.mmdb /var/ \
    && echo download GeoLite2-ASN ... \
    && wget "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-ASN&license_key=${LICENSE_KEY}&suffix=tar.gz" -O GeoLite2-ASN.tar.gz \
    && tar -xzvf GeoLite2-ASN.tar.gz \
    && mv GeoLite2-ASN*/GeoLite2-ASN.mmdb /var/ \
    && rm -rf GeoLite2-* \
    && mkdir -p /usr/share/GeoIP \
    && ln -s /var/GeoLite2-*.mmdb /usr/share/GeoIP
