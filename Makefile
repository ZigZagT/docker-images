SHELL := /bin/bash

# Default arguments
UPSTREAM_TAGS ?= 22.04 24.04 26.04
LATEST_TAG ?= 24.04
NODEJS_VERSIONS ?= 22 24
DEFAULT_NODEJS_VERSION ?= 24
TZ ?= America/Vancouver
APT_MIRROR ?=
REGISTRIES ?= ghcr.io/zigzagt deaddev
PUSH ?= false
QEMU_VERSIONS ?= 10.2.1
QEMU_LATEST ?= 10.2.1
CH_VERSIONS ?= 51.1
CH_LATEST ?= 51.1

# Per-arch build support: set TAG_SUFFIX=-amd64 or -arm64 for split builds
TAG_SUFFIX ?=
# Architectures to merge (used by merge-* targets)
ARCHS ?= amd64 arm64
CACHE_REGISTRY = $(firstword $(REGISTRIES))

# Buildx specific
PLATFORM ?= linux/amd64,linux/arm64
BUILDX_CMD = docker buildx build --platform $(PLATFORM)
ifeq ($(PUSH),true)
	BUILDX_CMD += --push
endif

.PHONY: all ubuntu ubuntu-nodejs ubuntu-rust ubuntu-bun ubuntu-geoip ubuntu-geoip-download ubuntu-geoip-build dnsmasq-exporter shadowsocks dnsmasq qemu cloud-hypervisor browser sqitch-pg wait-for-pg clean remove-test-browser start-test-browser run-browser-test
.PHONY: merge-ubuntu merge-ubuntu-nodejs merge-ubuntu-rust merge-ubuntu-bun merge-ubuntu-geoip merge-shadowsocks merge-dnsmasq merge-browser merge-qemu merge-cloud-hypervisor merge-dnsmasq-exporter merge-sqitch-pg merge-wait-for-pg

# Default target
all: ubuntu ubuntu-nodejs ubuntu-rust ubuntu-bun ubuntu-geoip dnsmasq-exporter shadowsocks dnsmasq qemu cloud-hypervisor browser sqitch-pg wait-for-pg
all-ubuntu: ubuntu ubuntu-nodejs ubuntu-rust ubuntu-bun

ubuntu:
	@for tag in $(UPSTREAM_TAGS); do \
		echo "Building ubuntu:$$tag$(TAG_SUFFIX)"; \
		tags=""; \
		for reg in $(REGISTRIES); do \
			tags="$$tags -t $$reg/ubuntu:$$tag$(TAG_SUFFIX)"; \
			if [ "$$tag" = "$(LATEST_TAG)" ]; then \
				tags="$$tags -t $$reg/ubuntu:latest$(TAG_SUFFIX)"; \
			fi; \
		done; \
		$(BUILDX_CMD) \
			--build-arg UPSTREAM_TAG=$$tag \
			--build-arg TZ="$(TZ)" \
			--build-arg APT_MIRROR="$(APT_MIRROR)" \
			$$tags \
			--cache-from $(CACHE_REGISTRY)/ubuntu:$$tag$(TAG_SUFFIX) \
			ubuntu; \
	done

BROWSER_TEST_IMAGE ?= $(CACHE_REGISTRY)/browser:latest
BROWSER_TEST_CONTAINER ?= browser-test

TESTS ?=
BRIDGE_LOG ?= info

remove-test-browser:
	@docker rm -f $(BROWSER_TEST_CONTAINER) 2>/dev/null || true

start-test-browser:
	@docker rm -f $(BROWSER_TEST_CONTAINER) 2>/dev/null || true
	@echo "Starting $(BROWSER_TEST_CONTAINER)..."
	@docker run -d --name $(BROWSER_TEST_CONTAINER) --shm-size=2g \
		-p 6080:6080 -p 18800:18800 \
		-e BRIDGE_LOG=$(BRIDGE_LOG) \
		-v $(CURDIR)/browser/browser-bridge/server.mjs:/opt/browser-bridge/server.mjs:ro \
		-v $(CURDIR)/browser/browser-bridge/mcp.mjs:/opt/browser-bridge/mcp.mjs:ro \
		-v $(CURDIR)/browser/browser-bridge/index.html:/opt/browser-bridge/index.html:ro \
		-v $(CURDIR)/browser/browser-bridge/tests:/opt/browser-bridge/tests:ro \
		$(BROWSER_TEST_IMAGE)
	@printf 'Waiting for bridge'
	@for i in $$(seq 1 30); do \
		docker exec $(BROWSER_TEST_CONTAINER) \
			node -e "require('http').get('http://127.0.0.1:6080/',r=>{r.resume();r.on('end',()=>process.exit(0))}).on('error',()=>process.exit(1))" \
			2>/dev/null && break; \
		printf '.'; sleep 1; \
	done
	@echo ' ready'

