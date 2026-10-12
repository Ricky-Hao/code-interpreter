import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import dockerignore from '@balena/dockerignore';

const root = path.resolve(__dirname, '../..');
const preamble = path.join(__dirname, 'packaged-runtime.sh');

test('all guest Dockerfile context COPY sources survive Dockerignore filtering', () => {
  for (const file of ['api/Dockerfile', 'launcher/Dockerfile', 'docker/Dockerfile.worker-sandbox']) {
    // Dockerfile-specific rules replace the context-root rules; api/.dockerignore
    // is not used when the build context is the repository root.
    const specific = path.join(root, `${file}.dockerignore`);
    const rules = readFileSync(existsSync(specific) ? specific : path.join(root, '.dockerignore'), 'utf8');
    const filter = dockerignore({ ignorecase: false }).add(rules);
    const dockerfile = readFileSync(path.join(root, file), 'utf8');
    let smokeCopies = 0;
    for (const line of dockerfile.split('\n')) {
      if (!line.startsWith('COPY ') || line.startsWith('COPY --from=')) continue;
      // All current context COPY instructions use plain, non-glob source paths.
      // Fail explicitly if the syntax changes rather than silently mis-parsing it.
      expect(line).not.toMatch(/["'\[\]*?\\]|--/);
      const fields = line.trim().split(/\s+/);
      for (const source of fields.slice(1, -1)) {
        const relative = source.replace(/\/$/, '');
        expect(existsSync(path.join(root, relative)), `${file}: missing ${source}`).toBe(true);
        expect(filter.ignores(relative), `${file}: ignored context COPY ${source}`).toBe(false);
        if (fields.at(-1) === '/tmp/packaged_pipe_runtime.sh') smokeCopies++;
      }
    }
    expect(smokeCopies, `${file}: missing packaged pipe gate COPY`).toBe(1);
    // These are copied through the api/src directory and then bundled, rather
    // than named individually in COPY instructions.
    for (const source of ['api/src/index.ts', 'api/src/pipe-process.ts', 'api/src/pipe-process-smoke.ts']) {
      expect(existsSync(path.join(root, source)), `${file}: missing bundle input ${source}`).toBe(true);
      expect(filter.ignores(source), `${file}: ignored bundle input ${source}`).toBe(false);
    }
    // Check files, not just their parent: Docker can re-include descendants of
    // an excluded directory. No existing test file may leak into these contexts.
    function checkExcludedTests(directory: string): void {
      for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
        const relative = `${directory}/${entry.name}`;
        if (entry.isDirectory()) checkExcludedTests(relative);
        else expect(filter.ignores(relative), `${file}: exposed ${relative}`).toBe(true);
      }
    }
    checkExcludedTests('tests');
    expect(filter.ignores('tests/future/nested-regression.sh')).toBe(true);
  }
});

test('guest preamble restores packaged API configuration after Docker ENV loss in both modes', () => {
  for (const mode of ['false', 'true']) {
    const result = spawnSync('/bin/bash', ['-ec', `
      function /usr/bin/timeout() { printf 'check:%s\\n' "$@"; }
      . "$1"
      printf 'addon:%s\\ncontrol:%s\\nmanifest:%s\\n' "$SANDBOX_PIPE_ADDON" "$SANDBOX_VM_CONTROL_TOKEN" "$SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY"
    `, 'fixture', preamble], { encoding: 'utf8', env: {
      PATH: '/usr/bin:/bin', SANDBOX_FULL_DEBIAN_MODE: mode,
      SANDBOX_VM_CONTROL_TOKEN: 'fixture-control', SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY: 'fixture-public',
    } });
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')).toEqual([
      'check:10', 'check:/usr/local/bin/sandbox-supervisor-policy',
      'check:/usr/local/bin/bun', 'check:/sandbox_api/.build/pipe-process-smoke.js',
      'addon:/usr/local/lib/anonymous-pipes.node', 'control:fixture-control', 'manifest:fixture-public', '',
    ]);
  }
});

test('packaged startup rejects a failed transport check and never honors a host addon override', () => {
  const result = spawnSync('/bin/bash', ['-ec', `
    function /usr/bin/timeout() { test "$SANDBOX_PIPE_ADDON" = /usr/local/lib/anonymous-pipes.node; return 42; }
    . "$1"
    echo API_STARTED
  `, 'fixture', preamble], { encoding: 'utf8', env: {
    PATH: '/usr/bin:/bin', SANDBOX_PIPE_ADDON: '/untrusted/override.node',
  } });
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain('API_STARTED');
  expect(result.stderr).toContain('FATAL: packaged anonymous-pipe startup check failed: /usr/local/lib/anonymous-pipes.node');
});

test('every packaged guest uses the same early preamble and sanitized native image gate', () => {
  const entrypoint = readFileSync(path.join(__dirname, 'entrypoint.sh'), 'utf8');
  expect(entrypoint).toContain('. /sandbox_api/packaged-runtime.sh');
  expect(entrypoint.indexOf('. /sandbox_api/packaged-runtime.sh')).toBeLessThan(entrypoint.indexOf('SANDBOX_FULL_DEBIAN_MODE'));
  expect(entrypoint).toContain('exec /usr/local/bin/sandbox-supervisor-policy bun run /sandbox_api/.build/index.js');
  for (const file of ['api/Dockerfile', 'launcher/Dockerfile', 'docker/Dockerfile.worker-sandbox']) {
    const dockerfile = readFileSync(path.join(root, file), 'utf8');
    expect(dockerfile).toContain('COPY --from=nsjail-builder /usr/local/lib/anonymous-pipes.node /usr/local/lib/anonymous-pipes.node');
    expect(dockerfile).toContain('COPY api/src/packaged-runtime.sh ./packaged-runtime.sh');
    expect(dockerfile).toContain('COPY docker/packaged-pipe-runtime.sh /tmp/packaged_pipe_runtime.sh');
    expect(dockerfile).toContain('RUN /bin/bash /tmp/packaged_pipe_runtime.sh && rm /tmp/packaged_pipe_runtime.sh');
    expect(dockerfile).toContain('RUN bun run build');
  }
  const build = JSON.parse(readFileSync(path.join(root, 'api/package.json'), 'utf8')).scripts.build;
  expect(build).toContain('src/pipe-process-smoke.ts --minify --target=bun --outfile=.build/pipe-process-smoke.js');
  const jail = readFileSync(path.join(root, 'api/config/sandbox.cfg'), 'utf8');
  expect(jail).toContain('keep_env: false');
  expect(jail).not.toContain('SANDBOX_PIPE_ADDON');
  expect(jail).not.toContain('SANDBOX_VM_CONTROL_TOKEN');
});
