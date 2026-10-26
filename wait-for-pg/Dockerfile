FROM alpine

ENV LANG=C.UTF-8 TERM=dumb TZ=UTC
ENV DB_HOST DB_PORT DB_USERNAME DB_PASSWORD

RUN apk update \
    && apk --no-cache add postgresql-client ca-certificates

COPY wait_for_pg.sh /wait_for_pg.sh
CMD /wait_for_pg.sh
