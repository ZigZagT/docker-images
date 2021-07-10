FROM ubuntu:20.04
ENV TERM=xterm-256color DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR
ARG TZ
COPY setup-tz.sh setup-apt.sh /container-setup/
RUN echo archive.ubuntu.com > /apt-mirror.txt \
    && /container-setup/setup-apt.sh \
    && echo 'APT::Install-Recommends "false";' >> /etc/apt/apt.conf.d/99_norecommends \
    && echo 'APT::Install-Suggests "false";' >> /etc/apt/apt.conf.d/99_norecommends \
    && echo 'APT::AutoRemove::RecommendsImportant "false";' >> /etc/apt/apt.conf.d/99_norecommends \
    && echo 'APT::AutoRemove::SuggestsImportant "false";' >> /etc/apt/apt.conf.d/99_norecommends \
    && apt-get update \
    && apt-get install --no-install-recommends -y \
        tzdata \
        wget \
        curl \
        unzip \
        ca-certificates \
        shc \
        build-essential \
    && shc -r -S -f /container-setup/setup-apt.sh -v \
    && shc -r -S -f /container-setup/setup-tz.sh -v \
    && chmod u+s /container-setup/setup-apt.sh.x /container-setup/setup-tz.sh.x \
    && chmod a+w /container-setup \
    && rm -f /container-setup/*.sh /container-setup/*.sh.x.c \
    && apt-get purge -y build-essential shc \
    && apt-get autoremove -y --purge \
    && /container-setup/setup-tz.sh.x

COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["/bin/bash"]
