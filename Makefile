SHELL := /bin/bash

# Default arguments
UPSTREAM_TAGS ?= 22.04 24.04 26.04
LATEST_TAG ?= 24.04
NODEJS_VERSIONS ?= 22 24
DEFAULT_NODEJS_VERSION ?= 24
TZ ?= America/Vancouver
APT_MIRROR ?=
DOCKERHUB_USERNAME ?= deaddev
PUSH ?= false
QEMU_VERSIONS ?= 10.2.1
QEMU_LATEST ?= 10.2.1
CH_VERSIONS ?= 51.1
CH_LATEST ?= 51.1

# Buildx specific
PLATFORM ?= linux/amd64,linux/arm64
BUILDX_CMD = docker buildx build --platform $(PLATFORM)
ifeq ($(PUSH),true)
	BUILDX_CMD += --push
endif

.PHONY: all ubuntu ubuntu-nodejs ubuntu-rust ubuntu-geoip ubuntu-geoip-download ubuntu-geoip-build dnsmasq-exporter shadowsocks dnsmasq qemu cloud-hypervisor sqitch-pg wait-for-pg clean

# Default target
all: ubuntu ubuntu-nodejs ubuntu-rust ubuntu-geoip dnsmasq-exporter shadowsocks dnsmasq qemu cloud-hypervisor sqitch-pg wait-for-pg
all-ubuntu: ubuntu ubuntu-nodejs ubuntu-rust

ubuntu:
	@for tag in $(UPSTREAM_TAGS); do \
		echo "Building ubuntu:$$tag"; \
		tags="-t $(DOCKERHUB_USERNAME)/ubuntu:$$tag"; \
		if [ "$$tag" = "$(LATEST_TAG)" ]; then \
			tags="$$tags -t $(DOCKERHUB_USERNAME)/ubuntu:latest"; \
		fi; \
		$(BUILDX_CMD) \
			--build-arg UPSTREAM_TAG=$$tag \
			--build-arg TZ="$(TZ)" \
			--build-arg APT_MIRROR="$(APT_MIRROR)" \
			$$tags \
			--cache-from $(DOCKERHUB_USERNAME)/ubuntu:$$tag \
			ubuntu; \
	done

test-ubuntu-setup-tz:
	docker build ubuntu \
		--build-arg UPSTREAM_TAG=$(LATEST_TAG) \
		--build-arg TZ="America/Vancouver"
	! docker build ubuntu \
		--build-arg UPSTREAM_TAG=$(LATEST_TAG) \
		--build-arg TZ="America/../../../../etc/passwd"
	! docker build ubuntu \
		--build-arg UPSTREAM_TAG=$(LATEST_TAG) \
		--build-arg TZ="America/BadZone"
	docker build ubuntu \
		--build-arg UPSTREAM_TAG=$(LATEST_TAG) \
		--build-arg TZ=""

ubuntu-nodejs:
	@for ubuntu in $(UPSTREAM_TAGS); do \
		for nodejs in $(NODEJS_VERSIONS); do \
			echo "Building ubuntu:$$ubuntu-nodejs-$$nodejs"; \
			tags="-t $(DOCKERHUB_USERNAME)/ubuntu:$$ubuntu-nodejs-$$nodejs"; \
			if [ "$$nodejs" = "$(DEFAULT_NODEJS_VERSION)" ]; then \
				tags="$$tags -t $(DOCKERHUB_USERNAME)/ubuntu:$$ubuntu-nodejs"; \
			fi; \
			if [ "$$ubuntu" = "$(LATEST_TAG)" ]; then \
				tags="$$tags -t $(DOCKERHUB_USERNAME)/ubuntu:nodejs-$$nodejs"; \
				if [ "$$nodejs" = "$(DEFAULT_NODEJS_VERSION)" ]; then \
					tags="$$tags -t $(DOCKERHUB_USERNAME)/ubuntu:nodejs"; \
				fi; \
			fi; \
			$(BUILDX_CMD) \
				--build-arg BASE_IMAGE=$(DOCKERHUB_USERNAME)/ubuntu:$$ubuntu \
				--build-arg NODE_VERSION=$$nodejs \
				$$tags \
				-f ubuntu/Dockerfile.nodejs \
				ubuntu; \
		done \
	done