run-browser-test: remove-test-browser start-test-browser
	docker exec -w /opt/browser-bridge $(BROWSER_TEST_CONTAINER) node tests/run-all.mjs $(TESTS)

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
			tags=""; \
			for reg in $(REGISTRIES); do \
				tags="$$tags -t $$reg/ubuntu:$$ubuntu-nodejs-$$nodejs$(TAG_SUFFIX)"; \
				if [ "$$nodejs" = "$(DEFAULT_NODEJS_VERSION)" ]; then \
					tags="$$tags -t $$reg/ubuntu:$$ubuntu-nodejs$(TAG_SUFFIX)"; \
				fi; \
				if [ "$$ubuntu" = "$(LATEST_TAG)" ]; then \
					tags="$$tags -t $$reg/ubuntu:nodejs-$$nodejs$(TAG_SUFFIX)"; \
					if [ "$$nodejs" = "$(DEFAULT_NODEJS_VERSION)" ]; then \
						tags="$$tags -t $$reg/ubuntu:nodejs$(TAG_SUFFIX)"; \
					fi; \
				fi; \
			done; \
			$(BUILDX_CMD) \
				--build-arg BASE_IMAGE=$(CACHE_REGISTRY)/ubuntu:$$ubuntu$(TAG_SUFFIX) \
				--build-arg NODE_VERSION=$$nodejs \
				$$tags \
				-f ubuntu/Dockerfile.nodejs \
				ubuntu; \
		done \
	done

ubuntu-rust:
	@for ubuntu in $(UPSTREAM_TAGS); do \
		echo "Building ubuntu:$$ubuntu-rust$(TAG_SUFFIX)"; \
		tags=""; \
		for reg in $(REGISTRIES); do \
			tags="$$tags -t $$reg/ubuntu:$$ubuntu-rust$(TAG_SUFFIX)"; \
			if [ "$$ubuntu" = "$(LATEST_TAG)" ]; then \
				tags="$$tags -t $$reg/ubuntu:rust$(TAG_SUFFIX)"; \
			fi; \
		done; \
		$(BUILDX_CMD) \
			--build-arg BASE_IMAGE=$(CACHE_REGISTRY)/ubuntu:$$ubuntu$(TAG_SUFFIX) \
			--build-arg RUST_VERSION=stable \
			$$tags \
			-f ubuntu/Dockerfile.rust \
			ubuntu; \
	done

ubuntu-bun:
	@for ubuntu in $(UPSTREAM_TAGS); do \
		echo "Building ubuntu:$$ubuntu-bun$(TAG_SUFFIX)"; \
		tags=""; \
		for reg in $(REGISTRIES); do \
			tags="$$tags -t $$reg/ubuntu:$$ubuntu-bun$(TAG_SUFFIX)"; \
			if [ "$$ubuntu" = "$(LATEST_TAG)" ]; then \
				tags="$$tags -t $$reg/ubuntu:bun$(TAG_SUFFIX)"; \
			fi; \
		done; \
		$(BUILDX_CMD) \
			--build-arg BASE_IMAGE=$(CACHE_REGISTRY)/ubuntu:$$ubuntu$(TAG_SUFFIX) \
			$$tags \
			-f ubuntu/Dockerfile.bun \
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
		tags=""; \
		for reg in $(REGISTRIES); do \
			tags="$$tags -t $$reg/ubuntu-geoip:$$tag$(TAG_SUFFIX)"; \
			if [ "$$tag" = "$(LATEST_TAG)" ]; then \
				tags="$$tags -t $$reg/ubuntu-geoip:latest$(TAG_SUFFIX)"; \
			fi; \
		done; \
		$(BUILDX_CMD) \
			--build-arg BASE_IMAGE=$(CACHE_REGISTRY)/ubuntu:$$tag$(TAG_SUFFIX) \
			$$tags \
			--cache-from $(CACHE_REGISTRY)/ubuntu-geoip:$$tag$(TAG_SUFFIX) \
			ubuntu-geoip; \
	done

shadowsocks:
	@echo "Building shadowsocks$(TAG_SUFFIX)..."
	@tags=""; \
	for reg in $(REGISTRIES); do \
		tags="$$tags -t $$reg/shadowsocks:latest$(TAG_SUFFIX)"; \
	done; \
	$(BUILDX_CMD) \
		--build-arg BASE_IMAGE=$(CACHE_REGISTRY)/ubuntu:rust$(TAG_SUFFIX) \
		--build-arg RUNTIME_IMAGE=$(CACHE_REGISTRY)/ubuntu:$(LATEST_TAG)$(TAG_SUFFIX) \
		$$tags \
		shadowsocks

