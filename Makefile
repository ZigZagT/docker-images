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

# Per-arch build support: set TAG_SUFFIX=-amd64 or -arm64 for split builds
TAG_SUFFIX ?=
# Architectures to merge (used by merge-* targets)
ARCHS ?= amd64 arm64

# Buildx specific
PLATFORM ?= linux/amd64,linux/arm64
BUILDX_CMD = docker buildx build --platform $(PLATFORM)
ifeq ($(PUSH),true)
	BUILDX_CMD += --push
endif

.PHONY: all ubuntu ubuntu-nodejs ubuntu-rust ubuntu-geoip ubuntu-geoip-download ubuntu-geoip-build dnsmasq-exporter shadowsocks dnsmasq qemu cloud-hypervisor sqitch-pg wait-for-pg clean
.PHONY: merge-ubuntu merge-ubuntu-nodejs merge-ubuntu-rust merge-ubuntu-geoip merge-shadowsocks merge-dnsmasq merge-qemu merge-cloud-hypervisor merge-dnsmasq-exporter merge-sqitch-pg merge-wait-for-pg

# Default target
all: ubuntu ubuntu-nodejs ubuntu-rust ubuntu-geoip dnsmasq-exporter shadowsocks dnsmasq qemu cloud-hypervisor sqitch-pg wait-for-pg
all-ubuntu: ubuntu ubuntu-nodejs ubuntu-rust

ubuntu:
	@for tag in $(UPSTREAM_TAGS); do \
		echo "Building ubuntu:$$tag$(TAG_SUFFIX)"; \
		tags="-t $(DOCKERHUB_USERNAME)/ubuntu:$$tag$(TAG_SUFFIX)"; \
		if [ "$$tag" = "$(LATEST_TAG)" ]; then \
			tags="$$tags -t $(DOCKERHUB_USERNAME)/ubuntu:latest$(TAG_SUFFIX)"; \
		fi; \
		$(BUILDX_CMD) \
			--build-arg UPSTREAM_TAG=$$tag \
			--build-arg TZ="$(TZ)" \
			--build-arg APT_MIRROR="$(APT_MIRROR)" \
			$$tags \
			--cache-from $(DOCKERHUB_USERNAME)/ubuntu:$$tag$(TAG_SUFFIX) \
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
			echo "Building ubuntu:$$ubuntu-nodejs-$$nodejs$(TAG_SUFFIX)"; \
			tags="-t $(DOCKERHUB_USERNAME)/ubuntu:$$ubuntu-nodejs-$$nodejs$(TAG_SUFFIX)"; \
			if [ "$$nodejs" = "$(DEFAULT_NODEJS_VERSION)" ]; then \
				tags="$$tags -t $(DOCKERHUB_USERNAME)/ubuntu:$$ubuntu-nodejs$(TAG_SUFFIX)"; \
			fi; \
			if [ "$$ubuntu" = "$(LATEST_TAG)" ]; then \
				tags="$$tags -t $(DOCKERHUB_USERNAME)/ubuntu:nodejs-$$nodejs$(TAG_SUFFIX)"; \
				if [ "$$nodejs" = "$(DEFAULT_NODEJS_VERSION)" ]; then \
					tags="$$tags -t $(DOCKERHUB_USERNAME)/ubuntu:nodejs$(TAG_SUFFIX)"; \
				fi; \
			fi; \
			$(BUILDX_CMD) \
				--build-arg BASE_IMAGE=$(DOCKERHUB_USERNAME)/ubuntu:$$ubuntu$(TAG_SUFFIX) \
				--build-arg NODE_VERSION=$$nodejs \
				$$tags \
				-f ubuntu/Dockerfile.nodejs \
				ubuntu; \
		done \
	done

