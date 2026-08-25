#!/usr/bin/env bash
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || {
        echo 'sandbox-pkg tests require root or passwordless sudo' >&2
        exit 1
    }
    exec sudo -n env "PATH=$PATH" bash "$0"
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT_DIR}/docker/sandbox-pkg"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p \
    "$TMP_DIR/bin" \
    "$TMP_DIR/deps" \
    "$TMP_DIR/data" \
    "$TMP_DIR/baked/node_modules/baked-package" \
    "$TMP_DIR/baked/node_modules/@demo/baked-scoped" \
    "$TMP_DIR/baked/node_modules/.bin"
printf '{"name":"baked-package","type":"module","exports":"./index.js"}\n' > "$TMP_DIR/baked/node_modules/baked-package/package.json"
printf 'export default "baked-ok";\n' > "$TMP_DIR/baked/node_modules/baked-package/index.js"
printf '{"name":"@demo/baked-scoped"}\n' > "$TMP_DIR/baked/node_modules/@demo/baked-scoped/package.json"
printf '#!/bin/sh\n' > "$TMP_DIR/baked/node_modules/.bin/baked-cli"

make_fake() {
    local name="$1"
    cat > "$TMP_DIR/bin/$name" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$0" "$@" > "${SANDBOX_PKG_TEST_LOG:?}"
EOF
    chmod +x "$TMP_DIR/bin/$name"
}

for command in python3 uv npm bun; do
    make_fake "$command"
done

cat > "$TMP_DIR/bin/apt-get" <<'EOF'
#!/usr/bin/env bash
printf 'apt-get %s\n' "$*" >> "${SANDBOX_PKG_TEST_LOG:?}"
printf 'apt-config %s\n' "${APT_CONFIG:-}" >> "${SANDBOX_PKG_TEST_LOG:?}"
if [[ " $* " == *" install "* ]]; then
    archive_root="$(printf '%s\n' "$*" | sed -n 's/.*Dir::Cache::archives=\([^ ]*\).*/\1/p')"
    mkdir -p "$archive_root"
    if [[ " $* " == *" failure-package "* ]]; then
        : > "$archive_root/good-before-failure.deb"
        : > "$archive_root/z-broken.deb"
    else
        : > "$archive_root/demo-package.deb"
    fi
fi
EOF
chmod +x "$TMP_DIR/bin/apt-get"

cat > "$TMP_DIR/bin/apt-cache" <<'EOF'
#!/usr/bin/env bash
printf 'apt-cache %s\n' "$*" >> "${SANDBOX_PKG_TEST_LOG:?}"
package="${@: -1}"
case "$package" in
    demo-package|second-package|failure-package) printf 'Package: %s\n' "$package" ;;
    *) exit 100 ;;
esac
EOF
chmod +x "$TMP_DIR/bin/apt-cache"

cat > "$TMP_DIR/bin/dpkg-deb" <<'EOF'
#!/usr/bin/env bash
printf 'dpkg-deb %s\n' "$*" >> "${SANDBOX_PKG_TEST_LOG:?}"
destination="${3:?missing extraction destination}"
mkdir -p "$destination/usr/bin"
name="$(basename "${2:?missing archive}" .deb)"
printf '#!/bin/sh\nexit 0\n' > "$destination/usr/bin/$name"
chmod 6755 "$destination/usr/bin/$name"
if [ "$name" = z-broken ]; then
    exit 1
fi
EOF
chmod +x "$TMP_DIR/bin/dpkg-deb"

run_case() {
    local manager="$1"
    local expected="$2"
    local log="$TMP_DIR/$manager.log"
    PATH="$TMP_DIR/bin:$PATH" \
        SANDBOX_DEPS_ROOT="$TMP_DIR/deps" \
        SANDBOX_DATA_ROOT="$TMP_DIR/data" \
        SANDBOX_PKG_TEST_LOG="$log" \
        NODE_PATH="$TMP_DIR/deps/js/node_modules:$TMP_DIR/baked/node_modules" \
        "$SCRIPT" "$manager" demo-package==1.2.3
    grep -F "$expected" "$log" >/dev/null
    grep -F 'demo-package==1.2.3' "$log" >/dev/null
}

bash -n "$SCRIPT"
run_case pip 'pip'
run_case uv 'pip'
run_case npm 'install'
test "$(readlink "$TMP_DIR/data/node_modules")" = "$TMP_DIR/deps/js/node_modules"
test -L "$TMP_DIR/deps/js/node_modules/baked-package"
test -L "$TMP_DIR/deps/js/node_modules/@demo/baked-scoped"
test -L "$TMP_DIR/deps/js/node_modules/.bin/baked-cli"

mkdir -p "$TMP_DIR/deps/js/node_modules/dynamic-esm"
cat > "$TMP_DIR/deps/js/node_modules/dynamic-esm/package.json" <<'EOF'
{"name":"dynamic-esm","type":"module","exports":"./index.js"}
EOF
printf 'export default "esm-ok";\n' > "$TMP_DIR/deps/js/node_modules/dynamic-esm/index.js"
(
    cd "$TMP_DIR/data"
    node --input-type=module -e \
        'const dynamic = await import("dynamic-esm"); const baked = await import("baked-package"); if (dynamic.default !== "esm-ok" || baked.default !== "baked-ok") process.exit(1)'
)
run_case bun 'add'