browser:
	@echo "Building browser$(TAG_SUFFIX)..."
	@tags=""; \
	for reg in $(REGISTRIES); do \
		tags="$$tags -t $$reg/browser:latest$(TAG_SUFFIX)"; \
		tags="$$tags -t $$reg/browser:chrome$(TAG_SUFFIX)"; \
		tags="$$tags -t $$reg/browser:chromium$(TAG_SUFFIX)"; \
	done; \
	$(BUILDX_CMD) \
		--build-arg BASE_IMAGE=$(CACHE_REGISTRY)/ubuntu:nodejs$(TAG_SUFFIX) \
		$$tags \
		--cache-from $(CACHE_REGISTRY)/browser:latest$(TAG_SUFFIX) \
		browser

dnsmasq:
	@echo "Building dnsmasq$(TAG_SUFFIX)..."
	@tags=""; \
	for reg in $(REGISTRIES); do \
		tags="$$tags -t $$reg/dnsmasq:latest$(TAG_SUFFIX)"; \
	done; \
	$(BUILDX_CMD) \
		--build-arg BASE_IMAGE=$(CACHE_REGISTRY)/ubuntu:$(LATEST_TAG)$(TAG_SUFFIX) \
		$$tags \
		dnsmasq

qemu:
	@EDGE_VERSION=$$(./scripts/get-latest-qemu-version.sh); \
	ALL_VERSIONS="$(QEMU_VERSIONS)"; \
	if ! echo " $$ALL_VERSIONS " | grep -q " $$EDGE_VERSION "; then \
		ALL_VERSIONS="$$ALL_VERSIONS $$EDGE_VERSION"; \
	fi; \
	for ver in $$ALL_VERSIONS; do \
		echo "Building qemu:$$ver$(TAG_SUFFIX)"; \
		tags=""; \
		for reg in $(REGISTRIES); do \
			tags="$$tags -t $$reg/qemu:$$ver$(TAG_SUFFIX)"; \
			if [ "$$ver" = "$(QEMU_LATEST)" ]; then \
				tags="$$tags -t $$reg/qemu:latest$(TAG_SUFFIX)"; \
			fi; \
			if [ "$$ver" = "$$EDGE_VERSION" ]; then \
				tags="$$tags -t $$reg/qemu:edge$(TAG_SUFFIX)"; \
			fi; \
		done; \
		$(BUILDX_CMD) \
			--build-arg BASE_IMAGE=$(CACHE_REGISTRY)/ubuntu:$(LATEST_TAG)$(TAG_SUFFIX) \
			--build-arg QEMU_VERSION=$$ver \
			$$tags \
			--cache-from $(CACHE_REGISTRY)/qemu:$$ver$(TAG_SUFFIX) \
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
		tags=""; \
		for reg in $(REGISTRIES); do \
			tags="$$tags -t $$reg/cloud-hypervisor:$$ver$(TAG_SUFFIX)"; \
			if [ "$$ver" = "$(CH_LATEST)" ]; then \
				tags="$$tags -t $$reg/cloud-hypervisor:latest$(TAG_SUFFIX)"; \
			fi; \
			if [ "$$ver" = "$$EDGE_VERSION" ]; then \
				tags="$$tags -t $$reg/cloud-hypervisor:edge$(TAG_SUFFIX)"; \
			fi; \
		done; \
		$(BUILDX_CMD) \
			--build-arg BASE_IMAGE=$(CACHE_REGISTRY)/ubuntu:$(LATEST_TAG)$(TAG_SUFFIX) \
			--build-arg CH_VERSION=$$ver \
			$$tags \
			--cache-from $(CACHE_REGISTRY)/cloud-hypervisor:$$ver$(TAG_SUFFIX) \
			cloud-hypervisor; \
	done

dnsmasq-exporter:
	@echo "Building dnsmasq_exporter$(TAG_SUFFIX)..."
	@tags=""; \
	for reg in $(REGISTRIES); do \
		tags="$$tags -t $$reg/dnsmasq_exporter:latest$(TAG_SUFFIX)"; \
	done; \
	$(BUILDX_CMD) \
		$$tags \
		dnsmasq_exporter