ubuntu-rust:
	@for ubuntu in $(UPSTREAM_TAGS); do \
		echo "Building ubuntu:$$ubuntu-rust$(TAG_SUFFIX)"; \
		tags="-t $(DOCKERHUB_USERNAME)/ubuntu:$$ubuntu-rust$(TAG_SUFFIX)"; \
		if [ "$$ubuntu" = "$(LATEST_TAG)" ]; then \
			tags="$$tags -t $(DOCKERHUB_USERNAME)/ubuntu:rust$(TAG_SUFFIX)"; \
		fi; \
		$(BUILDX_CMD) \
			--build-arg BASE_IMAGE=$(DOCKERHUB_USERNAME)/ubuntu:$$ubuntu$(TAG_SUFFIX) \
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
		echo "Building ubuntu-geoip:$$tag$(TAG_SUFFIX)"; \
		tags="-t $(DOCKERHUB_USERNAME)/ubuntu-geoip:$$tag$(TAG_SUFFIX)"; \
		if [ "$$tag" = "$(LATEST_TAG)" ]; then \
			tags="$$tags -t $(DOCKERHUB_USERNAME)/ubuntu-geoip:latest$(TAG_SUFFIX)"; \
		fi; \
		$(BUILDX_CMD) \
			--build-arg BASE_IMAGE=$(DOCKERHUB_USERNAME)/ubuntu:$$tag$(TAG_SUFFIX) \
			$$tags \
			--cache-from $(DOCKERHUB_USERNAME)/ubuntu-geoip:$$tag$(TAG_SUFFIX) \
			ubuntu-geoip; \
	done

shadowsocks:
	@echo "Building shadowsocks$(TAG_SUFFIX)..."
	$(BUILDX_CMD) \
		--build-arg BASE_IMAGE=$(DOCKERHUB_USERNAME)/ubuntu:rust$(TAG_SUFFIX) \
		--build-arg RUNTIME_IMAGE=$(DOCKERHUB_USERNAME)/ubuntu:$(LATEST_TAG)$(TAG_SUFFIX) \
		-t $(DOCKERHUB_USERNAME)/shadowsocks:latest$(TAG_SUFFIX) \
		shadowsocks

dnsmasq:
	@echo "Building dnsmasq$(TAG_SUFFIX)..."
	$(BUILDX_CMD) \
		--build-arg BASE_IMAGE=$(DOCKERHUB_USERNAME)/ubuntu:$(LATEST_TAG)$(TAG_SUFFIX) \
		-t $(DOCKERHUB_USERNAME)/dnsmasq:latest$(TAG_SUFFIX) \
		dnsmasq

qemu:
	@EDGE_VERSION=$$(./scripts/get-latest-qemu-version.sh); \
	ALL_VERSIONS="$(QEMU_VERSIONS)"; \
	if ! echo " $$ALL_VERSIONS " | grep -q " $$EDGE_VERSION "; then \
		ALL_VERSIONS="$$ALL_VERSIONS $$EDGE_VERSION"; \
	fi; \
	for ver in $$ALL_VERSIONS; do \
		echo "Building qemu:$$ver$(TAG_SUFFIX)"; \
		tags="-t $(DOCKERHUB_USERNAME)/qemu:$$ver$(TAG_SUFFIX)"; \
		if [ "$$ver" = "$(QEMU_LATEST)" ]; then \
			tags="$$tags -t $(DOCKERHUB_USERNAME)/qemu:latest$(TAG_SUFFIX)"; \
		fi; \
		if [ "$$ver" = "$$EDGE_VERSION" ]; then \
			tags="$$tags -t $(DOCKERHUB_USERNAME)/qemu:edge$(TAG_SUFFIX)"; \
		fi; \
		$(BUILDX_CMD) \
			--build-arg BASE_IMAGE=$(DOCKERHUB_USERNAME)/ubuntu:$(LATEST_TAG)$(TAG_SUFFIX) \
			--build-arg QEMU_VERSION=$$ver \
			$$tags \
			--cache-from $(DOCKERHUB_USERNAME)/qemu:$$ver$(TAG_SUFFIX) \
			qemu; \
	done

cloud-hypervisor:
	@EDGE_VERSION=$$(./scripts/get-latest-cloud-hypervisor-version.sh); \
	ALL_VERSIONS="$(CH_VERSIONS)"; \
	if ! echo " $$ALL_VERSIONS " | grep -q " $$EDGE_VERSION "; then \
		ALL_VERSIONS="$$ALL_VERSIONS $$EDGE_VERSION"; \
	fi; \
	for ver in $$ALL_VERSIONS; do \
		echo "Building cloud-hypervisor:$$ver$(TAG_SUFFIX)"; \
		tags="-t $(DOCKERHUB_USERNAME)/cloud-hypervisor:$$ver$(TAG_SUFFIX)"; \
		if [ "$$ver" = "$(CH_LATEST)" ]; then \
			tags="$$tags -t $(DOCKERHUB_USERNAME)/cloud-hypervisor:latest$(TAG_SUFFIX)"; \
		fi; \
		if [ "$$ver" = "$$EDGE_VERSION" ]; then \
			tags="$$tags -t $(DOCKERHUB_USERNAME)/cloud-hypervisor:edge$(TAG_SUFFIX)"; \
		fi; \
		$(BUILDX_CMD) \
			--build-arg BASE_IMAGE=$(DOCKERHUB_USERNAME)/ubuntu:$(LATEST_TAG)$(TAG_SUFFIX) \
			--build-arg CH_VERSION=$$ver \
			$$tags \
			--cache-from $(DOCKERHUB_USERNAME)/cloud-hypervisor:$$ver$(TAG_SUFFIX) \
			cloud-hypervisor; \
	done

