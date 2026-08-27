import { describe, expect, test } from 'bun:test';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { config } from './config';
import { buildArgs, execute, renderJobConfigOverlay } from './nsjail';

function valueAfter(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function hasArgPair(args: string[], flag: string, value: string): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag && args[i + 1] === value) return true;
  }
  return false;
}

function seccompPolicy(): string {
  const args = buildArgs({
    logPath: '/tmp/nsjail-test.log',
    pkgdir: '/pkgs/python/3.14.4',
    timeout: 1000,
    memoryLimit: -1,
    envVars: {},
    command: ['/bin/bash', '/pkgs/python/3.14.4/run', 'main.py'],
    identity: { slot: 0, uid: 65534, gid: 65534, perJobUid: false },
  });
  const policy = valueAfter(args, '--seccomp_string');
  if (!policy) throw new Error('seccomp policy not present in nsjail args');
  return policy;
}

describe('NsJail args', () => {
  test('mounts the system CA trust store read-only', async () => {
    const cfg = await fsp.readFile(new URL('../config/sandbox.cfg', import.meta.url), 'utf8');
    expect(cfg).toContain([
      'mount {',
      '    src: "/etc/ssl/certs"',
      '    dst: "/etc/ssl/certs"',
      '    is_bind: true',
      '    rw: false',
      '}',
    ].join('\n'));
  });

  test('provides only the fixed sandbox UID and GID identity', async () => {
    const cfg = await fsp.readFile(new URL('../config/sandbox.cfg', import.meta.url), 'utf8');
    expect(cfg).toContain('src_content: "sandbox:x:65534:65534:Sandbox user:/mnt/data:/bin/sh\\n"');
    expect(cfg).toContain('src_content: "sandbox:x:65534:\\n"');
    expect(cfg).not.toContain('root:x:0:0:');
  });

  test('mounts only immutable APT inputs and package status read-only', async () => {
    const cfg = await fsp.readFile(new URL('../config/sandbox.cfg', import.meta.url), 'utf8');
    for (const source of [
      '/etc/apt/sources.list',
      '/etc/apt/sources.list.d',
      '/etc/apt/trusted.gpg',
      '/etc/apt/trusted.gpg.d',
      '/var/lib/dpkg/status',
    ]) {
      expect(cfg).toContain([
        'mount {',
        `    src: "${source}"`,
        `    dst: "${source}"`,
        '    is_bind: true',
        '    rw: false',
      ].join('\n'));
    }
    expect(cfg).not.toContain('src: "/etc/apt"');
    expect(cfg).not.toContain('src: "/var/lib/dpkg"');
  });

  test('shares networking and mounts the resolver only when networking is enabled', () => {
    const originalDisableNetworking = config.disable_networking;
    const options = {
      logPath: '/tmp/nsjail-test.log',
      pkgdir: '/pkgs/python/3.14.4',
      timeout: 1000,
      memoryLimit: -1,
      envVars: {},
      command: ['/bin/bash', '/pkgs/python/3.14.4/run', 'main.py'],
      identity: { slot: 0, uid: 65534, gid: 65534, perJobUid: false },
    };
    const resolverMount = '/tmp/codeapi-resolv.conf:/etc/resolv.conf';

    try {
      config.disable_networking = true;
      const disabledArgs = buildArgs(options);
      expect(disabledArgs).not.toContain('--disable_clone_newnet');
      expect(hasArgPair(disabledArgs, '-R', resolverMount)).toBe(false);

      config.disable_networking = false;
      const enabledArgs = buildArgs(options);
      expect(enabledArgs).toContain('--disable_clone_newnet');
      expect(hasArgPair(enabledArgs, '-R', resolverMount)).toBe(true);
    } finally {
      config.disable_networking = originalDisableNetworking;
    }
  });

  test('passes dynamic per-job UID/GID mappings', () => {
    const args = buildArgs({
      logPath: '/tmp/nsjail-test.log',
      pkgdir: '/pkgs/python/3.14.4',
      timeout: 1000,
      memoryLimit: -1,
      envVars: {},
      command: ['/bin/bash', '/pkgs/python/3.14.4/run', 'main.py'],
      identity: {
        slot: 2,
        uid: 200002,
        gid: 300002,
        perJobUid: true,
      },
    });

    expect(valueAfter(args, '--user')).toBe('65534:200002:1');
    expect(valueAfter(args, '--group')).toBe('65534:300002:1');
  });

  test('full Debian mode runs as guest root with writable system mounts', () => {
    const originalFullDebianMode = config.full_debian_mode;
    const originalDisableNetworking = config.disable_networking;
    config.full_debian_mode = true;
    config.disable_networking = false;
    try {
      const args = buildArgs({
        logPath: '/tmp/nsjail-test.log',
        pkgdir: '/pkgs/bash/5.2.0',
        timeout: 1000,
        memoryLimit: -1,
        envVars: {},
        command: ['/bin/bash', '/pkgs/bash/5.2.0/run', 'main.sh'],
        identity: { slot: 0, uid: 200000, gid: 200000, perJobUid: true },
      });

      expect(valueAfter(args, '--user')).toBe('0:0:65536');
      expect(valueAfter(args, '--group')).toBe('0:0:65536');
      expect(args).toContain('--keep_caps');
      for (const symlink of [
        '/usr/sbin:/sbin',
        '/dev/pts/ptmx:/dev/ptmx',
        '/proc/self/fd:/dev/fd',
        '/proc/self/fd/0:/dev/stdin',
        '/proc/self/fd/1:/dev/stdout',
        '/proc/self/fd/2:/dev/stderr',
      ]) {
        expect(hasArgPair(args, '-s', symlink)).toBe(true);
      }
      for (const mount of ['/usr', '/etc', '/var', '/opt', '/root', '/home', '/srv', '/run']) {
        expect(hasArgPair(args, '-B', `${mount}:${mount}`)).toBe(true);
      }
      expect(hasArgPair(args, '-B', '/tmp/codeapi-resolv.conf:/etc/resolv.conf')).toBe(true);
      expect(hasArgPair(args, '-R', '/tmp/codeapi-resolv.conf:/etc/resolv.conf')).toBe(false);

      const overlay = renderJobConfigOverlay('/tmp/submission', '/tmp/dependencies');
      expect(overlay).not.toContain('    noexec: true');
    } finally {
      config.full_debian_mode = originalFullDebianMode;
      config.disable_networking = originalDisableNetworking;
    }
  });

  test('provides private PTYs, shared memory, and standard random devices', async () => {
    const cfg = await fsp.readFile(new URL('../config/sandbox.cfg', import.meta.url), 'utf8');

    expect(cfg).toContain('dst: "/dev/pts"');
    expect(cfg).toContain('fstype: "devpts"');
    expect(cfg).toContain('options: "newinstance,ptmxmode=0666,mode=0620,gid=5"');
    expect(cfg).toContain('src: "/dev/random"');
    expect(cfg).toContain('dst: "/dev/tty"');
    expect(cfg).toContain('dst: "/dev/shm"');
    expect(cfg).toContain('options: "size=64m,mode=1777"');
  });

  test('does not bind /mnt/data via -B (the per-job cfg overlay handles it with noexec)', () => {
    /* Regression guard: the dynamic /mnt/data bind used to be `-B
     * <submissionDir>:/mnt/data` on the CLI, which NsJail accepts but has
     * no syntax for noexec/nosuid/nodev. Moving the mount into the cfg
     * overlay (renderJobConfigOverlay) is what unlocks those flags. If
     * a future edit reintroduces a CLI -B for /mnt/data the cfg overlay
     * would race or duplicate with the inline form, so explicitly assert
     * neither -B nor -R points at /mnt/data. */
    const args = buildArgs({
      logPath: '/tmp/nsjail-test.log',
      pkgdir: '/pkgs/python/3.14.4',
      timeout: 1000,
      memoryLimit: -1,
      envVars: {},
      command: ['/bin/bash', '/pkgs/python/3.14.4/run', 'main.py'],
      identity: { slot: 0, uid: 65534, gid: 65534, perJobUid: false },
    });
    for (let i = 0; i < args.length - 1; i++) {
      if ((args[i] === '-B' || args[i] === '-R') && args[i + 1].endsWith(':/mnt/data')) {
        throw new Error(`unexpected CLI mount for /mnt/data: ${args[i]} ${args[i + 1]}`);
      }
    }
  });

  test('uses caller-supplied cfg path when provided (per-job cfg overlay path)', () => {
    const args = buildArgs({
      logPath: '/tmp/nsjail-test.log',
      cfgPath: '/tmp/nsjail-job-xyz.cfg',
      pkgdir: '/pkgs/python/3.14.4',
      timeout: 1000,
      memoryLimit: -1,
      envVars: {},
      command: ['/bin/bash', '/pkgs/python/3.14.4/run', 'main.py'],
      identity: { slot: 0, uid: 65534, gid: 65534, perJobUid: false },
    });
    expect(valueAfter(args, '--config')).toBe('/tmp/nsjail-job-xyz.cfg');
  });

  test('does not export TOOL_CALL_SOCKET into the jail (preamble references the literal path)', () => {
    const args = buildArgs({
      logPath: '/tmp/nsjail-test.log',
      pkgdir: '/pkgs/python/3.14.4',
      timeout: 1000,
      memoryLimit: -1,
      envVars: {},
      command: ['/bin/bash', '/pkgs/python/3.14.4/run', 'main.py'],
      identity: { slot: 0, uid: 65534, gid: 65534, perJobUid: false },
    });
    /* Pair-wise scan of -E flags: every other slot is an envar key=value. */
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-E' && args[i + 1].startsWith('TOOL_CALL_SOCKET=')) {
        throw new Error(`unexpected TOOL_CALL_SOCKET envar: ${args[i + 1]}`);
      }
    }
  });

  test('binds the tool-call socket only for jobs that explicitly request it', () => {
    const originalAllowedPort = config.allowed_local_network_port;
    config.allowed_local_network_port = 3190;
    try {
      const baseOpts = {
        logPath: '/tmp/nsjail-test.log',
        pkgdir: '/pkgs/python/3.14.4',
        timeout: 1000,
        memoryLimit: -1,
        envVars: {},
        command: ['/bin/bash', '/pkgs/python/3.14.4/run', 'main.py'],
        identity: { slot: 0, uid: 65534, gid: 65534, perJobUid: false },
      };

      const withoutSocket = buildArgs(baseOpts);
      expect(hasArgPair(withoutSocket, '-B', '/tmp/tcs.sock:/tmp/tcs.sock')).toBe(false);

      const withSocket = buildArgs({ ...baseOpts, enableToolCallSocket: true });
      expect(hasArgPair(withSocket, '-B', '/tmp/tcs.sock:/tmp/tcs.sock')).toBe(true);
    } finally {
      config.allowed_local_network_port = originalAllowedPort;
    }
  });
});

