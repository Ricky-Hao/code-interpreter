#!/bin/bash
set -euo pipefail

scratch_device="${SANDBOX_FULL_DEBIAN_SCRATCH_DEVICE:-/dev/vdb}"
overlay_root="${SANDBOX_FULL_DEBIAN_OVERLAY_ROOT:-/mnt/codeapi-overlay}"

if [ ! -b "$scratch_device" ]; then
    echo "FATAL: full Debian scratch device is unavailable: $scratch_device" >&2
    exit 1
fi

mkdir -p "$overlay_root"
mount -t ext4 -o rw,nosuid,nodev "$scratch_device" "$overlay_root"

mount_overlay() {
    local target="$1"
    local name="${target#/}"
    local upper="$overlay_root/upper/$name"
    local work="$overlay_root/work/$name"

    mkdir -p "$target" "$upper" "$work"
    mount -t overlay overlay \
        -o "lowerdir=$target,upperdir=$upper,workdir=$work" \
        "$target"
}

for target in /usr /etc /var /opt /root /home /srv /boot /media; do
    mount_overlay "$target"
done

mount -t tmpfs -o rw,nosuid,nodev,size=128m tmpfs /run

machine_id="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
if [ "${#machine_id}" -ne 32 ]; then
    echo "FATAL: unable to generate a per-VM machine-id" >&2
    exit 1
fi
printf '%s\n' "$machine_id" > /etc/machine-id
mkdir -p /var/lib/dbus
rm -f /var/lib/dbus/machine-id
ln -s /etc/machine-id /var/lib/dbus/machine-id

printf '%s\n' \
    '127.0.0.1 localhost' \
    '127.0.1.1 sandbox' \
    '::1 localhost ip6-localhost ip6-loopback' > /etc/hosts
printf '%s\n' 'Etc/UTC' > /etc/timezone
ln -sfn /usr/share/zoneinfo/Etc/UTC /etc/localtime

touch /etc/.codeapi-full-debian-write-test
rm -f /etc/.codeapi-full-debian-write-test

echo "Prepared disposable writable Debian overlay on $scratch_device"