# Standalone sandbox API Dockerfile (development)
# Boots the sandbox server inside a libkrun microVM with its own kernel.
# Only requires /dev/kvm on the host — no privileged mode, no capabilities.
#
# Build context: services/codeapi/api/  (for standalone) or services/codeapi/ (see note)
# Note: This Dockerfile references ../launcher/ so the build context must be
# the codeapi directory when using docker compose (context: .).

# ============================================================================
# Stage 1: Build NsJail from source
# ============================================================================
FROM buildpack-deps:bookworm AS nsjail-builder

WORKDIR /nsjail

RUN apt-get update && apt-get install -y --no-install-recommends \
    bison \
    flex \
    libprotobuf-dev \
    libnl-route-3-dev \
    protobuf-compiler \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN git clone -b master --single-branch https://github.com/google/nsjail.git . \
    && git checkout 66ad78dc361721512fbf9470488e584364c75489 \
    && git submodule update --init --recursive

RUN make -j$(nproc)

COPY api/src/spec-guard.c /tmp/spec-guard.c
RUN gcc -O2 -static -o /usr/local/bin/spec-guard /tmp/spec-guard.c \
    && chmod 0111 /usr/local/bin/spec-guard

# ============================================================================
# Stage 1b: Build language runtime packages (only consumed by sandbox-runner-baked)
#
# Mirrors docker/Dockerfile.package-init but runs at image-build time so the
# rendered /pkgs tree can be baked into the runner rootfs. Cache key is the
# package-init script + javascript-packages.txt; unchanged inputs reuse this
# layer across runner rebuilds.
# ============================================================================
FROM buildpack-deps:bookworm AS package-builder

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHON_VERSION=3.14.4
ENV BUN_VERSION=1.3.14

COPY docker/apt-install.sh /usr/local/bin/apt-install
RUN chmod +x /usr/local/bin/apt-install

RUN apt-install \
    curl unzip wget ca-certificates \
    build-essential libssl-dev libffi-dev libsqlite3-dev \
    zlib1g-dev libbz2-dev libreadline-dev libncurses5-dev \
    tk-dev xz-utils libcurl4-openssl-dev libfontconfig1-dev \
    libudunits2-dev libpng-dev libxml2-dev libcairo2-dev \
    libfreetype6-dev

RUN mkdir -p /pkgs

COPY docker/package-init.sh /package-init.sh
COPY javascript-packages.txt /javascript-packages.txt
RUN chmod +x /package-init.sh && FORCE_REBUILD=true /package-init.sh

# Pin standalone JavaScript package-manager CLIs for the full-Debian guest.
# Keeping them in their own stage avoids adding npm and its dependency tree to
# the final rootfs while ensuring pnpm and yarn work without a Corepack download.
FROM node:22-slim AS node-cli-tools

RUN rm -f /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && npm install --global pnpm@10.15.1 yarn@1.22.22 \
    && pnpm --version \
    && yarn --version