dnsmasq-exporter:
	@echo "Building dnsmasq_exporter$(TAG_SUFFIX)..."
	$(BUILDX_CMD) \
		-t $(DOCKERHUB_USERNAME)/dnsmasq_exporter:latest$(TAG_SUFFIX) \
		dnsmasq_exporter

sqitch-pg:
	@echo "Building sqitch-pg$(TAG_SUFFIX)..."
	$(BUILDX_CMD) \
		-t $(DOCKERHUB_USERNAME)/sqitch-pg:latest$(TAG_SUFFIX) \
		sqitch-pg

wait-for-pg:
	@echo "Building wait-for-pg$(TAG_SUFFIX)..."
	$(BUILDX_CMD) \
		-t $(DOCKERHUB_USERNAME)/wait-for-pg:latest$(TAG_SUFFIX) \
		wait-for-pg

clean:
	@echo "Cleaning up..."
	-rm -f ubuntu-geoip/MAXMIND_VERSIONS ubuntu-geoip/MAXMIND_VERSIONS.new
	-rm -rf ubuntu-geoip/databases

# --- Manifest merge targets ---
# Combine per-arch tags into multi-arch manifests after split builds.
# Usage: make merge-ubuntu DOCKERHUB_USERNAME=deaddev

merge-ubuntu:
	@for tag in $(UPSTREAM_TAGS); do \
		echo "Merging ubuntu:$$tag"; \
		docker buildx imagetools create \
			-t $(DOCKERHUB_USERNAME)/ubuntu:$$tag \
			$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/ubuntu:$$tag-$(arch)); \
		if [ "$$tag" = "$(LATEST_TAG)" ]; then \
			docker buildx imagetools create \
				-t $(DOCKERHUB_USERNAME)/ubuntu:latest \
				$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/ubuntu:latest-$(arch)); \
		fi; \
	done

merge-ubuntu-nodejs:
	@for ubuntu in $(UPSTREAM_TAGS); do \
		for nodejs in $(NODEJS_VERSIONS); do \
			docker buildx imagetools create \
				-t $(DOCKERHUB_USERNAME)/ubuntu:$$ubuntu-nodejs-$$nodejs \
				$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/ubuntu:$$ubuntu-nodejs-$$nodejs-$(arch)); \
			if [ "$$nodejs" = "$(DEFAULT_NODEJS_VERSION)" ]; then \
				docker buildx imagetools create \
					-t $(DOCKERHUB_USERNAME)/ubuntu:$$ubuntu-nodejs \
					$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/ubuntu:$$ubuntu-nodejs-$(arch)); \
			fi; \
			if [ "$$ubuntu" = "$(LATEST_TAG)" ]; then \
				docker buildx imagetools create \
					-t $(DOCKERHUB_USERNAME)/ubuntu:nodejs-$$nodejs \
					$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/ubuntu:nodejs-$$nodejs-$(arch)); \
				if [ "$$nodejs" = "$(DEFAULT_NODEJS_VERSION)" ]; then \
					docker buildx imagetools create \
						-t $(DOCKERHUB_USERNAME)/ubuntu:nodejs \
						$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/ubuntu:nodejs-$(arch)); \
				fi; \
			fi; \
		done; \
	done

merge-ubuntu-rust:
	@for ubuntu in $(UPSTREAM_TAGS); do \
		docker buildx imagetools create \
			-t $(DOCKERHUB_USERNAME)/ubuntu:$$ubuntu-rust \
			$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/ubuntu:$$ubuntu-rust-$(arch)); \
		if [ "$$ubuntu" = "$(LATEST_TAG)" ]; then \
			docker buildx imagetools create \
				-t $(DOCKERHUB_USERNAME)/ubuntu:rust \
				$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/ubuntu:rust-$(arch)); \
		fi; \
	done

