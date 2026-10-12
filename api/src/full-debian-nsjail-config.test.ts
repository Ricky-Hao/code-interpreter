import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { renderFullDebianNsJailConfig } from './full-debian-nsjail-config';

describe('full Debian NsJail config', () => {
  test('enables loopback without changing the hardened base config', () => {
    const base = fs.readFileSync(path.join(__dirname, '../config/sandbox.cfg'), 'utf8');
    const rendered = renderFullDebianNsJailConfig(base);

    expect(base).toContain('iface_no_lo: true');
    expect(rendered).toContain('iface_no_lo: false');
    expect(rendered).not.toContain('iface_no_lo: true');
    expect(rendered.split(/\r?\n/)).toContain('iface_no_lo: false');
  });

  test('allows temporary executables only in full Debian mode', () => {
    const base = fs.readFileSync(path.join(__dirname, '../config/sandbox.cfg'), 'utf8');
    const rendered = renderFullDebianNsJailConfig(base);
    const tmpMount = (config: string) => config.match(/mount \{[^}]*dst: "\/tmp"[^}]*\}/s)?.[0];

    expect(tmpMount(base)).toContain('noexec: true');
    expect(tmpMount(rendered)).toContain('noexec: false');
    expect(rendered.match(/dst: "\/dev\/shm"[^}]*noexec: true/s)).not.toBeNull();
  });

  test('removes hardened mounts shadowed by writable system binds', () => {
    const base = fs.readFileSync(path.join(__dirname, '../config/sandbox.cfg'), 'utf8');
    const rendered = renderFullDebianNsJailConfig(base);

    expect(rendered).not.toMatch(/dst:\s*"\/(?:usr|etc|var)(?:\/|")/);
    expect(rendered).toContain('dst: "/proc"');
    expect(rendered).toContain('dst: "/dev/null"');
    expect(rendered).toContain('dst: "/tmp"');
  });

  test('exposes useful guest proc data while retaining sensitive masks', () => {
    const base = fs.readFileSync(path.join(__dirname, '../config/sandbox.cfg'), 'utf8');
    const rendered = renderFullDebianNsJailConfig(base);

    for (const destination of [
      '/proc/cpuinfo',
      '/proc/meminfo',
      '/proc/uptime',
      '/proc/loadavg',
      '/proc/stat',
    ]) {
      expect(base).toContain(`dst: "${destination}"`);
      expect(rendered).not.toContain(`dst: "${destination}"`);
    }
    expect(rendered).toContain('dst: "/proc/cmdline"');
    expect(rendered).toContain('dst: "/proc/kallsyms"');
  });

  test('entrypoint CLI renders the same config with private output permissions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'full-debian-config-cli-'));
    try {
      const input = path.join(__dirname, '../config/sandbox.cfg');
      const output = path.join(root, 'sandbox.cfg');
      execFileSync(process.execPath, ['run', path.join(__dirname, 'full-debian-nsjail-config.ts'), input, output]);
      expect(fs.readFileSync(output, 'utf8')).toBe(renderFullDebianNsJailConfig(fs.readFileSync(input, 'utf8')));
      expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
