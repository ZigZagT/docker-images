ARG UPSTREAM_TAG
FROM ubuntu:${UPSTREAM_TAG}
ENV LANG=C.UTF-8 TERM=xterm-256color DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR
ARG TZ
COPY setup-tz.sh setup-apt.sh entrypoint.sh /container-setup/

RUN echo 'APT::Install-Recommends "false";' >> /etc/apt/apt.conf.d/99_norecommends \
    && echo 'APT::Install-Suggests "false";' >> /etc/apt/apt.conf.d/99_norecommends \
    && echo 'APT::AutoRemove::RecommendsImportant "false";' >> /etc/apt/apt.conf.d/99_norecommends \
    && echo 'APT::AutoRemove::SuggestsImportant "false";' >> /etc/apt/apt.conf.d/99_norecommends \
    && apt-get update \
    && apt-get install --no-install-recommends -y \
        ca-certificates \
    && /container-setup/setup-apt.sh \
    && apt-get update \
    && apt-get install --no-install-recommends -y \
        tzdata \
        wget \
        curl \
        unzip \
        shc \
        build-essential \
    && shc -r -S -f /container-setup/setup-apt.sh -v \
    && shc -r -S -f /container-setup/setup-tz.sh -v \
    && rm -f /container-setup/*.sh.x.c \
    && chmod 0700 /container-setup/setup-apt.sh /container-setup/setup-tz.sh \
    && chmod 4755 /container-setup/setup-apt.sh.x /container-setup/setup-tz.sh.x \
    && chmod 0755 /container-setup/entrypoint.sh \
    && chmod 0733 /container-setup \
    && apt-get purge -y build-essential shc \
    && apt-get autoremove -y --purge \
    && /container-setup/setup-tz.sh

ENTRYPOINT ["/container-setup/entrypoint.sh"]
CMD ["/bin/bash"]
