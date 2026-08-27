# Code Interpreter

Sandboxed code execution service for LibreChat, providing secure execution of user-submitted code with file storage and tool calling capabilities.

## Overview

Code Interpreter (internally `codeapi`, the prefix used by its env vars, images, and helm chart) is a multi-component service that enables LibreChat to safely execute user code in isolated sandboxes. It consists of six independently scalable components that communicate via Redis queues and S3-compatible storage.

This fork is maintained directly rather than receiving snapshot commits from an
upstream monorepo. CI builds and tests the checked-out source, while
`.github/workflows/build-images.yml` publishes all six `linux/amd64` images to
`ghcr.io/ricky-hao/code-interpreter-*` with immutable `sha-<full-commit>` and
`sha-<12-character-commit>` tags. Deployments should pin the recorded OCI
digest; the workflow intentionally does not publish mutable `latest` tags.

## Components

- **API** - HTTP gateway that accepts code execution requests and returns results
- **Service Worker** - Consumes queued execution jobs and dispatches them to a sandbox
- **Sandbox Runner** - Executes code in NsJail inside a libkrun microVM with resource limits
- **File Server** - Manages file uploads/downloads via S3 (IRSA authentication)
- **Egress Gateway** - Enforces artifact grants and proxies authenticated sandbox tool calls
- **Tool Call Server** - Handles programmatic tool calls from within sandbox sessions

Python, Node, Bun, and a general engineering CLI toolchain are baked into the
default microVM block-root image. The CLI set includes curl/wget, Git/Git LFS/GitHub
CLI, OpenSSH clients, rsync, search and archive utilities, GCC/Clang/CMake/Ninja,
SQLite, network diagnostics, process diagnostics, ShellCheck, and shfmt. A
package-init PVC mode remains available for direct NsJail development.

Jobs can install missing Python, JavaScript, or Debian dependencies into an
isolated, executable `/mnt/deps` layer with
`sandbox-pkg pip|uv|npm|bun|apt|deb`. Debian packages are downloaded from the
guest's signed APT sources and extracted without `dpkg --install`, maintainer
scripts, service activation, or root access. Binary, library, header,
pkg-config, and CMake discovery paths are configured automatically. The layer
is unprivileged and temporary to one execution; it does not make the read-only
guest OS or baked package tree mutable. Packages requiring maintainer scripts,
services, kernel integration, or absolute system paths may not work in this
relocated form. Remote installs require sandbox networking and run third-party
package code with the sandbox's network reachability.

### Full Debian MicroVM mode

The `sandbox-runner-full-debian` image target provides a mutable Debian system
for each execution. The runner keeps one immutable Debian block-root image and,
for every proxied API request, creates a sparse ext4 scratch disk, starts a new
libkrun MicroVM on an isolated host port, and mounts the scratch disk as the
upper layer for `/usr`, `/etc`, `/var`, `/opt`, `/root`, `/home`, and `/srv`.
The job runs as root inside that guest and can use normal `apt` and `dpkg`.
When the HTTP response is complete, the runner terminates the MicroVM and
deletes its scratch disk.

The full-Debian jail also provides private PTYs and POSIX shared memory,
standard `/dev/fd` and merged-usr links, useful non-sensitive proc statistics,
an executable `/tmp`, local TCP loopback, Python 3, and a conventional `node`
command. Each VM receives a fresh machine ID plus neutral hosts and UTC
timezone files.

Full-Debian VMs use a per-VM passt process and an explicit virtio-net device.
Do not fall back to libkrun's implicit TSI backend: TSI hijacks guest Internet
sockets and does not preserve same-guest TCP connections through `127/8`.
The guest acquires its IPv4 address from passt's DHCP service before starting
the API. The manager-assigned API port is forwarded by passt and its lifecycle is
managed through a root-only Unix control socket. A dedicated passt sidecar has
the narrow `Unconfined` container seccomp and AppArmor exceptions needed to
create passt's own namespaces; it remains non-privileged with privilege
escalation disabled, while the manager and VMM remain under `RuntimeDefault`.
Per-VM passt processes and sockets are removed when their disposable VMs stop.

Input and output files keep the existing API contract. The guest downloads
file references through the egress gateway into its private `/mnt/data`, scans
generated files, and uploads them before returning the response. LibreChat and
the service worker do not need a separate file path for this mode.

One VM handles one request. `SANDBOX_VM_MAX_CONCURRENT` controls how many VMs a
runner may host, while `LAUNCHER_VCPUS`, `LAUNCHER_RAM_MIB`, and
`SANDBOX_VM_SCRATCH_SIZE_MIB` size each VM. The full mode intentionally gives
guest code root and a writable OS, but it still applies the existing NsJail
PID/mount namespaces, cgroup and rlimit ceilings, seccomp policy, execution
manifest checks, and MicroVM kernel boundary. It does not provide systemd as
PID 1, nested containers, kernel module loading, or mounts from user code.
Loopback does not expose the guest management API to jailed code: the manager
generates a random token for every VM, overwrites the token header on readiness
and proxied requests, and the guest rejects every route without it. The
launcher passes the token only to the guest API; NsJail clears the inherited
environment and never exports it to the job.

The full-Debian guest provides conventional coding-agent paths and tools:
`/usr/bin/python3`, `/usr/bin/python`, `/usr/bin/node`, `/usr/bin/nodejs`, `yq`,
`bat`, `fzf`, `xmllint`, `envsubst`, `inotifywait`, `ctags`, `pnpm`, and `yarn`.

