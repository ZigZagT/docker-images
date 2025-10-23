FROM golang:1-trixie AS build-env
ENV CGO_ENABLED=0
ENV GOPROXY=direct
WORKDIR /src
RUN wget -O main.tgz https://github.com/google/dnsmasq_exporter/archive/main.tar.gz \
    && tar -xzf main.tgz \
    && cd dnsmasq_exporter-main \
    && go build -o dnsmasq_exporter

FROM scratch
WORKDIR /app
COPY --from=build-env /src/dnsmasq_exporter-main/dnsmasq_exporter /app/
USER 65534
ENTRYPOINT ["/app/dnsmasq_exporter"]