describe('execute', () => {
  test('captures stdout from a child that exits before the setup gate returns', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nsjail-fast-child-'));
    const fakeNsJail = path.join(tmp, 'fake-nsjail.sh');
    const cfg = path.join(tmp, 'sandbox.cfg');
    const submissionDir = path.join(tmp, 'submission');
    await fsp.mkdir(submissionDir);
    await fsp.writeFile(cfg, '');
    await fsp.writeFile(
      fakeNsJail,
      `#!/bin/sh
log_path=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--log" ]; then
    shift
    log_path="$1"
  fi
  shift || break
done
if [ -n "$log_path" ]; then
  printf '[I][test] Executing "/bin/bash" for fast child\\n' > "$log_path"
fi
printf 'fast child stdout\\n'
exit 0
`,
      { mode: 0o755 },
    );

    const originalNsJailPath = config.nsjail_path;
    const originalNsJailConfig = config.nsjail_config;
    config.nsjail_path = fakeNsJail;
    config.nsjail_config = cfg;
    try {
      const result = await execute({
        command: ['/bin/bash', '/pkgs/bash/5.2.0/run', 'main.sh'],
        envVars: {},
        submissionDir,
        dependencyDir: path.join(tmp, 'dependencies'),
        pkgdir: '/pkgs/bash/5.2.0',
        timeout: 1000,
        memoryLimit: -1,
        outputMaxSize: 1024,
        identity: { slot: 0, uid: 65534, gid: 65534, perJobUid: false },
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('fast child stdout\n');
      expect(result.output).toBe('fast child stdout\n');
    } finally {
      config.nsjail_path = originalNsJailPath;
      config.nsjail_config = originalNsJailConfig;
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  test('stderr overflow truncates with an in-band marker instead of killing the job', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nsjail-stderr-overflow-'));
    const fakeNsJail = path.join(tmp, 'fake-nsjail.sh');
    const cfg = path.join(tmp, 'sandbox.cfg');
    const submissionDir = path.join(tmp, 'submission');
    await fsp.mkdir(submissionDir);
    await fsp.writeFile(cfg, '');
    await fsp.writeFile(
      fakeNsJail,
      `#!/bin/sh
log_path=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--log" ]; then
    shift
    log_path="$1"
  fi
  shift || break
done
if [ -n "$log_path" ]; then
  printf '[I][test] Executing "/bin/bash" for noisy child\\n' > "$log_path"
fi
head -c 3000 /dev/zero | tr '\\0' 'e' 1>&2
printf 'survived the noise\\n'
exit 0
`,
      { mode: 0o755 },
    );

    const originalNsJailPath = config.nsjail_path;
    const originalNsJailConfig = config.nsjail_config;
    config.nsjail_path = fakeNsJail;
    config.nsjail_config = cfg;
    try {
      const result = await execute({
        command: ['/bin/bash', '/pkgs/bash/5.2.0/run', 'main.sh'],
        envVars: {},
        submissionDir,
        dependencyDir: path.join(tmp, 'dependencies'),
        pkgdir: '/pkgs/bash/5.2.0',
        timeout: 5000,
        memoryLimit: -1,
        outputMaxSize: 1024,
        identity: { slot: 0, uid: 65534, gid: 65534, perJobUid: false },
      });

      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe('survived the noise\n');
      expect(result.message).toBe('stderr truncated at 1024 bytes');
      expect(result.stderr.endsWith('\n[sandbox] stderr truncated at 1024 bytes\n')).toBe(true);
      expect(result.stderr.length).toBeLessThanOrEqual(
        1024 + '\n[sandbox] stderr truncated at 1024 bytes\n'.length,
      );
    } finally {
      config.nsjail_path = originalNsJailPath;
      config.nsjail_config = originalNsJailConfig;
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  test('kill reasons surface as an in-band [sandbox] marker on stderr', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nsjail-kill-marker-'));
    const fakeNsJail = path.join(tmp, 'fake-nsjail.sh');
    const cfg = path.join(tmp, 'sandbox.cfg');
    const submissionDir = path.join(tmp, 'submission');
    await fsp.mkdir(submissionDir);
    await fsp.writeFile(cfg, '');
    await fsp.writeFile(
      fakeNsJail,
      `#!/bin/sh
log_path=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--log" ]; then
    shift
    log_path="$1"
  fi
  shift || break
done
if [ -n "$log_path" ]; then
  printf '[I][test] Executing "/bin/bash" for slow child\\n' > "$log_path"
  printf '[W][test] run time >= time limit\\n' >> "$log_path"
fi
exit 137
`,
      { mode: 0o755 },
    );

    const originalNsJailPath = config.nsjail_path;
    const originalNsJailConfig = config.nsjail_config;
    config.nsjail_path = fakeNsJail;
    config.nsjail_config = cfg;
    try {
      const result = await execute({
        command: ['/bin/bash', '/pkgs/bash/5.2.0/run', 'main.sh'],
        envVars: {},
        submissionDir,
        dependencyDir: path.join(tmp, 'dependencies'),
        pkgdir: '/pkgs/bash/5.2.0',
        timeout: 5000,
        memoryLimit: -1,
        outputMaxSize: 1024,
        identity: { slot: 0, uid: 65534, gid: 65534, perJobUid: false },
      });

      expect(result.status).toBe('TO');
      expect(result.message).toBe('Time limit exceeded');
      expect(result.stderr.endsWith('\n[sandbox] Time limit exceeded\n')).toBe(true);
      expect(result.output.endsWith('\n[sandbox] Time limit exceeded\n')).toBe(true);
    } finally {
      config.nsjail_path = originalNsJailPath;
      config.nsjail_config = originalNsJailConfig;
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('renderJobConfigOverlay', () => {
  test('binds data noexec and exposes a separate executable dependency layer', () => {
    const overlay = renderJobConfigOverlay(
      '/tmp/sandbox/ws_data',
      '/tmp/sandbox/ws_dependencies',
    );
    /* Property-style assertions on the rendered Kafel/protobuf cfg. We
     * keep them line-anchored so a stray `noexec: false` elsewhere can't
     * accidentally satisfy the test. */
    expect(overlay).toMatch(/^\s*src: "\/tmp\/sandbox\/ws_data"$/m);
    expect(overlay).toMatch(/^\s*dst: "\/mnt\/data"$/m);
    expect(overlay).toMatch(/^\s*is_bind: true$/m);
    expect(overlay).toMatch(/^\s*rw: true$/m);
    expect(overlay).toMatch(/^\s*noexec: true$/m);
    expect(overlay).toMatch(/^\s*nosuid: true$/m);
    expect(overlay).toMatch(/^\s*nodev: true$/m);
    expect(overlay).toMatch(/^\s*src: "\/tmp\/sandbox\/ws_dependencies"$/m);
    expect(overlay).toMatch(/^\s*dst: "\/mnt\/deps"$/m);

    const dependencyBlock = overlay.match(
      /mount \{\n\s*src: "\/tmp\/sandbox\/ws_dependencies"[\s\S]*?\n\}/,
    )?.[0];
    expect(dependencyBlock).toBeDefined();
    expect(dependencyBlock).toMatch(/^\s*rw: true$/m);
    expect(dependencyBlock).toMatch(/^\s*nosuid: true$/m);
    expect(dependencyBlock).toMatch(/^\s*nodev: true$/m);
    expect(dependencyBlock).not.toMatch(/^\s*noexec: true$/m);
  });

  test('escapes double quotes and backslashes so a quirky path cannot break the cfg parser', () => {
    /* Production paths come from createSandboxWorkspace and contain no
     * meta-chars, but defense in depth: a future caller that passes an
     * arbitrary path must not be able to inject extra cfg fields by
     * embedding `" rw: false }` etc. */
    const overlay = renderJobConfigOverlay(
      '/tmp/sandbox/ws"data\\path',
      '/tmp/sandbox/ws"dependencies\\path',
    );
    expect(overlay).toContain('src: "/tmp/sandbox/ws\\"data\\\\path"');
    expect(overlay).toContain('src: "/tmp/sandbox/ws\\"dependencies\\\\path"');
    /* An injected `"` must not terminate either source string mid-stream. */
    const srcLines = overlay.split('\n').filter(l => l.includes('src:'));
    expect(srcLines).toHaveLength(2);
    expect(srcLines.every(line => line.includes('ws\\"'))).toBe(true);
  });
});

describe('NsJail seccomp policy', () => {
  /* These tests are regression coverage for the seccomp-hardening audit
   * (see PR description). They check the rendered Kafel source, not the
   * BPF program — that's enough to catch accidental removal of a rule, and
   * the actual BPF behavior is exercised end-to-end by the runner image. */

  test('KILLs setns to close the namespace-join surface that unshare already covers', () => {
    /* `\b` ensures we don't accidentally pick up substrings like
     * `setnsxxx`; the comma OR closing-brace bound matches Kafel syntax. */
    expect(seccompPolicy()).toMatch(/\bsetns\b[,\s]/);
  });

  test('KILLs the new mount API family (Linux 5.2+)', () => {
    const policy = seccompPolicy();
    for (const name of ['move_mount', 'open_tree', 'fsopen', 'fsmount', 'fspick']) {
      expect(policy).toMatch(new RegExp(`\\b${name}\\b[,\\s]`));
    }
  });

  test('defines explicit syscall numbers for the new mount API (avoids Kafel symbol drift)', () => {
    const policy = seccompPolicy();
    expect(policy).toContain('#define open_tree 428');
    expect(policy).toContain('#define move_mount 429');
    expect(policy).toContain('#define fsopen 430');
    expect(policy).toContain('#define fsmount 432');
    expect(policy).toContain('#define fspick 433');
  });

  test('KILLs AF_VSOCK in the socket(domain) filter', () => {
    const policy = seccompPolicy();
    expect(policy).toContain('#define AF_VSOCK 40');
    const killBlock = policy.split('KILL {')[1]?.split('  },')[0] ?? '';
    const errnoBlock = policy.split('ERRNO(1)')[1] ?? '';

    const killSocketRule = killBlock.split('\n').find(line => line.includes('socket(domain)'));
    expect(killSocketRule).toBeDefined();
    expect(killSocketRule).toContain('AF_VSOCK');

    const errnoSocketRule = errnoBlock.split('\n').find(line => line.includes('socket(domain, sock_type, protocol)'));
    expect(errnoSocketRule).toBeDefined();
    expect(errnoSocketRule).not.toContain('AF_VSOCK');
  });

  test('rejects kernel-control socket entry points in the sandbox', () => {
    const policy = seccompPolicy();
    const errnoBlock = policy.split('ERRNO(1)')[1] ?? '';
    const socketRule = errnoBlock.split('\n').find(line => line.includes('socket(domain, sock_type, protocol)'));
    expect(socketRule).toBeDefined();
    for (const family of ['AF_ALG', 'AF_RXRPC', 'AF_NETLINK', 'AF_KEY']) {
      expect(socketRule).toContain(family);
    }
    expect(socketRule).not.toContain('AF_VSOCK');
  });

  test('allows Internet socket families only when networking is enabled', () => {
    const originalDisableNetworking = config.disable_networking;
    const internetFamilyPattern = /\bAF_INET6?\b/;
    const socketRule = () => {
      const errnoBlock = seccompPolicy().split('ERRNO(1)')[1] ?? '';
      return errnoBlock.split('\n').find(line => line.includes('socket(domain, sock_type, protocol)')) ?? '';
    };

    try {
      config.disable_networking = true;
      expect(socketRule()).toMatch(internetFamilyPattern);

      config.disable_networking = false;
      expect(socketRule()).not.toMatch(internetFamilyPattern);
    } finally {
      config.disable_networking = originalDisableNetworking;
    }
  });

  test('allows only route and socket-diagnostic netlink protocols when networking is enabled', () => {
    const originalDisableNetworking = config.disable_networking;
    const originalFullDebianMode = config.full_debian_mode;
    const socketRule = () => {
      const errnoBlock = seccompPolicy().split('ERRNO(1)')[1] ?? '';
      return errnoBlock.split('\n').find(line => line.includes('socket(domain, sock_type, protocol)')) ?? '';
    };

    try {
      config.full_debian_mode = false;
      config.disable_networking = true;
      expect(socketRule()).toContain('domain == AF_NETLINK ||');
      expect(socketRule()).not.toContain('protocol != NETLINK_ROUTE');

      config.disable_networking = false;
      expect(socketRule()).toContain(
        '(domain == AF_NETLINK && protocol != NETLINK_ROUTE && protocol != NETLINK_SOCK_DIAG)',
      );
      expect(seccompPolicy()).toContain('#define NETLINK_ROUTE 0');
      expect(seccompPolicy()).toContain('#define NETLINK_SOCK_DIAG 4');
    } finally {
      config.disable_networking = originalDisableNetworking;
      config.full_debian_mode = originalFullDebianMode;
    }
  });

  test('allows audit netlink only in full Debian mode', () => {
    const originalDisableNetworking = config.disable_networking;
    const originalFullDebianMode = config.full_debian_mode;
    const socketRule = () => {
      const errnoBlock = seccompPolicy().split('ERRNO(1)')[1] ?? '';
      return errnoBlock.split('\n').find(line => line.includes('socket(domain, sock_type, protocol)')) ?? '';
    };

    try {
      config.full_debian_mode = true;
      config.disable_networking = true;
      expect(socketRule()).toContain(
        '(domain == AF_NETLINK && protocol != NETLINK_AUDIT)',
      );

      config.disable_networking = false;
      expect(socketRule()).toContain('protocol != NETLINK_AUDIT');
      expect(seccompPolicy()).toContain('#define NETLINK_AUDIT 9');
    } finally {
      config.disable_networking = originalDisableNetworking;
      config.full_debian_mode = originalFullDebianMode;
    }
  });

  test('KILLs the defense-in-depth batch from the audit', () => {
    const policy = seccompPolicy();
    for (const name of ['settimeofday', 'adjtimex', 'clock_adjtime', 'syslog']) {
      expect(policy).toMatch(new RegExp(`\\b${name}\\b[,\\s]`));
    }
  });

  test('x86-only syscalls are gated on architecture', () => {
    const policy = seccompPolicy();
    const x86Only = ['ioperm', 'iopl', 'modify_ldt', 'lookup_dcookie'];
    if (process.arch === 'arm64') {
      /* arm64 must NOT mention these — Kafel will fail to parse a symbol
       * that has no #define and no entry in its syscall table for the
       * current architecture. */
      for (const name of x86Only) {
        expect(policy).not.toMatch(new RegExp(`\\b${name}\\b`));
      }
    } else {
      for (const name of x86Only) {
        expect(policy).toMatch(new RegExp(`\\b${name}\\b[,\\s]`));
      }
    }
  });

  test('preserves the previously-blocked surface (regression guard)', () => {
    const policy = seccompPolicy();
    /* If a future edit accidentally drops one of these, this test will
     * catch it before the policy ships. Not exhaustive — just the entries
     * that have been audit-critical historically. */
    for (const name of [
      'ptrace', 'memfd_create', 'userfaultfd',
      'kexec_load', 'kexec_file_load',
      'mount', 'umount2', 'pivot_root',
      'init_module', 'finit_module', 'delete_module',
      'unshare', 'seccomp',
      'process_vm_readv', 'process_vm_writev',
      'add_key', 'request_key', 'keyctl',
      'swapon', 'swapoff', 'reboot',
    ]) {
      expect(policy).toMatch(new RegExp(`\\b${name}\\b[,\\s]`));
    }
    expect(policy).toContain('clone3');
    expect(policy).toContain('vmsplice');
    expect(policy).toContain('clone(flags) { (flags & CLONE_NAMESPACE_FLAGS) != 0 }');
  });

  test('does not emit a blank Kafel line on arm64 (filter strips empty arch slot)', () => {
    /* archSpecificLowPrioritySyscalls is '' on arm64; if we forget to
     * filter empty entries out of the joined policy, Kafel parses a blank
     * line and rejects it. */
    const policy = seccompPolicy();
    expect(policy.split('\n').every(line => line.length > 0)).toBe(true);
  });

  test('returns EPERM (not SIGSYS) for kill/tkill/tgkill targeting PID 1 of the sandbox PID ns', () => {
    /* PID 1 inside the sandbox PID namespace is the NsJail monitor.
     * `clone_newpid: true` already prevents reaching other tenants — this
     * rule is principled defense for the in-ns supervisor. ERRNO(1)
     * (EPERM) matches the kernel's own response to unprivileged init
     * signaling so probes like `os.kill(1, 0)` get the expected error
     * shape instead of dying with SIGSYS. */
    const policy = seccompPolicy();
    const errnoBlock = policy.split('ERRNO(1)')[1] ?? '';
    expect(errnoBlock).toMatch(/\bkill\(pid\)\s*\{[^}]*pid\s*==\s*1[^}]*\}/);
    expect(errnoBlock).toMatch(/\btkill\(tid\)\s*\{[^}]*tid\s*==\s*1[^}]*\}/);
    expect(errnoBlock).toMatch(/\btgkill\(tgid,\s*tid\)\s*\{[^}]*\}/);
  });

  test('also blocks kill(0) (process group) and kill(-1) (everything signalable)', () => {
    /* Both forms fan out within the caller's PID namespace and would
     * land on PID 1 (the monitor) along with siblings. The seccomp
     * comparison is unsigned 32-bit so -1 is encoded as 0xFFFFFFFF. */
    const policy = seccompPolicy();
    const killRule = policy.split('\n').find(l => l.match(/\bkill\(pid\)/));
    expect(killRule).toBeDefined();
    expect(killRule).toContain('pid == 0');
    expect(killRule).toContain('pid == 0xFFFFFFFF');
  });

  test('blocks pidfd_send_signal entirely and pidfd_open(pid==1)', () => {
    /* pidfd_send_signal accepts a pidfd, not a pid — we cannot filter
     * the destination at the syscall layer, and a pidfd to PID 1 can be
     * obtained via openat("/proc/1", O_RDONLY) (Linux 5.4+) bypassing
     * pidfd_open. So block the send entirely and also block the obvious
     * pidfd_open(pid==1) acquisition path. */
    const policy = seccompPolicy();
    const errnoBlock = policy.split('ERRNO(1)')[1] ?? '';
    expect(errnoBlock).toMatch(/\bpidfd_send_signal\b[,\s]/);
    expect(errnoBlock).toMatch(/\bpidfd_open\(pid\)\s*\{[^}]*pid\s*==\s*1[^}]*\}/);
  });

  test('blocks the rt_sigqueueinfo / rt_tgsigqueueinfo equivalents of kill targeting PID 1', () => {
    /* `kill` is the obvious entry point but the kernel exposes two more
     * signal-delivery syscalls that take a numeric pid/tid. Without these
     * the seccomp filter would only catch the most-common attack form. */
    const policy = seccompPolicy();
    const errnoBlock = policy.split('ERRNO(1)')[1] ?? '';
    expect(errnoBlock).toMatch(/\brt_sigqueueinfo\(pid\)\s*\{[^}]*pid\s*==\s*1[^}]*\}/);
    expect(errnoBlock).toMatch(/\brt_tgsigqueueinfo\(tgid,\s*tid\)\s*\{[^}]*\}/);
  });

  test('defines explicit syscall numbers for pidfd_* (avoids Kafel symbol drift)', () => {
    const policy = seccompPolicy();
    expect(policy).toContain('#define pidfd_send_signal 424');
    expect(policy).toContain('#define pidfd_open 434');
  });
});
