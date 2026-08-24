#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../docker/runtime-resolver.sh
. "${ROOT_DIR}/docker/runtime-resolver.sh"

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

source_resolver="${tmpdir}/source.conf"
decoded_resolver="${tmpdir}/decoded.conf"
fallback_resolver="${tmpdir}/fallback.conf"
fallback_copy="${tmpdir}/fallback-copy.conf"

for value in false False ' false ' 0 no off; do
    codeapi_networking_enabled "${value}" || {
        echo "networking was not enabled for ${value}" >&2
        exit 1
    }
done
for value in true TRUE ' true ' 1 yes on '' typo; do
    if codeapi_networking_enabled "${value}"; then
        echo "networking was enabled for ${value:-an empty value}" >&2
        exit 1
    fi
done

cat > "${source_resolver}" <<'EOF'
search code-interpreter.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.43.0.10
options ndots:5
EOF
printf 'nameserver 1.1.1.1\n' > "${fallback_resolver}"

encoded="$(codeapi_encode_resolver_file "${source_resolver}")"
codeapi_write_runtime_resolver "${encoded}" "${fallback_resolver}" "${decoded_resolver}"
cmp "${source_resolver}" "${decoded_resolver}"
test "$(stat -c '%a' "${decoded_resolver}")" = "444"

codeapi_write_runtime_resolver '' "${fallback_resolver}" "${fallback_copy}"
cmp "${fallback_resolver}" "${fallback_copy}"

printf 'search example.test\n' > "${tmpdir}/missing-nameserver.conf"
if codeapi_encode_resolver_file "${tmpdir}/missing-nameserver.conf"; then
    echo "resolver without a nameserver was accepted" >&2
    exit 1
fi

head -c "$((CODEAPI_RESOLVER_MAX_BYTES + 1))" /dev/zero > "${tmpdir}/oversized.conf"
if codeapi_encode_resolver_file "${tmpdir}/oversized.conf"; then
    echo "oversized resolver was accepted" >&2
    exit 1
fi

echo "runtime resolver handoff checks passed"