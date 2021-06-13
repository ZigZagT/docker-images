FROM golang:1.12.6-stretch AS build-env
ENV CGO_ENABLED=0
WORKDIR /src
RUN wget -O master.tgz https://github.com/google/dnsmasq_exporter/archive/master.tar.gz \
    && tar -xzf master.tgz \
    && cd dnsmasq_exporter-master \
    && go build -o dnsmasq_exporter

FROM scratch
WORKDIR /app
COPY --from=build-env /src/dnsmasq_exporter-master/dnsmasq_exporter /app/
USER 65534
ENTRYPOINT ["/app/dnsmasq_exporter"]
