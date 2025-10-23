# Default Ubuntu version
UPSTREAM_TAG ?= 22.04

# Image tag for local builds
LOCAL_TAG := local

# Check if MAXMIND_LICENSE_KEY is set (required for geoip image)
ifndef MAXMIND_LICENSE_KEY
MAXMIND_LICENSE_KEY_WARNING := @echo "Warning: MAXMIND_LICENSE_KEY not set. Required for ubuntu-base-geoip build."
endif

.PHONY: help all ubuntu-base ubuntu-base-geoip dnsmasq-exporter sqitch-pg wait-for-pg clean

# Default target
help:
	@echo "Docker Images - Local Build Makefile"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  all                 - Build all images"
	@echo "  ubuntu-base         - Build ubuntu-base image"
	@echo "  ubuntu-base-geoip   - Build ubuntu-base-geoip image (requires MAXMIND_LICENSE_KEY)"
	@echo "  dnsmasq-exporter    - Build dnsmasq_exporter image"
	@echo "  sqitch-pg           - Build sqitch-pg image"
	@echo "  wait-for-pg         - Build wait-for-pg image"
	@echo "  clean               - Remove all local tagged images"
	@echo ""
	@echo "Environment Variables:"
	@echo "  UPSTREAM_TAG        - Ubuntu version (default: 22.04)"
	@echo "  MAXMIND_LICENSE_KEY - MaxMind license key (required for ubuntu-base-geoip)"
	@echo ""
	@echo "Examples:"
	@echo "  make ubuntu-base"
	@echo "  make ubuntu-base-geoip MAXMIND_LICENSE_KEY=your_key"
	@echo "  make all UPSTREAM_TAG=24.04"

all: ubuntu-base ubuntu-base-geoip dnsmasq-exporter sqitch-pg wait-for-pg

ubuntu-base:
	@echo "Building ubuntu-base:$(LOCAL_TAG) with Ubuntu $(UPSTREAM_TAG)..."
	docker build ubuntu-base \
		--build-arg UPSTREAM_TAG=$(UPSTREAM_TAG) \
		-t ubuntu-base:$(LOCAL_TAG)
	@echo "Successfully built ubuntu-base:$(LOCAL_TAG)"

ubuntu-base-geoip: ubuntu-base
	$(MAXMIND_LICENSE_KEY_WARNING)
	@echo "Building ubuntu-base-geoip:$(LOCAL_TAG) with Ubuntu $(UPSTREAM_TAG)..."
	@if [ -z "$(MAXMIND_LICENSE_KEY)" ]; then \
		echo "Error: MAXMIND_LICENSE_KEY environment variable is required"; \
		exit 1; \
	fi
	@./scripts/get-and-compare-maxmind-versions.sh \
		--key "$(MAXMIND_LICENSE_KEY)" \
		--output ubuntu-base-geoip/MAXMIND_VERSIONS
	@echo "Generated MAXMIND_VERSIONS file"
	docker build ubuntu-base-geoip \
		--build-arg UPSTREAM_TAG=$(UPSTREAM_TAG) \
		--secret id=maxmind_license_key,env=MAXMIND_LICENSE_KEY \
		-t ubuntu-base-geoip:$(LOCAL_TAG)
	@echo "Successfully built ubuntu-base-geoip:$(LOCAL_TAG)"

dnsmasq-exporter:
	@echo "Building dnsmasq_exporter:$(LOCAL_TAG)..."
	docker build dnsmasq_exporter \
		-t dnsmasq_exporter:$(LOCAL_TAG)
	@echo "Successfully built dnsmasq_exporter:$(LOCAL_TAG)"

sqitch-pg:
	@echo "Building sqitch-pg:$(LOCAL_TAG)..."
	docker build sqitch-pg \
		-t sqitch-pg:$(LOCAL_TAG)
	@echo "Successfully built sqitch-pg:$(LOCAL_TAG)"

wait-for-pg:
	@echo "Building wait-for-pg:$(LOCAL_TAG)..."
	docker build wait-for-pg \
		-t wait-for-pg:$(LOCAL_TAG)
	@echo "Successfully built wait-for-pg:$(LOCAL_TAG)"

clean:
	@echo "Removing local tagged images..."
	-docker rmi ubuntu-base:$(LOCAL_TAG) 2>/dev/null || true
	-docker rmi ubuntu-base-geoip:$(LOCAL_TAG) 2>/dev/null || true
	-docker rmi dnsmasq_exporter:$(LOCAL_TAG) 2>/dev/null || true
	-docker rmi sqitch-pg:$(LOCAL_TAG) 2>/dev/null || true
	-docker rmi wait-for-pg:$(LOCAL_TAG) 2>/dev/null || true
	@echo "Removing generated files..."
	-rm -f ubuntu-base-geoip/MAXMIND_VERSIONS 2>/dev/null || true
	@echo "Cleanup complete"
