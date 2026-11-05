ARG UPSTREAM_TAG
FROM ubuntu:${UPSTREAM_TAG}
ENV LANG=C.UTF-8 TERM=xterm-256color DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR
ARG TZ
COPY setup-tz.c setup-apt.c entrypoint.sh ISRG-Root-X1-X2-CA.pem /container-setup/

RUN echo 'APT::Install-Recommends "false";' >> /etc/apt/apt.conf.d/99_norecommends \
    && echo 'APT::Install-Suggests "false";' >> /etc/apt/apt.conf.d/99_norecommends \
    && echo 'APT::AutoRemove::RecommendsImportant "false";' >> /etc/apt/apt.conf.d/99_norecommends \
    && echo 'APT::AutoRemove::SuggestsImportant "false";' >> /etc/apt/apt.conf.d/99_norecommends \
    && find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) -exec sed -i 's|http://|https://|g' {} + \
    && apt-get -o Acquire::https::CAInfo=/container-setup/ISRG-Root-X1-X2-CA.pem update \
    && apt-get -o Acquire::https::CAInfo=/container-setup/ISRG-Root-X1-X2-CA.pem install --no-install-recommends -y \
        ca-certificates \
        gcc \
        libc6-dev \
    && gcc -O2 -Wall -o /container-setup/setup-apt /container-setup/setup-apt.c \
    && gcc -O2 -Wall -o /container-setup/setup-tz /container-setup/setup-tz.c \
    && rm -f /container-setup/*.c /container-setup/ISRG-Root-X1-X2-CA.pem \
    && chmod 4755 /container-setup/setup-apt /container-setup/setup-tz \
    && chmod 0755 /container-setup/entrypoint.sh \
    && chmod 0733 /container-setup \
    && /container-setup/setup-apt \
    && apt-get update \
    && apt-get install --no-install-recommends -y \
        tzdata \
        wget \
        curl \
        jq \
        unzip \
        python3 \
    && apt-get purge -y \
        gcc \
        libc6-dev \
    && apt-get autoremove -y --purge \
    && rm -rf /var/lib/apt/lists/* \
    && /container-setup/setup-tz

ENV CONTAINER_SETUP_LOG=warn
ENTRYPOINT ["/container-setup/entrypoint.sh"]
CMD ["/bin/bash"]
