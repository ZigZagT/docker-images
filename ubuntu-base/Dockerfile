FROM ubuntu:20.04
ENV TERM=xterm-256color DEBIAN_FRONTEND=noninteractive
ENV APT_MIRROR=
ARG APT_MIRROR=
ARG TZ=
COPY setup-tz.sh /setup-tz.sh
COPY setup-apt.sh /setup-apt.sh
RUN echo archive.ubuntu.com > /apt-mirror.txt \
    && /setup-apt.sh \
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
    && apt-get autoremove -y --purge \
    && /setup-tz.sh

COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["/bin/bash"]