ubuntu-rust:
	@for ubuntu in $(UPSTREAM_TAGS); do \
		echo "Building ubuntu:$$ubuntu-rust"; \
		tags="-t $(DOCKERHUB_USERNAME)/ubuntu:$$ubuntu-rust"; \
		if [ "$$ubuntu" = "$(LATEST_TAG)" ]; then \
			tags="$$tags -t $(DOCKERHUB_USERNAME)/ubuntu:rust"; \
		fi; \
		$(BUILDX_CMD) \
			--build-arg BASE_IMAGE=$(DOCKERHUB_USERNAME)/ubuntu:$$ubuntu \
			--build-arg RUST_VERSION=stable \
			$$tags \
			-f ubuntu/Dockerfile.rust \
			ubuntu; \
	done

ubuntu-geoip: ubuntu-geoip-download ubuntu-geoip-build

ubuntu-geoip-download:
	@echo "Checking MaxMind database versions..."
	@MAXMIND_VERSION_CHECK_RESULTS=$$(./scripts/get-and-compare-maxmind-versions.sh \
		--key '$(or $(MAXMIND_LICENSE_KEY),)' \
		--output ubuntu-geoip/MAXMIND_VERSIONS.new \
		--input ubuntu-geoip/MAXMIND_VERSIONS) || true; \
	NEED_DOWNLOAD=true; \
	if echo "$$MAXMIND_VERSION_CHECK_RESULTS" | grep -q "fetch_failed=true"; then \
		echo "MaxMind API fetch failed, using cached databases"; \
		NEED_DOWNLOAD=false; \
	elif echo "$$MAXMIND_VERSION_CHECK_RESULTS" | grep -q "changed=false"; then \
		echo "MaxMind database versions unchanged, using cached databases"; \
		rm -f ubuntu-geoip/MAXMIND_VERSIONS.new; \
		NEED_DOWNLOAD=false; \
	fi; \
	if [ "$$NEED_DOWNLOAD" = "true" ]; then \
		echo "Downloading MaxMind databases..."; \
		mkdir -p ubuntu-geoip/databases; \
		DOWNLOAD_OK=true; \
		for edition in GeoLite2-Country GeoLite2-City GeoLite2-ASN; do \
			echo "Downloading $${edition}..."; \
			wget -q "https://download.maxmind.com/app/geoip_download?edition_id=$${edition}&license_key=$(MAXMIND_LICENSE_KEY)&suffix=tar.gz" \
				-O "/tmp/$${edition}.tar.gz" \
			&& tar -xzf "/tmp/$${edition}.tar.gz" -C /tmp \
			&& mv /tmp/$${edition}*/$${edition}.mmdb ubuntu-geoip/databases/ \
			&& rm -rf /tmp/$${edition}* \
			|| { echo "WARNING: Failed to download $${edition}" >&2; DOWNLOAD_OK=false; break; }; \
		done; \
		if [ "$$DOWNLOAD_OK" = "true" ]; then \
			mv ubuntu-geoip/MAXMIND_VERSIONS.new ubuntu-geoip/MAXMIND_VERSIONS; \
		else \
			echo "Download failed, reverting version file"; \
			rm -f ubuntu-geoip/MAXMIND_VERSIONS.new; \
		fi; \
	fi; \
	for db in GeoLite2-Country GeoLite2-City GeoLite2-ASN; do \
		test -f ubuntu-geoip/databases/$$db.mmdb || { \
			echo "ERROR: $$db.mmdb not found and cannot be downloaded" >&2; exit 1; \
		}; \
	done; \
	echo "All MaxMind databases present"; \
	ls -lh ubuntu-geoip/databases/*.mmdb

ubuntu-geoip-build:
	@for db in GeoLite2-Country GeoLite2-City GeoLite2-ASN; do \
		test -f ubuntu-geoip/databases/$$db.mmdb || { \
			echo "ERROR: $$db.mmdb not found — run 'make ubuntu-geoip-download' first" >&2; exit 1; \
		}; \
	done; \
	for tag in $(UPSTREAM_TAGS); do \
		echo "Building ubuntu-geoip:$$tag"; \
		tags="-t $(DOCKERHUB_USERNAME)/ubuntu-geoip:$$tag"; \
		if [ "$$tag" = "$(LATEST_TAG)" ]; then \
			tags="$$tags -t $(DOCKERHUB_USERNAME)/ubuntu-geoip:latest"; \
		fi; \
		$(BUILDX_CMD) \
			--build-arg BASE_IMAGE=$(DOCKERHUB_USERNAME)/ubuntu:$$tag \
			$$tags \
			--cache-from $(DOCKERHUB_USERNAME)/ubuntu-geoip:$$tag \
			ubuntu-geoip; \
	done

shadowsocks:
	@echo "Building shadowsocks..."
	$(BUILDX_CMD) \
		-t $(DOCKERHUB_USERNAME)/shadowsocks:latest \
		shadowsocks

dnsmasq:
	@echo "Building dnsmasq..."
	$(BUILDX_CMD) \
		-t $(DOCKERHUB_USERNAME)/dnsmasq:latest \
		dnsmasq

qemu:
	@EDGE_VERSION=$$(./scripts/get-latest-qemu-version.sh); \
	ALL_VERSIONS="$(QEMU_VERSIONS)"; \
	if ! echo " $$ALL_VERSIONS " | grep -q " $$EDGE_VERSION "; then \
		ALL_VERSIONS="$$ALL_VERSIONS $$EDGE_VERSION"; \
	fi; \
	for ver in $$ALL_VERSIONS; do \
		echo "Building qemu:$$ver"; \
		tags="-t $(DOCKERHUB_USERNAME)/qemu:$$ver"; \
		if [ "$$ver" = "$(QEMU_LATEST)" ]; then \
			tags="$$tags -t $(DOCKERHUB_USERNAME)/qemu:latest"; \
		fi; \
		if [ "$$ver" = "$$EDGE_VERSION" ]; then \
			tags="$$tags -t $(DOCKERHUB_USERNAME)/qemu:edge"; \
		fi; \
		$(BUILDX_CMD) \
			--build-arg BASE_IMAGE=$(DOCKERHUB_USERNAME)/ubuntu:$(LATEST_TAG) \
			--build-arg QEMU_VERSION=$$ver \
			$$tags \
			--cache-from $(DOCKERHUB_USERNAME)/qemu:$$ver \
			qemu; \
	done

cloud-hypervisor:
	@EDGE_VERSION=$$(./scripts/get-latest-cloud-hypervisor-version.sh); \
	ALL_VERSIONS="$(CH_VERSIONS)"; \
	if ! echo " $$ALL_VERSIONS " | grep -q " $$EDGE_VERSION "; then \
		ALL_VERSIONS="$$ALL_VERSIONS $$EDGE_VERSION"; \
	fi; \
	for ver in $$ALL_VERSIONS; do \
		echo "Building cloud-hypervisor:$$ver"; \
		tags="-t $(DOCKERHUB_USERNAME)/cloud-hypervisor:$$ver"; \
		if [ "$$ver" = "$(CH_LATEST)" ]; then \
			tags="$$tags -t $(DOCKERHUB_USERNAME)/cloud-hypervisor:latest"; \
		fi; \
		if [ "$$ver" = "$$EDGE_VERSION" ]; then \
			tags="$$tags -t $(DOCKERHUB_USERNAME)/cloud-hypervisor:edge"; \
		fi; \
		$(BUILDX_CMD) \
			--build-arg BASE_IMAGE=$(DOCKERHUB_USERNAME)/ubuntu:$(LATEST_TAG) \
			--build-arg CH_VERSION=$$ver \
			$$tags \
			--cache-from $(DOCKERHUB_USERNAME)/cloud-hypervisor:$$ver \
			cloud-hypervisor; \
	done

dnsmasq-exporter:
	@echo "Building dnsmasq_exporter..."
	$(BUILDX_CMD) \
		-t $(DOCKERHUB_USERNAME)/dnsmasq_exporter:latest \
		dnsmasq_exporter

sqitch-pg:
	@echo "Building sqitch-pg..."
	$(BUILDX_CMD) \
		-t $(DOCKERHUB_USERNAME)/sqitch-pg:latest \
		sqitch-pg

wait-for-pg:
	@echo "Building wait-for-pg..."
	$(BUILDX_CMD) \
		-t $(DOCKERHUB_USERNAME)/wait-for-pg:latest \
		wait-for-pg

clean:
	@echo "Cleaning up..."
	-rm -f ubuntu-geoip/MAXMIND_VERSIONS ubuntu-geoip/MAXMIND_VERSIONS.new
	-rm -rf ubuntu-geoip/databases
