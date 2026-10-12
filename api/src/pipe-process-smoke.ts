import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { spawnPipeProcess } from './pipe-process';

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

async function main(): Promise<void> {
  if (process.argv[2] === '--child') {
    for (const fd of [0, 1, 2]) assert.ok(fs.fstatSync(fd).isFIFO(), `fd ${fd} must be a pipe`);
    // The trusted parent must not copy its runtime configuration into a child.
    for (const key of ['SANDBOX_PIPE_ADDON', 'SANDBOX_VM_CONTROL_TOKEN', 'SANDBOX_EXECUTION_MANIFEST_PUBLIC_KEY']) {
      assert.equal(process.env[key], undefined, `${key} leaked into the smoke child`);
    }
    fs.writeSync(1, fs.readFileSync(0));
    fs.writeSync(2, 'pipe-stderr');
    return;
  }
  const child = spawnPipeProcess(process.execPath, [process.argv[1], '--child'], { env: { PATH: '/usr/bin:/bin' } });
  const closed = once(child, 'close');
  const output = collect(child.stdout);
  const errors = collect(child.stderr);
  child.stdin.end('packaged-pipe-ok');
  const [code] = await closed;
  assert.equal(code, 0, await errors);
  assert.equal(await output, 'packaged-pipe-ok');
  assert.equal(await errors, 'pipe-stderr');
  console.log('Packaged API anonymous pipes ready');
}

void main().catch(error => {
  console.error('Anonymous-pipe runtime check failed:', error);
  process.exitCode = 1;
});