sqitch-pg:
	@echo "Building sqitch-pg$(TAG_SUFFIX)..."
	@tags=""; \
	for reg in $(REGISTRIES); do \
		tags="$$tags -t $$reg/sqitch-pg:latest$(TAG_SUFFIX)"; \
	done; \
	$(BUILDX_CMD) \
		$$tags \
		sqitch-pg

wait-for-pg:
	@echo "Building wait-for-pg$(TAG_SUFFIX)..."
	@tags=""; \
	for reg in $(REGISTRIES); do \
		tags="$$tags -t $$reg/wait-for-pg:latest$(TAG_SUFFIX)"; \
	done; \
	$(BUILDX_CMD) \
		$$tags \
		wait-for-pg

clean:
	@echo "Cleaning up..."
	-rm -f ubuntu-geoip/MAXMIND_VERSIONS ubuntu-geoip/MAXMIND_VERSIONS.new
	-rm -rf ubuntu-geoip/databases

# --- Manifest merge targets ---
# Combine per-arch tags into multi-arch manifests after split builds.

merge-ubuntu:
	@for tag in $(UPSTREAM_TAGS); do \
		echo "Merging ubuntu:$$tag"; \
		sources=""; \
		for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/ubuntu:$$tag-$$arch"; done; \
		for reg in $(REGISTRIES); do \
			docker buildx imagetools create -t $$reg/ubuntu:$$tag $$sources; \
		done; \
		if [ "$$tag" = "$(LATEST_TAG)" ]; then \
			sources=""; \
			for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/ubuntu:latest-$$arch"; done; \
			for reg in $(REGISTRIES); do \
				docker buildx imagetools create -t $$reg/ubuntu:latest $$sources; \
			done; \
		fi; \
	done

merge-ubuntu-nodejs:
	@for ubuntu in $(UPSTREAM_TAGS); do \
		for nodejs in $(NODEJS_VERSIONS); do \
			sources=""; \
			for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/ubuntu:$$ubuntu-nodejs-$$nodejs-$$arch"; done; \
			for reg in $(REGISTRIES); do \
				docker buildx imagetools create -t $$reg/ubuntu:$$ubuntu-nodejs-$$nodejs $$sources; \
			done; \
			if [ "$$nodejs" = "$(DEFAULT_NODEJS_VERSION)" ]; then \
				sources=""; \
				for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/ubuntu:$$ubuntu-nodejs-$$arch"; done; \
				for reg in $(REGISTRIES); do \
					docker buildx imagetools create -t $$reg/ubuntu:$$ubuntu-nodejs $$sources; \
				done; \
			fi; \
			if [ "$$ubuntu" = "$(LATEST_TAG)" ]; then \
				sources=""; \
				for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/ubuntu:nodejs-$$nodejs-$$arch"; done; \
				for reg in $(REGISTRIES); do \
					docker buildx imagetools create -t $$reg/ubuntu:nodejs-$$nodejs $$sources; \
				done; \
				if [ "$$nodejs" = "$(DEFAULT_NODEJS_VERSION)" ]; then \
					sources=""; \
					for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/ubuntu:nodejs-$$arch"; done; \
					for reg in $(REGISTRIES); do \
						docker buildx imagetools create -t $$reg/ubuntu:nodejs $$sources; \
					done; \
				fi; \
			fi; \
		done; \
	done

merge-ubuntu-rust:
	@for ubuntu in $(UPSTREAM_TAGS); do \
		sources=""; \
		for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/ubuntu:$$ubuntu-rust-$$arch"; done; \
		for reg in $(REGISTRIES); do \
			docker buildx imagetools create -t $$reg/ubuntu:$$ubuntu-rust $$sources; \
		done; \
		if [ "$$ubuntu" = "$(LATEST_TAG)" ]; then \
			sources=""; \
			for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/ubuntu:rust-$$arch"; done; \
			for reg in $(REGISTRIES); do \
				docker buildx imagetools create -t $$reg/ubuntu:rust $$sources; \
			done; \
		fi; \
	done

merge-ubuntu-bun:
	@for ubuntu in $(UPSTREAM_TAGS); do \
		sources=""; \
		for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/ubuntu:$$ubuntu-bun-$$arch"; done; \
		for reg in $(REGISTRIES); do \
			docker buildx imagetools create -t $$reg/ubuntu:$$ubuntu-bun $$sources; \
		done; \
		if [ "$$ubuntu" = "$(LATEST_TAG)" ]; then \
			sources=""; \
			for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/ubuntu:bun-$$arch"; done; \
			for reg in $(REGISTRIES); do \
				docker buildx imagetools create -t $$reg/ubuntu:bun $$sources; \
			done; \
		fi; \
	done

