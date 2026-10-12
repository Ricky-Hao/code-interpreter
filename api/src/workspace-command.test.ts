import { mkdtemp, mkdir, realpath, rm, symlink, stat, lstat, writeFile, readFile, readlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import semver from 'semver';

import type { Runtime } from './runtime';
import {
  executeWorkspaceCommand as executeWorkspaceCommandImpl,
  hasWorkspaceCommandToken,
  WorkspaceCommandRequestError,
} from './workspace-command';
import type { WorkspaceCommandExecutionOptions } from './workspace-command';

function executeWorkspaceCommand(body: unknown, options: WorkspaceCommandExecutionOptions) {
  return executeWorkspaceCommandImpl(body, {
    ...options,
    // Exercise lifecycle without requiring root/chown or shared production paths.
    createDependencyWorkspace: async identity => {
      const dir = await mkdtemp(join(tmpdir(), 'workspace-command-deps-'));
      return { dir, workspaceId: dir, identity };
    },
  });
}

const runtime: Runtime = {
  language: 'bash',
  version: new semver.SemVer('5.2.0'),
  aliases: [],
  pkgdir: '/pkgs/bash/5.2.0',
  compiled: false,
  env_vars: { PATH: '/usr/bin:/bin' },
  timeouts: { compile: 30_000, run: 30_000 },
  cpu_times: { compile: 30_000, run: 30_000 },
  memory_limits: { compile: 256_000_000, run: 256_000_000 },
  max_process_count: 64,
  max_open_files: 2048,
  max_file_size: 10_000_000,
  output_max_size: 1024,
};

const successfulResult = {
  stdout: 'ok', stderr: '', code: 0, signal: null, output: 'ok',
  memory: null, message: null, status: null, cpu_time: null, wall_time: 1,
};

describe('sandboxed workspace commands', () => {
  test('requires an exact high-entropy runner capability', () => {
    const token = 'a'.repeat(32);
    expect(hasWorkspaceCommandToken(token, token)).toBe(true);
    expect(hasWorkspaceCommandToken(token, `${token}x`)).toBe(false);
    expect(hasWorkspaceCommandToken(token, undefined)).toBe(false);
    expect(hasWorkspaceCommandToken('short', 'short')).toBe(false);
  });

  test('passes command and canonical cwd as arguments to NsJail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-command-'));
    try {
      await mkdir(join(root, 'src'));
      let captured: Parameters<NonNullable<WorkspaceCommandExecutionOptions['executeNsJail']>>[0] | undefined;
      const response = await executeWorkspaceCommand({
        command: 'printf ok',
        cwd: 'src',
        timeoutMs: 1234,
        maxOutputBytes: 64,
      }, {
        workspaceRoot: root,
        runtime,
        executeNsJail: async (options) => {
          captured = options;
          expect((await stat(options.dependencyDir)).isDirectory()).toBe(true);
          expect(options.dependencyDir).not.toBe(options.submissionDir);
          return {
            stdout: 'ok', stderr: '', code: 0, signal: null, output: 'ok',
            memory: null, message: null, status: null, cpu_time: null, wall_time: 1,
          };
        },
      });

      expect(captured?.command).toEqual([
        '/bin/bash', '--noprofile', '--norc', '-c',
        'cd -- "$1" && exec /bin/bash --noprofile --norc -c "$2"',
        'librechat-code', '/mnt/data/src', 'printf ok',
      ]);
      expect(captured?.submissionDir).toBe(await realpath(root));
      await expect(stat(captured!.dependencyDir)).rejects.toHaveProperty('code', 'ENOENT');
      expect(captured?.timeout).toBe(1234);
      expect(captured?.outputMaxSize).toBe(64);
      expect(response).toEqual({
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        truncated: false,
        timedOut: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects a cwd symlink that escapes the mounted workspace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'workspace-command-'));
    try {
      const root = join(parent, 'root');
      await mkdir(root);
      await symlink(parent, join(root, 'escape'));
      await expect(executeWorkspaceCommand({
        command: 'pwd',
        cwd: 'escape',
      }, { workspaceRoot: root, runtime, executeNsJail: async () => { throw new Error('must not run'); } }))
        .rejects.toBeInstanceOf(WorkspaceCommandRequestError);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('removes the per-command dependency layer on spawn failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-command-'));
    let dependencyDir = '';
    try {
      await expect(executeWorkspaceCommand({ command: 'true' }, {
        workspaceRoot: root, runtime,
        executeNsJail: async options => {
          dependencyDir = options.dependencyDir;
          throw new Error('spawn failed');
        },
      })).rejects.toThrow('spawn failed');
      expect(dependencyDir).not.toBe('');
      await expect(stat(dependencyDir)).rejects.toHaveProperty('code', 'ENOENT');
      expect((await stat(root)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('dependency environment supports Python and Node imports while preserving runtime paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-command-imports-'));
    try {
      await executeWorkspaceCommand({ command: 'import dependencies' }, {
        workspaceRoot: root,
        runtime: { ...runtime, env_vars: { ...runtime.env_vars, PYTHONPATH: '/baked/python', NODE_PATH: '/baked/node_modules' } },
        executeNsJail: async options => {
          const env = options.envVars;
          expect(env.PYTHONPATH).toBe('/mnt/deps/python:/baked/python');
          expect(env.NODE_PATH).toBe('/mnt/deps/js/node_modules:/baked/node_modules');
          expect(env.PIP_TARGET).toBe('/mnt/deps/python');
          expect(env.NPM_CONFIG_PREFIX).toBe('/mnt/deps/js');
          expect(env.SANDBOX_DEPS_ROOT).toBe('/mnt/deps');
          expect(env.SANDBOX_DATA_ROOT).toBe('/mnt/data');
          expect(env.PATH).toStartWith('/mnt/deps/bin:/mnt/deps/python/bin:/mnt/deps/js/node_modules/.bin:');
          expect(env.PATH).toContain('/usr/bin:/bin');
          for (const key of ['PIP_CACHE_DIR', 'UV_CACHE_DIR', 'NPM_CONFIG_CACHE', 'BUN_INSTALL', 'TMPDIR']) {
            expect(env[key]).toStartWith('/mnt/deps/');
          }
          expect((await stat(join(options.dependencyDir, 'tmp'))).isDirectory()).toBe(true);
          await mkdir(join(options.dependencyDir, 'python'));
          await writeFile(join(options.dependencyDir, 'python', 'review_dependency.py'), 'value = "python-import-ok"\n');
          await mkdir(join(options.dependencyDir, 'js/node_modules/review-dependency'), { recursive: true });
          await writeFile(join(options.dependencyDir, 'js/node_modules/review-dependency/index.js'), 'module.exports = "node-import-ok";');
          // Real interpreters, fixture files instead of registry downloads. Translate
          // only the jail mount prefixes; this is not a live NsJail mount test.
          const localEnv = Object.fromEntries(Object.entries(env).map(([key, value]) => [
            key, value.split('/mnt/deps').join(options.dependencyDir).split('/mnt/data').join(root),
          ]));
          expect(execFileSync('python3', ['-c', 'import review_dependency; print(review_dependency.value)'], {
            env: { ...process.env, ...localEnv }, encoding: 'utf8',
          }).trim()).toBe('python-import-ok');
          // Resolve the host interpreter before applying the fixture's jail PATH.
          expect(execFileSync(Bun.which('node') ?? 'node', ['-p', 'require("review-dependency")'], {
            env: { ...process.env, ...localEnv }, encoding: 'utf8',
          }).trim()).toBe('node-import-ok');
          return successfulResult;
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const fails of [false, true]) {
    test(`removes stale and newly installed dependency links on ${fails ? 'failure' : 'success'}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'workspace-command-links-'));
      const link = join(root, 'node_modules');
      let dependencyDir = '';
      try {
        await symlink('/mnt/deps/js/node_modules', link);
        const running = executeWorkspaceCommand({ command: 'sandbox-pkg npm fixture' }, {
          workspaceRoot: root, runtime,
          executeNsJail: async options => {
            dependencyDir = options.dependencyDir;
            await expect(lstat(link)).rejects.toHaveProperty('code', 'ENOENT');
            await symlink('/mnt/deps/js/node_modules', link);
            if (fails) throw new Error('execution failed after package activation');
            return successfulResult;
          },
        });
        if (fails) await expect(running).rejects.toThrow('execution failed after package activation');
        else expect((await running).exitCode).toBe(0);
        await expect(lstat(link)).rejects.toHaveProperty('code', 'ENOENT');
        await expect(stat(dependencyDir)).rejects.toHaveProperty('code', 'ENOENT');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    for (const isLink of [false, true]) {
      test(`preserves preexisting ${isLink ? 'unrelated symlink' : 'real node_modules'} on ${fails ? 'failure' : 'success'}`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'workspace-command-existing-'));
        const modules = join(root, 'node_modules');
        try {
          if (isLink) await symlink('/preexisting/user-modules', modules);
          else {
            await mkdir(modules);
            await writeFile(join(modules, 'user-data'), 'keep');
          }
          const running = executeWorkspaceCommand({ command: 'true' }, {
            workspaceRoot: root, runtime,
            executeNsJail: async () => {
              expect((await lstat(modules)).isSymbolicLink()).toBe(isLink);
              if (fails) throw new Error('fixture failure');
              return successfulResult;
            },
          });
          if (fails) await expect(running).rejects.toThrow('fixture failure');
          else await running;
          if (isLink) expect(await readlink(modules)).toBe('/preexisting/user-modules');
          else expect(await readFile(join(modules, 'user-data'), 'utf8')).toBe('keep');
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }

  test('rejects malformed requests before starting NsJail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-command-'));
    try {
      for (const body of [
        { command: '' },
        { command: 'pwd', cwd: '../outside' },
        { command: 'pwd', timeoutMs: 300_001 },
        { command: 'pwd', unexpected: true },
      ]) {
        await expect(executeWorkspaceCommand(body, {
          workspaceRoot: root,
          runtime,
          executeNsJail: async () => { throw new Error('must not run'); },
        })).rejects.toBeInstanceOf(WorkspaceCommandRequestError);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('bounds aggregate UTF-8 output and maps timeout state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-command-'));
    try {
      const response = await executeWorkspaceCommand({
        command: 'run',
        maxOutputBytes: 5,
      }, {
        workspaceRoot: root,
        runtime,
        executeNsJail: async () => ({
          stdout: '€€', stderr: 'tail', code: null, signal: 'SIGKILL', output: '',
          memory: null, message: 'Time limit exceeded', status: 'TO', cpu_time: null, wall_time: 1,
        }),
      });
      expect(Buffer.byteLength(response.stdout) + Buffer.byteLength(response.stderr)).toBeLessThanOrEqual(5);
      expect(response).toEqual({
        exitCode: null,
        signal: 'SIGKILL',
        stdout: '€',
        stderr: 'ta',
        truncated: true,
        timedOut: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