# ============================================================================
# Stage 2: Build sandbox rootfs
# ============================================================================
FROM oven/bun:1.3.14-debian AS sandbox-common

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    coreutils \
    util-linux \
    bsdextrautils \
    locales \
    procps \
    iptables \
    bc \
    file \
    jq \
    poppler-utils \
    fonts-dejavu \
    fonts-liberation \
    libnl-route-3-200 \
    libprotobuf32 \
    libffi8 \
    ca-certificates \
    curl \
    wget \
    git \
    git-lfs \
    gh \
    openssh-client \
    rsync \
    ripgrep \
    fd-find \
    patch \
    less \
    zip \
    unzip \
    xz-utils \
    bzip2 \
    zstd \
    make \
    gcc \
    g++ \
    clang \
    cmake \
    ninja-build \
    pkg-config \
    binutils \
    sqlite3 \
    iproute2 \
    iputils-ping \
    dnsutils \
    netcat-openbsd \
    socat \
    lsof \
    strace \
    psmisc \
    shellcheck \
    shfmt \
    tree \
    debianutils \
    time \
    && rm -rf /var/lib/apt/lists/* \
    && libffi=$(find /usr/lib -name 'libffi.so.8' -print -quit) \
    && { [ -n "$libffi" ] || { echo "libffi.so.8 not found" >&2; exit 1; }; } \
    && ln -sf "$libffi" "${libffi%.so.8}.so.6"

# Restore the standard Debian `awk` -> `mawk` symlink. mawk is Priority:
# required so its binary is in /usr/bin already, but slim base images skip
# the mawk postinst's `update-alternatives --install /usr/bin/awk awk
# /usr/bin/mawk 5` step that normally creates the user-facing `awk`
# command. Without this, bare `awk ...` in user shell scripts fails with
# `command not found` even though mawk itself is present. Identical
# security surface to the existing pure-text utilities (sed, tr,
# coreutils) — mawk has no system() / getline-from-command extensions
# in its minimal build.
RUN [ -x /usr/bin/mawk ] && ln -sf /usr/bin/mawk /usr/bin/awk \
    && [ -x /usr/bin/fdfind ] && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && [ -x /usr/bin/nc.openbsd ] && ln -sf /usr/bin/nc.openbsd /usr/local/bin/nc \
    && [ -x /usr/bin/which.debianutils ] && ln -sf /usr/bin/which.debianutils /usr/local/bin/which \
    && for command in \
        curl wget git git-lfs gh \
        ssh scp sftp ssh-keygen rsync rg fd patch less \
        zip unzip xz bzip2 zstd make gcc g++ clang cmake ninja pkg-config \
        ld ar objdump sqlite3 ip ss ping dig nslookup host nc socat \
        lsof strace pstree shellcheck shfmt tree which time; do \
        command -v "$command" >/dev/null || { echo "Missing sandbox command: $command" >&2; exit 1; }; \
    done \
    && [ -x /usr/bin/time ]

RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

COPY --from=nsjail-builder /nsjail/nsjail /usr/sbin/nsjail
COPY --from=nsjail-builder /usr/local/bin/spec-guard /usr/local/bin/spec-guard
RUN chmod +x /usr/sbin/nsjail

# The tool-call socket proxy must run under Node, not Bun. Bun's node:http
# compat layer never fires `'connection'` events and Bun.serve's idleTimeout
# does not close silent unix-socket connections — so our DoS protections
# (maxConnections, idleSocketTimeoutMs, accept-time tracking) silently no-op
# under Bun and a `for i in range(N): socket.connect` storm pins FDs in the
# proxy until the OS limit. Pulling just the Node binary from a slim image
# is ~30 MB and avoids inheriting npm/node_modules from a full apt install.
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node

WORKDIR /sandbox_api

COPY api/package.json api/bun.lock ./
RUN bun install --frozen-lockfile

COPY api/tsconfig.json ./
COPY api/src ./src
COPY shared /shared
COPY api/config ./config

RUN bun run build

RUN mkdir -p /pkgs /tmp/sandbox

COPY api/src/entrypoint.sh ./entrypoint.sh
COPY docker/runtime-resolver.sh /usr/local/libexec/codeapi-runtime-resolver.sh
COPY docker/sandbox-pkg /usr/local/bin/sandbox-pkg
COPY docker/full-debian-overlay.sh /usr/local/libexec/codeapi-full-debian-overlay.sh
RUN chmod +x ./entrypoint.sh \
    /usr/local/libexec/codeapi-runtime-resolver.sh \
    /usr/local/libexec/codeapi-full-debian-overlay.sh \
    /usr/local/bin/sandbox-pkg

# Full Debian keeps the normal package-management and administration tools.
# The root disk remains immutable; each MicroVM receives a disposable ext4
# overlay disk at runtime.
FROM sandbox-common AS sandbox-full-debian-build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3-minimal \
        python-is-python3 \
        isc-dhcp-client \
        yq \
        bat \
        fzf \
        libxml2-utils \
        gettext-base \
        inotify-tools \
        universal-ctags \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/local/bin/node /usr/bin/node \
    && ln -sf /usr/local/bin/node /usr/bin/nodejs \
    && ln -sf /usr/bin/batcat /usr/bin/bat \
    && test "$(readlink -f /usr/bin/python)" = "$(readlink -f /usr/bin/python3)" \
    && test "$(readlink -f /usr/bin/node)" = /usr/local/bin/node \
    && test "$(readlink -f /usr/bin/nodejs)" = /usr/local/bin/node \
    && command -v apt >/dev/null \
    && command -v apt-get >/dev/null \
    && command -v bat >/dev/null \
    && command -v ctags >/dev/null \
    && command -v dpkg >/dev/null \
    && command -v dpkg-deb >/dev/null \
    && command -v dhclient >/dev/null \
    && command -v envsubst >/dev/null \
    && command -v fzf >/dev/null \
    && command -v inotifywait >/dev/null \
    && command -v python3 >/dev/null \
    && command -v node >/dev/null \
    && command -v xmllint >/dev/null \
    && command -v yq >/dev/null

COPY --from=node-cli-tools /usr/local/lib/node_modules/pnpm /usr/local/lib/node_modules/pnpm
COPY --from=node-cli-tools /usr/local/lib/node_modules/yarn /usr/local/lib/node_modules/yarn
RUN ln -sf ../lib/node_modules/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm \
    && ln -sf ../lib/node_modules/yarn/bin/yarn.js /usr/local/bin/yarn \
    && pnpm --version \
    && yarn --version

# The hardened guest remains the default and deliberately removes system
# mutation and privilege-management frontends.
FROM sandbox-common AS sandbox-build

RUN find / -xdev -perm /6000 -exec chmod ug-s {} + 2>/dev/null || true

RUN rm -f /usr/bin/nsenter /usr/bin/unshare /usr/bin/chroot /usr/sbin/chroot \
         /usr/bin/perl* /usr/bin/apt /usr/bin/dpkg \
         /usr/sbin/adduser /usr/sbin/useradd /usr/sbin/usermod \
         /usr/sbin/groupadd /usr/sbin/groupmod \
         /usr/bin/su \
         /usr/bin/chfn /usr/bin/chsh /usr/bin/gpasswd /usr/bin/newgrp \
         /usr/bin/passwd /usr/bin/sg \
         /usr/bin/chage /usr/bin/expiry /usr/sbin/unix_chkpwd \
    2>/dev/null || true

RUN command -v apt-get >/dev/null \
    && command -v apt-cache >/dev/null \
    && command -v dpkg-deb >/dev/null \
    && ! command -v apt >/dev/null \
    && ! command -v dpkg >/dev/null \
    && smoke_root=$(mktemp -d) \
    && mkdir -p /mnt/deps /mnt/data "$smoke_root/home" \
    && chown -R 65534:65534 /mnt/deps /mnt/data "$smoke_root" \
    && setpriv --reuid=65534 --regid=65534 --clear-groups env \
        HOME="$smoke_root/home" \
        /usr/local/bin/sandbox-pkg deb hello \
    && [ "$(setpriv --reuid=65534 --regid=65534 --clear-groups \
        /mnt/deps/deb/usr/bin/hello)" = "Hello, world!" ] \
    && rm -rf /mnt/deps /mnt/data "$smoke_root"

# ============================================================================
# Stage 2b: AWS Lambda MicroVM container base image
#
# Lambda MicroVM IS the VM boundary: no libkrun launcher, no guest kernel.
# This target is pushed to a same-account ECR repo and referenced by the
# FROM line of the code-artifact Dockerfile that Lambda builds on top of
# the AL2023 MicroVM base image (see scripts/build-lambda-microvm-artifact.sh).
# Inbound traffic defaults to port 8080; lifecycle/build hooks are served
# by the same app at /aws/lambda-microvms/runtime/v1/*.
# ============================================================================
FROM sandbox-build AS lambda-microvm-runner

COPY --from=package-builder /pkgs /pkgs

ENV PORT=8080 \
    SANDBOX_PACKAGES_DIRECTORY=/pkgs \
    SANDBOX_SESSION_WORKSPACE_ENABLED=true

EXPOSE 8080/tcp
ENTRYPOINT ["/sandbox_api/entrypoint.sh"]

# ============================================================================
# Stage 3: Build the Rust launcher binary (Fedora for libkrun ABI)
# ============================================================================
FROM fedora:43 AS launcher-builder

RUN dnf install -y \
    rust cargo \
    libkrun-devel \
    gcc \
    && dnf clean all

WORKDIR /launcher
COPY launcher/Cargo.toml launcher/build.rs ./
COPY launcher/src/ ./src/

RUN cargo build --release

# ============================================================================
# Stage 4: Final launcher image (Fedora for libkrun runtime)
#
# Split into:
#   - sandbox-runner-base : everything except the guest rootfs copy
#   - sandbox-runner      : legacy/direct target; copies rootfs without
#                           packages (packages come from a runtime PVC mount)
#   - sandbox-runner-baked: copies rootfs AND bakes /pkgs from package-builder
#                           (no PVC needed; runner can spread across nodes)
#   - sandbox-runner-{true,false}: Compose aliases selected by KVM_ENABLED
#   - sandbox-runner-default: final alias for the safe baked KVM image
# ============================================================================
FROM fedora:43 AS sandbox-runner-base

RUN dnf install -y --setopt=install_weak_deps=False \
    libkrun \
    socat \
    curl \
    util-linux \
    grep \
    gawk \
    findutils \
    ca-certificates \
    && dnf clean all

COPY --from=launcher-builder /launcher/target/release/sandbox-launcher /usr/local/bin/launcher

COPY launcher/entrypoint.sh /usr/local/bin/launcher-entrypoint.sh
COPY docker/start-direct-sandbox.sh /usr/local/bin/start-direct-sandbox.sh
COPY docker/sandbox-runner-healthcheck.sh /usr/local/bin/sandbox-runner-healthcheck.sh
COPY docker/sandbox-entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/runtime-resolver.sh /usr/local/libexec/codeapi-runtime-resolver.sh
RUN chmod +x /usr/local/bin/launcher-entrypoint.sh /usr/local/bin/start-direct-sandbox.sh /usr/local/bin/sandbox-runner-healthcheck.sh /usr/local/bin/entrypoint.sh /usr/local/libexec/codeapi-runtime-resolver.sh

EXPOSE 2000/tcp
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

FROM debian:bookworm AS sandbox-rootfs-image

RUN apt-get update && apt-get install -y --no-install-recommends \
    e2fsprogs \
    coreutils \
    gawk \
    && rm -rf /var/lib/apt/lists/*

COPY --from=sandbox-build / /sandbox-rootfs/
COPY --from=package-builder /pkgs /sandbox-rootfs/pkgs
COPY docker/build-rootfs-image.sh /usr/local/bin/build-rootfs-image.sh

RUN sed -i '/^cgroup_mem_swap_max/d' /sandbox-rootfs/sandbox_api/config/sandbox.cfg
RUN chmod +x /usr/local/bin/build-rootfs-image.sh \
    && /usr/local/bin/build-rootfs-image.sh /sandbox-rootfs /sandbox-rootfs.img

FROM debian:bookworm AS sandbox-full-debian-rootfs-image

RUN apt-get update && apt-get install -y --no-install-recommends \
    e2fsprogs \
    coreutils \
    gawk \
    && rm -rf /var/lib/apt/lists/*

COPY --from=sandbox-full-debian-build / /sandbox-rootfs/
COPY --from=package-builder /pkgs /sandbox-rootfs/pkgs
COPY docker/build-rootfs-image.sh /usr/local/bin/build-rootfs-image.sh

RUN sed -i '/^cgroup_mem_swap_max/d' /sandbox-rootfs/sandbox_api/config/sandbox.cfg
RUN chmod +x /usr/local/bin/build-rootfs-image.sh \
    && /usr/local/bin/build-rootfs-image.sh /sandbox-rootfs /sandbox-rootfs.img

FROM sandbox-runner-base AS sandbox-runner-baked

COPY --from=sandbox-rootfs-image /sandbox-rootfs.img /sandbox-rootfs.img

ENV LAUNCHER_ROOT_DISK=/sandbox-rootfs.img \
    LAUNCHER_ROOT_DISK_READ_ONLY=true \
    LAUNCHER_ROOT_DEVICE=/dev/vda \
    LAUNCHER_ROOT_FSTYPE=ext4 \
    LAUNCHER_ROOT_OPTIONS=ro

FROM sandbox-runner-base AS sandbox-runner

COPY --from=sandbox-build / /sandbox-rootfs/

RUN sed -i '/^cgroup_mem_swap_max/d' /sandbox-rootfs/sandbox_api/config/sandbox.cfg

RUN mkdir -p /host-packages

FROM sandbox-runner-base AS sandbox-runner-full-debian

RUN dnf install -y --setopt=install_weak_deps=False \
    python3 \
    e2fsprogs \
    passt \
    && dnf clean all

COPY --from=sandbox-full-debian-rootfs-image /sandbox-rootfs.img /sandbox-rootfs.img
COPY docker/full-debian-vm-manager.py /usr/local/bin/full-debian-vm-manager.py
COPY docker/passt-supervisor.py /usr/local/bin/passt-supervisor.py
RUN chmod +x /usr/local/bin/full-debian-vm-manager.py /usr/local/bin/passt-supervisor.py \
    && mkdir -p /tmp/codeapi-vms

ENV LAUNCHER_ROOT_DISK=/sandbox-rootfs.img \
    LAUNCHER_ROOT_DISK_READ_ONLY=true \
    LAUNCHER_ROOT_DEVICE=/dev/vda \
    LAUNCHER_ROOT_FSTYPE=ext4 \
    LAUNCHER_ROOT_OPTIONS=ro \
    SANDBOX_VM_MAX_CONCURRENT=2 \
    SANDBOX_VM_SCRATCH_SIZE_MIB=8192

ENTRYPOINT ["/usr/local/bin/full-debian-vm-manager.py"]

# Compose derives these aliases from KVM_ENABLED so existing no-KVM overrides
# keep selecting the directory-root image automatically.
FROM sandbox-runner-baked AS sandbox-runner-true
FROM sandbox-runner AS sandbox-runner-false

# Keep the safe KVM image as the Dockerfile default. Direct NsJail and legacy
# virtio-fs deployments can still select --target sandbox-runner explicitly.
FROM sandbox-runner-true AS sandbox-runner-default
