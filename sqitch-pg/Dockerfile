FROM alpine

# system env
ENV LANG=C.UTF-8 TERM=dumb TZ=UTC

RUN apk update \
    && apk --no-cache add perl perl-dbi perl-dbd-pg postgresql-client ca-certificates \
    && apk --no-cache add --virtual build-dependencies perl-dev perl-app-cpanminus postgresql-dev gcc libc-dev make curl tar wget \
    && cpanm -n App::Sqitch DBD::Pg \
    && apk del --purge build-dependencies \
    && rm -rf ./cpanm /root/.cpanm /usr/src/perl /usr/local/share/man

WORKDIR /sqitch
