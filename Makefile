SHELL := /bin/bash

# Default arguments
UPSTREAM_TAGS ?= 22.04 24.04
LATEST_TAG ?= 24.04
NODEJS_VERSIONS ?= 22 24
DEFAULT_NODEJS_VERSION ?= 24
TZ ?= America/Vancouver
APT_MIRROR ?=
DOCKERHUB_USERNAME ?= deaddev
PUSH ?= false

# Buildx specific
PLATFORM ?= linux/amd64,linux/arm64
BUILDX_CMD = docker buildx build --platform $(PLATFORM)
ifeq ($(PUSH),true)
	BUILDX_CMD += --push
endif

.PHONY: all ubuntu ubuntu-nodejs ubuntu-rust ubuntu-geoip dnsmasq-exporter sqitch-pg wait-for-pg clean

# Default target
all: ubuntu ubuntu-nodejs ubuntu-rust ubuntu-geoip dnsmasq-exporter sqitch-pg wait-for-pg
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

ubuntu-geoip:
	@echo "Checking MaxMind database versions..."
	@cmd="./scripts/get-and-compare-maxmind-versions.sh --key $(or $(MAXMIND_LICENSE_KEY), '') --output ubuntu-geoip/MAXMIND_VERSIONS"; \
	if [ -n "$(MAXMIND_SAVED_VERSION_FILE)" ]; then \
		cmd="$$cmd --input $(MAXMIND_SAVED_VERSION_FILE)"; \
	fi; \
	MAXMIND_VERSION_CHECK_RESULTS=$$($$cmd) || true; \
	if echo "$$MAXMIND_VERSION_CHECK_RESULTS" | grep -q "fetch_failed=true"; then \
		echo "MaxMind download failed or rate limited - must use databases from previous image"; \
		MAXMIND_DB_NO_UPDATE=true; \
	else \
		echo "MaxMind versions check done"; \
		MAXMIND_DB_NO_UPDATE=false; \
	fi; \
	for tag in $(UPSTREAM_TAGS); do \
		echo "Building ubuntu-geoip:$$tag"; \
		tags="-t $(DOCKERHUB_USERNAME)/ubuntu-geoip:$$tag"; \
		if [ "$$tag" = "$(LATEST_TAG)" ]; then \
			tags="$$tags -t $(DOCKERHUB_USERNAME)/ubuntu-geoip:latest"; \
		fi; \
		CACHE_IMAGE=""; \
		if docker buildx imagetools inspect $(DOCKERHUB_USERNAME)/ubuntu-geoip:$$tag >/dev/null 2>&1; then \
			echo "Previous image found, maxmind databases maybe reused from this image"; \
			CACHE_IMAGE=$(DOCKERHUB_USERNAME)/ubuntu-geoip:$$tag; \
		else \
			echo "No previous image found, maxmind databases must be downloaded from internet"; \
			CACHE_IMAGE=$(DOCKERHUB_USERNAME)/ubuntu:$$tag; \
			if [ "$$MAXMIND_DB_NO_UPDATE" = "true" ]; then \
				echo "No previous image found and unable to download from internet, failed to obtain maxmind databases."; \
				exit 1; \
			fi; \
		fi; \
		$(BUILDX_CMD) \
			--build-arg UPSTREAM_TAG=$$tag \
			--build-arg BASE_IMAGE=$(DOCKERHUB_USERNAME)/ubuntu:$$tag \
			--build-arg CACHE_IMAGE="$$CACHE_IMAGE" \
			--build-arg MAXMIND_NO_UPDATE=$$MAXMIND_DB_NO_UPDATE \
			--secret id=maxmind_license_key,env=MAXMIND_LICENSE_KEY \
			$$tags \
			--cache-from $(DOCKERHUB_USERNAME)/ubuntu-geoip:$$tag \
			ubuntu-geoip; \
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
	-rm -f ubuntu-geoip/MAXMIND_VERSIONS
