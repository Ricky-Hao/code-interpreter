#!/usr/bin/env bash
set -euo pipefail

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

if SANDBOX_DEPS_ROOT=relative "$SCRIPT" pip demo >/dev/null 2>&1; then
    echo 'sandbox-pkg accepted a relative dependency root' >&2
    exit 1
fi

if SANDBOX_DATA_ROOT=relative "$SCRIPT" npm demo >/dev/null 2>&1; then
    echo 'sandbox-pkg accepted a relative data root' >&2
    exit 1
fi

printf 'sandbox-pkg routing tests passed\n'