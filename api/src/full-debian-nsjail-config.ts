import fs from 'node:fs';

const WRITABLE_SYSTEM_DESTINATION = /\bdst:\s*"\/(?:usr|etc|var)(?:\/|")/;
const FULL_DEBIAN_VISIBLE_PROC_DESTINATIONS = new Set([
  '/proc/cpuinfo',
  '/proc/meminfo',
  '/proc/uptime',
  '/proc/loadavg',
  '/proc/stat',
]);

export function renderFullDebianNsJailConfig(baseConfig: string): string {
  const lines = baseConfig.match(/.*(?:\n|$)/g) ?? [];
  const output: string[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trimStart().startsWith('mount {')) {
      output.push(line.replace(/^iface_no_lo:[ \t]*true/, 'iface_no_lo: false'));
      index += 1;
      continue;
    }

    const block = [line];
    index += 1;
    while (!block.at(-1)?.trimEnd().endsWith('}') && index < lines.length) {
      block.push(lines[index]);
      index += 1;
    }
    const text = block.join('');
    const destination = text.match(/\bdst:\s*"([^"]+)"/)?.[1];
    const renderedText = destination === '/tmp'
      ? text.replace(/^[ \t]*noexec:[ \t]*true[ \t]*$/m, '    noexec: false')
      : text;
    if (
      !WRITABLE_SYSTEM_DESTINATION.test(text)
      && !FULL_DEBIAN_VISIBLE_PROC_DESTINATIONS.has(destination ?? '')
    ) {
      output.push(renderedText);
    }
  }

  return output.join('');
}

if (import.meta.main) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    throw new Error('usage: full-debian-nsjail-config.ts INPUT OUTPUT');
  }
  fs.writeFileSync(outputPath, renderFullDebianNsJailConfig(fs.readFileSync(inputPath, 'utf8')), { mode: 0o600 });
}