## Architecture

1. LibreChat sends a code execution request to the **API**
2. API enqueues the job in Redis
3. **Service Worker** picks up the job and sends it to the **Sandbox Runner**
4. **Sandbox Runner** executes code inside an isolated sandbox
5. Files are persisted/retrieved through the **Egress Gateway** and **File Server**
6. Programmatic tool calls are routed through the **Egress Gateway** to the **Tool Call Server**

## Execution profiles

Code API can run two isolated deployments at the same time:

- `default`: the AWS-free HTTP/libkrun path, with stateless executions.
- `stateful`: the AWS Lambda MicroVM path, with runtime-session affinity.

Set `CODEAPI_EXECUTION_PROFILE` consistently on an API deployment and its
workers. The default profile keeps the existing `python-queue` and
`other-queue`; the stateful profile uses `stateful-python-queue` and
`stateful-other-queue`. This allows both deployments to share Redis without
cross-consuming jobs.

An existing Lambda MicroVM deployment upgraded from a pre-profile release may
leave `CODEAPI_EXECUTION_PROFILE` unset for its first binary rollout. An
affinity/strict deployment still identifies itself as `stateful`; a stateless
Lambda deployment identifies itself as `default`. Both temporarily keep the
legacy queue names so separately deployed APIs and workers remain compatible
with old binaries.
Move that deployment to the isolated stateful queues with a blue/green cutover:
start replacement API and worker pools with the profile explicitly set to
`stateful`, verify them together, switch the stateful endpoint, and drain the
legacy pool. For rollback, switch the endpoint back before stopping the
replacement pool. Do not run the inferred stateful compatibility mode beside a
default deployment on the same Redis because both use the legacy queues.

Trusted callers should send `X-CodeAPI-Expected-Profile: default|stateful` on
every Code API request. A request that reaches the wrong deployment fails
before enqueue with HTTP 409 and `error=execution_profile_mismatch`; every
response advertises the actual deployment in `X-CodeAPI-Execution-Profile`.
Omitting the expected-profile header remains supported for older clients, but
provides no wrong-endpoint protection. There is deliberately no silent
fallback between profiles and no automatic workspace or file migration.

## Sandbox Isolation

Two modes are supported:

- **NsJail mode** (`kvmEnabled: false`): Direct NsJail sandboxing with Linux namespaces and cgroups
- **MicroVM mode** (`kvmEnabled: true`): libkrun microVM with its own kernel, NsJail runs inside the guest

`SANDBOX_DISABLE_NETWORKING=false` deliberately gives executed code unrestricted
network access. NsJail shares the runner network namespace, receives the runner's
runtime resolver configuration through the microVM and mounts it read-only, and
permits ordinary IPv4/IPv6 sockets through its seccomp policy. A public resolver
fallback is used when the container resolver is loopback-only and therefore
unreachable through libkrun TSI. The default remains `true`; deployment
configuration must opt in explicitly.

With networking enabled, sandbox code can reach both public and private networks
allowed by the node and can exfiltrate supplied input data. Direct traffic bypasses
the egress gateway. The gateway and tool-call server remain required for their
artifact and programmatic tool-call capability paths, but they do not constrain
general sandbox networking.

## Security disclaimer

This service exists to run arbitrary, untrusted code — treat every
deployment decision accordingly.

In its default full hardened configuration — MicroVM mode (`kvmEnabled: true`, so
sandboxed code runs under a separate guest kernel) with NsJail inside the
guest, networking disabled, seccomp filtering, network policies applied, signed
execution manifests, and `hardenedSandboxMode` left on — it is reasonably secure
and designed with defense in depth. Enabling unrestricted networking intentionally
removes the network-isolation layer. NsJail-only mode shares the host kernel and
provides meaningfully weaker isolation: it is appropriate for local development,
not for executing untrusted code from people you don't trust.

No software is 100% secure. Sandbox escapes, kernel vulnerabilities, and
misconfiguration are all real risks for any code-execution system. Keep the
hardening defaults on, run the stack on isolated infrastructure with least
privilege, keep hosts patched, and deploy responsibly. If you believe you
have found a vulnerability, please report it privately rather than opening a
public issue (see [CONTRIBUTING](CONTRIBUTING.md)).

## Local Development

```bash
docker-compose up --build
```

The default KVM Compose path builds `sandbox-runner-baked`: the guest root and
`/pkgs` tree live in a read-only ext4 block image instead of a long-lived
virtio-fs mount. The first image build takes longer because it compiles the
language runtimes, but package-heavy workloads do not accumulate host file
descriptors in the launcher.

Setting `KVM_ENABLED=false` still selects the directory-root target and the
host package mount automatically for direct NsJail development.

Run the disposable full Debian mode with the explicit Compose override:

```bash
docker compose -f docker-compose.yaml -f docker-compose.full-debian.yml up --build
```

Local Docker Compose files set `CODEAPI_INTERNAL_SERVICE_TOKEN` to a shared
development value by default. Production deployments must override it with a
strong secret; when it is unset, file object routes and Tool Call Server
session-management routes stay unauthenticated for backwards compatibility.

## Health Checks

- API: `GET /v1/health`
- Worker: `GET /health` and `GET /ready`
- File Server: `GET /health` and `GET /ready`
- Tool Call Server: `GET /health`