merge-ubuntu-geoip:
	@for tag in $(UPSTREAM_TAGS); do \
		sources=""; \
		for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/ubuntu-geoip:$$tag-$$arch"; done; \
		for reg in $(REGISTRIES); do \
			docker buildx imagetools create -t $$reg/ubuntu-geoip:$$tag $$sources; \
		done; \
		if [ "$$tag" = "$(LATEST_TAG)" ]; then \
			sources=""; \
			for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/ubuntu-geoip:latest-$$arch"; done; \
			for reg in $(REGISTRIES); do \
				docker buildx imagetools create -t $$reg/ubuntu-geoip:latest $$sources; \
			done; \
		fi; \
	done

merge-shadowsocks:
	@sources=""; \
	for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/shadowsocks:latest-$$arch"; done; \
	for reg in $(REGISTRIES); do \
		docker buildx imagetools create -t $$reg/shadowsocks:latest $$sources; \
	done

merge-dnsmasq:
	@sources=""; \
	for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/dnsmasq:latest-$$arch"; done; \
	for reg in $(REGISTRIES); do \
		docker buildx imagetools create -t $$reg/dnsmasq:latest $$sources; \
	done

merge-browser:
	@sources=""; \
	for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/browser:latest-$$arch"; done; \
	for reg in $(REGISTRIES); do \
		docker buildx imagetools create -t $$reg/browser:latest $$sources; \
		docker buildx imagetools create -t $$reg/browser:chrome $$sources; \
		docker buildx imagetools create -t $$reg/browser:chromium $$sources; \
	done

merge-qemu:
	@EDGE_VERSION=$$(./scripts/get-latest-qemu-version.sh); \
	ALL_VERSIONS="$(QEMU_VERSIONS)"; \
	if ! echo " $$ALL_VERSIONS " | grep -q " $$EDGE_VERSION "; then \
		ALL_VERSIONS="$$ALL_VERSIONS $$EDGE_VERSION"; \
	fi; \
	for ver in $$ALL_VERSIONS; do \
		echo "Merging qemu:$$ver"; \
		sources=""; \
		for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/qemu:$$ver-$$arch"; done; \
		for reg in $(REGISTRIES); do \
			docker buildx imagetools create -t $$reg/qemu:$$ver $$sources; \
		done; \
		if [ "$$ver" = "$(QEMU_LATEST)" ]; then \
			sources=""; \
			for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/qemu:latest-$$arch"; done; \
			for reg in $(REGISTRIES); do \
				docker buildx imagetools create -t $$reg/qemu:latest $$sources; \
			done; \
		fi; \
		if [ "$$ver" = "$$EDGE_VERSION" ]; then \
			sources=""; \
			for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/qemu:edge-$$arch"; done; \
			for reg in $(REGISTRIES); do \
				docker buildx imagetools create -t $$reg/qemu:edge $$sources; \
			done; \
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
		sources=""; \
		for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/cloud-hypervisor:$$ver-$$arch"; done; \
		for reg in $(REGISTRIES); do \
			docker buildx imagetools create -t $$reg/cloud-hypervisor:$$ver $$sources; \
		done; \
		if [ "$$ver" = "$(CH_LATEST)" ]; then \
			sources=""; \
			for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/cloud-hypervisor:latest-$$arch"; done; \
			for reg in $(REGISTRIES); do \
				docker buildx imagetools create -t $$reg/cloud-hypervisor:latest $$sources; \
			done; \
		fi; \
		if [ "$$ver" = "$$EDGE_VERSION" ]; then \
			sources=""; \
			for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/cloud-hypervisor:edge-$$arch"; done; \
			for reg in $(REGISTRIES); do \
				docker buildx imagetools create -t $$reg/cloud-hypervisor:edge $$sources; \
			done; \
		fi; \
	done

merge-dnsmasq-exporter:
	@sources=""; \
	for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/dnsmasq_exporter:latest-$$arch"; done; \
	for reg in $(REGISTRIES); do \
		docker buildx imagetools create -t $$reg/dnsmasq_exporter:latest $$sources; \
	done

merge-sqitch-pg:
	@sources=""; \
	for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/sqitch-pg:latest-$$arch"; done; \
	for reg in $(REGISTRIES); do \
		docker buildx imagetools create -t $$reg/sqitch-pg:latest $$sources; \
	done

merge-wait-for-pg:
	@sources=""; \
	for arch in $(ARCHS); do sources="$$sources $(CACHE_REGISTRY)/wait-for-pg:latest-$$arch"; done; \
	for reg in $(REGISTRIES); do \
		docker buildx imagetools create -t $$reg/wait-for-pg:latest $$sources; \
	done
