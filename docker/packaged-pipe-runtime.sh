#!/bin/bash
# Run only in a disposable guest rootfs (image build or isolated local chroot).
# Kept under docker/: the root build context intentionally excludes tests/.
# No addon override is supplied: this must catch Docker ENV lost during COPY.
set -euo pipefail
addon=/usr/local/lib/anonymous-pipes.node
test ! -e /sandbox_api/.build/anonymous-pipes.node
for mode in false true; do
    env -i PATH=/usr/local/bin:/usr/bin:/bin SANDBOX_FULL_DEBIAN_MODE="$mode" \
        SANDBOX_VM_CONTROL_TOKEN=fixture-control SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY=fixture-public \
        /bin/bash -ec '. /sandbox_api/packaged-runtime.sh
            test "$SANDBOX_PIPE_ADDON" = /usr/local/lib/anonymous-pipes.node
            test "$SANDBOX_VM_CONTROL_TOKEN" = fixture-control
            test "$SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY" = fixture-public'
done
# Direct-container host configuration cannot redirect the packaged loader.
env -i PATH=/usr/local/bin:/usr/bin:/bin SANDBOX_PIPE_ADDON=/untrusted/override.node \
    /bin/bash -ec '. /sandbox_api/packaged-runtime.sh'

backup=$(mktemp)
log=$(mktemp)
cp -p "$addon" "$backup"
restore() { cp -p "$backup" "$addon"; rm -f "$backup" "$log"; }
trap restore EXIT
for state in missing corrupt; do
    rm -f "$addon"
    if [ "$state" = corrupt ]; then printf 'not a native addon\n' > "$addon"; fi
    if env -i PATH=/usr/local/bin:/usr/bin:/bin /bin/bash -ec \
        '. /sandbox_api/packaged-runtime.sh' >"$log" 2>&1; then
        echo "FAIL: $state addon was accepted" >&2
        exit 1
    fi
    grep -F "FATAL: packaged anonymous-pipe startup check failed: $addon" "$log"
    echo "PASS: $state addon rejected before API startup"
done
restore
trap - EXIT
echo 'PASS: sanitized restricted/full Debian packaged pipe runtime, host override, missing/corrupt addon'