merge-ubuntu-geoip:
	@for tag in $(UPSTREAM_TAGS); do \
		docker buildx imagetools create \
			-t $(DOCKERHUB_USERNAME)/ubuntu-geoip:$$tag \
			$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/ubuntu-geoip:$$tag-$(arch)); \
		if [ "$$tag" = "$(LATEST_TAG)" ]; then \
			docker buildx imagetools create \
				-t $(DOCKERHUB_USERNAME)/ubuntu-geoip:latest \
				$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/ubuntu-geoip:latest-$(arch)); \
		fi; \
	done

merge-shadowsocks:
	@docker buildx imagetools create \
		-t $(DOCKERHUB_USERNAME)/shadowsocks:latest \
		$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/shadowsocks:latest-$(arch))

merge-dnsmasq:
	@docker buildx imagetools create \
		-t $(DOCKERHUB_USERNAME)/dnsmasq:latest \
		$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/dnsmasq:latest-$(arch))

merge-qemu:
	@EDGE_VERSION=$$(./scripts/get-latest-qemu-version.sh); \
	ALL_VERSIONS="$(QEMU_VERSIONS)"; \
	if ! echo " $$ALL_VERSIONS " | grep -q " $$EDGE_VERSION "; then \
		ALL_VERSIONS="$$ALL_VERSIONS $$EDGE_VERSION"; \
	fi; \
	for ver in $$ALL_VERSIONS; do \
		echo "Merging qemu:$$ver"; \
		docker buildx imagetools create \
			-t $(DOCKERHUB_USERNAME)/qemu:$$ver \
			$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/qemu:$$ver-$(arch)); \
		if [ "$$ver" = "$(QEMU_LATEST)" ]; then \
			docker buildx imagetools create \
				-t $(DOCKERHUB_USERNAME)/qemu:latest \
				$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/qemu:latest-$(arch)); \
		fi; \
		if [ "$$ver" = "$$EDGE_VERSION" ]; then \
			docker buildx imagetools create \
				-t $(DOCKERHUB_USERNAME)/qemu:edge \
				$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/qemu:edge-$(arch)); \
		fi; \
	done

merge-cloud-hypervisor:
	@EDGE_VERSION=$$(./scripts/get-latest-cloud-hypervisor-version.sh); \
	ALL_VERSIONS="$(CH_VERSIONS)"; \
	if ! echo " $$ALL_VERSIONS " | grep -q " $$EDGE_VERSION "; then \
		ALL_VERSIONS="$$ALL_VERSIONS $$EDGE_VERSION"; \
	fi; \
	for ver in $$ALL_VERSIONS; do \
		echo "Merging cloud-hypervisor:$$ver"; \
		docker buildx imagetools create \
			-t $(DOCKERHUB_USERNAME)/cloud-hypervisor:$$ver \
			$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/cloud-hypervisor:$$ver-$(arch)); \
		if [ "$$ver" = "$(CH_LATEST)" ]; then \
			docker buildx imagetools create \
				-t $(DOCKERHUB_USERNAME)/cloud-hypervisor:latest \
				$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/cloud-hypervisor:latest-$(arch)); \
		fi; \
		if [ "$$ver" = "$$EDGE_VERSION" ]; then \
			docker buildx imagetools create \
				-t $(DOCKERHUB_USERNAME)/cloud-hypervisor:edge \
				$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/cloud-hypervisor:edge-$(arch)); \
		fi; \
	done

merge-dnsmasq-exporter:
	@docker buildx imagetools create \
		-t $(DOCKERHUB_USERNAME)/dnsmasq_exporter:latest \
		$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/dnsmasq_exporter:latest-$(arch))

merge-sqitch-pg:
	@docker buildx imagetools create \
		-t $(DOCKERHUB_USERNAME)/sqitch-pg:latest \
		$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/sqitch-pg:latest-$(arch))

merge-wait-for-pg:
	@docker buildx imagetools create \
		-t $(DOCKERHUB_USERNAME)/wait-for-pg:latest \
		$(foreach arch,$(ARCHS),$(DOCKERHUB_USERNAME)/wait-for-pg:latest-$(arch))