deb_log="$TMP_DIR/deb.log"
case "$(uname -m)" in
    x86_64) expected_apt_arch=amd64; opposite_apt_arch=arm64 ;;
    aarch64) expected_apt_arch=arm64; opposite_apt_arch=amd64 ;;
    *) echo 'unsupported test architecture' >&2; exit 1 ;;
esac
PATH="$TMP_DIR/bin:$PATH" \
    SANDBOX_DEPS_ROOT="$TMP_DIR/deps" \
    SANDBOX_DATA_ROOT="$TMP_DIR/data" \
    SANDBOX_PKG_TEST_LOG="$deb_log" \
    "$SCRIPT" deb demo-package=1.2.3
grep -F 'APT::Sandbox::User=' "$deb_log" >/dev/null
grep -F "APT::Architecture=$expected_apt_arch" "$deb_log" >/dev/null
grep -F 'APT::Get::AllowUnauthenticated=false' "$deb_log" >/dev/null
grep -F 'Dir::Etc::sourcelist=/etc/apt/sources.list' "$deb_log" >/dev/null
grep -F 'Dir::Etc::trustedparts=/etc/apt/trusted.gpg.d' "$deb_log" >/dev/null
grep -E "apt-config $TMP_DIR/deps/apt/cache/archives/run\.[^/]+/sandbox-pkg\.conf" "$deb_log" >/dev/null
grep -F -- '--no-remove --download-only install demo-package=1.2.3' "$deb_log" >/dev/null
grep -F 'apt-cache ' "$deb_log" | grep -F ' show --no-all-versions demo-package' >/dev/null
grep -F 'dpkg-deb --extract' "$deb_log" >/dev/null
test -x "$TMP_DIR/deps/deb/usr/bin/demo-package"
test ! -u "$TMP_DIR/deps/deb/usr/bin/demo-package"
test ! -g "$TMP_DIR/deps/deb/usr/bin/demo-package"
test -f "$TMP_DIR/deps/apt/state/lists/.sandbox-pkg-updated"
if find "$TMP_DIR/deps/apt/cache/archives" -mindepth 1 -print -quit | grep -q .; then
    echo 'sandbox-pkg left a stale per-invocation archive directory' >&2
    exit 1
fi

PATH="$TMP_DIR/bin:$PATH" \
    SANDBOX_DEPS_ROOT="$TMP_DIR/deps" \
    SANDBOX_DATA_ROOT="$TMP_DIR/data" \
    SANDBOX_PKG_TEST_LOG="$deb_log" \
    "$SCRIPT" apt second-package
test "$(grep -c ' update$' "$deb_log")" -eq 1
grep -F -- '--no-remove --download-only install second-package' "$deb_log" >/dev/null

for invalid_package in '-oAPT::Update::Pre-Invoke::=bad' '..' 'a..' 'demo-package-' "demo-package:$opposite_apt_arch" 'demo-package='; do
    invalid_log="$TMP_DIR/reject-${invalid_package//[^a-zA-Z0-9]/_}.log"
    if PATH="$TMP_DIR/bin:$PATH" SANDBOX_DEPS_ROOT="$TMP_DIR/deps" \
        SANDBOX_DATA_ROOT="$TMP_DIR/data" SANDBOX_PKG_TEST_LOG="$invalid_log" \
        "$SCRIPT" apt "$invalid_package" >/dev/null 2>&1; then
        echo "sandbox-pkg accepted invalid Debian package spec: $invalid_package" >&2
        exit 1
    fi
    test ! -e "$invalid_log"
done

failure_log="$TMP_DIR/failure.log"
if PATH="$TMP_DIR/bin:$PATH" SANDBOX_DEPS_ROOT="$TMP_DIR/deps" \
    SANDBOX_DATA_ROOT="$TMP_DIR/data" SANDBOX_PKG_TEST_LOG="$failure_log" \
    "$SCRIPT" apt failure-package >/dev/null 2>&1; then
    echo 'sandbox-pkg accepted a failed Debian extraction' >&2
    exit 1
fi
test ! -e "$TMP_DIR/deps/deb/usr/bin/good-before-failure"
test ! -e "$TMP_DIR/deps/deb/usr/bin/z-broken"
if find "$TMP_DIR/deps/apt/cache/archives" -mindepth 1 -print -quit | grep -q .; then
    echo 'sandbox-pkg left archives after a failed extraction' >&2
    exit 1
fi

if PATH="$TMP_DIR/bin:$PATH" SANDBOX_DEPS_ROOT="$TMP_DIR/deps" \
    SANDBOX_DATA_ROOT="$TMP_DIR/data" SANDBOX_PKG_TEST_LOG="$TMP_DIR/reject.log" \
    "$SCRIPT" apt unknown-package >/dev/null 2>&1; then
    echo 'sandbox-pkg accepted a Debian package with no exact candidate' >&2
    exit 1
fi

if SANDBOX_DEPS_ROOT=relative "$SCRIPT" pip demo >/dev/null 2>&1; then
    echo 'sandbox-pkg accepted a relative dependency root' >&2
    exit 1
fi

if SANDBOX_DATA_ROOT=relative "$SCRIPT" npm demo >/dev/null 2>&1; then
    echo 'sandbox-pkg accepted a relative data root' >&2
    exit 1
fi

printf 'sandbox-pkg routing tests passed\n'