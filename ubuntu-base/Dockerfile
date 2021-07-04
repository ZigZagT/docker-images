FROM ubuntu:20.04
ENV TERM=xterm-256color TZ=UTC DEBIAN_FRONTEND=noninteractive
ENV APT_MIRROR=
ARG APT_MIRROR=
RUN echo archive.ubuntu.com > /apt-mirror.txt \
    && if [ -n "$APT_MIRROR" ]; \
        then sed -i "s#archive.ubuntu.com#$APT_MIRROR#g" /etc/apt/sources.list; \
        echo $APT_MIRROR > /apt-mirror.txt; \
    fi \
    && echo 'APT::Install-Recommends "false";' >> /etc/apt/apt.conf.d/99_norecommends \
    && echo 'APT::Install-Suggests "false";' >> /etc/apt/apt.conf.d/99_norecommends \
    && echo 'APT::AutoRemove::RecommendsImportant "false";' >> /etc/apt/apt.conf.d/99_norecommends \
    && echo 'APT::AutoRemove::SuggestsImportant "false";' >> /etc/apt/apt.conf.d/99_norecommends \
    && apt-get update \
    && apt-get install --no-install-recommends -y \
        sudo \
        tzdata \
        wget \
        curl \
        unzip \
        ca-certificates \
    && apt-get autoremove -y --purge

COPY container-sudoer /etc/sudoers.d/
COPY container-setup.sh /container-setup.sh
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["/bin/bash"]
