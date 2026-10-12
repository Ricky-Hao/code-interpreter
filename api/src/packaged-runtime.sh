#!/bin/bash
# Sourced by every packaged guest entrypoint. Docker ENV is not part of a
# copied rootfs/libkrun guest environment. Never select native code from a
# launcher-supplied path; the package owns this location in every runtime mode.
export SANDBOX_PIPE_ADDON=/usr/local/lib/anonymous-pipes.node

# Exercise the API transport under the same policy before accepting traffic.
# A direct Bash -> nsjail smoke does not load the API's native addon.
if ! /usr/bin/timeout 10 /usr/local/bin/sandbox-supervisor-policy \
    /usr/local/bin/bun /sandbox_api/.build/pipe-process-smoke.js; then
    echo "FATAL: packaged anonymous-pipe startup check failed: $SANDBOX_PIPE_ADDON" >&2
    exit 1
fi
