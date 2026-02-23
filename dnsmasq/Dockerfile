FROM deaddev/ubuntu

COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT [ "/entrypoint.sh" ]

WORKDIR /config

RUN apt-get update \
    && apt-get install -y \
        dnsmasq \
        libcap2-bin \
    && setcap cap_net_bind_service,cap_net_raw,cap_net_admin+ep /usr/sbin/dnsmasq \
    && apt-get autoremove -y --purge \
    && rm -rf /var/lib/apt/lists/*

USER nobody
