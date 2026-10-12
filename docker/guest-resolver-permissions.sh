#!/bin/bash
# Offline build/local fixture: real UID permissions on a disposable guest tree.
# Models /etc copy-up and the retained /run; does not mount filesystems or use DNS.
set -euo pipefail
source "${1:?guest-dns.sh path required}"
source "${2:?runtime-resolver.sh path required}"
test "$(id -u)" = 0
setpriv_binary=$(command -v setpriv)
umask 0077
fixture=$(mktemp -d)
trap 'chmod -R u+w "$fixture"; rm -rf "$fixture"' EXIT

# Start inside the fixture so private ancestors of TMPDIR need no chmod.
# Neither supplementary groups nor capabilities may bypass the permission test.
as_uid() (
    local root="$1" uid="$2"
    shift 2
    cd "$root"
    env -i PATH=/usr/bin:/bin "$setpriv_binary" --reuid="$uid" --regid=65534 \
        --clear-groups --bounding-set=-all --no-new-privs /bin/bash -ec "$*"
)

for mode in full-debian baked-restricted; do
    root="$fixture/$mode"
    mkdir -p "$root/etc" "$root/run" "$root/tmp"
    chmod 0755 "$root" "$root/etc" "$root/run" "$root/tmp"
    mkdir "$root/run/private-control"
    printf 'fixture-only-control\n' > "$root/run/private-control/token"
    prepare_guest_dns "$root"
    # Baked lower /etc is read-only; the target is in the later /run mount.
    chmod 0555 "$root/etc"
    SANDBOX_RESOLV_CONF='nameserver 192.0.2.53|search fixture.invalid|options ndots:1'
    configure_guest_dns "$root"
    test "$(umask)" = 0077
    test ! -v SANDBOX_RESOLV_CONF
    if [ "$mode" = full-debian ]; then
        run_inode=$(stat -c '%i' "$root/run")
        # Model /etc overlay copy-up while retaining the original /run tree.
        cp -a "$root/etc" "$root/etc-upper"
        chmod 0755 "$root/etc-upper"
        mv "$root/etc" "$root/etc-lower"
        mv "$root/etc-upper" "$root/etc"
        test "$(stat -c '%i' "$root/run")" = "$run_inode"
        # Actual API resolver helper output; model the file seen through the
        # NsJail bind target (the /etc link is not replaced by the bind mount).
        codeapi_write_runtime_resolver '' "$root/etc/resolv.conf" "$root/tmp/codeapi-resolv.conf"
        cp -p "$root/tmp/codeapi-resolv.conf" "$root/run/codeapi-resolver/resolv.conf"
    fi
    test "$(readlink "$root/etc/resolv.conf")" = ../run/codeapi-resolver/resolv.conf
    printf '%s: ' "$mode"
    stat -c '%n uid=%u gid=%g mode=%a' "$root/run/codeapi-resolver" "$root/run/codeapi-resolver/resolv.conf"
    # Read before checking mode strings: the old code must fail here with EACCES.
    as_uid "$root" 42 'test "$(id -u)" = 42; cat etc/resolv.conf' > "$fixture/readback"
    printf 'nameserver 192.0.2.53\nsearch fixture.invalid\noptions ndots:1\n' > "$fixture/expected"
    cmp "$fixture/expected" "$fixture/readback"
    for uid in 42 65534; do
        as_uid "$root" "$uid" '
            test "$(id -u)" != 0
            test "$(id -G)" = 65534
            cat etc/resolv.conf >/dev/null
            test ! -w run
            test ! -w run/codeapi-resolver
            test ! -w run/codeapi-resolver/resolv.conf
            if (printf overwrite > etc/resolv.conf) 2>/dev/null; then exit 1; fi
            if touch run/codeapi-resolver/new-entry 2>/dev/null; then exit 1; fi
            if rm run/codeapi-resolver/resolv.conf 2>/dev/null; then exit 1; fi
            if mv run/codeapi-resolver run/replaced 2>/dev/null; then exit 1; fi
            if ln -sfn ../tmp/foreign etc/resolv.conf 2>/dev/null; then exit 1; fi
            if cat run/private-control/token 2>/dev/null; then exit 1; fi
        '
        echo "PASS: $mode UID=$uid GID=65534 reads /etc link; writes/replacement/control read denied"
    done
    test "$(stat -c '%u:%g:%a' "$root/run/codeapi-resolver")" = 0:0:755
    test "$(stat -c '%u:%g:%a' "$root/run")" = 0:0:755
    test "$(stat -c '%u:%g:%a' "$root/run/codeapi-resolver/resolv.conf")" = 0:0:444
    test "$(stat -c '%u:%g:%a' "$root/run/private-control")" = 0:0:700
    test "$(stat -c '%u:%g:%a' "$root/run/private-control/token")" = 0:0:600
    cmp "$fixture/expected" "$root/etc/resolv.conf"
done
echo 'Guest resolver low-UID permissions passed (umask0077, filesystem overlay model)'
