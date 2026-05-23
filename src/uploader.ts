import * as fs from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseUploaderEnv, writeStatus, type Status } from './contract.js';
import { QueueParser } from './queue.js';

const exec = promisify(execFile);

async function copyPath(destUrl: string, path: string): Promise<number> {
  // `nix copy --to <url> <path>` uploads the path's signed NAR + narinfo.
  // Stderr contains progress; we don't parse it for byte counts in v1.
  // Returns 0 for bytes (we don't know without a separate `nix path-info -s`).
  await exec('nix', ['copy', '--to', destUrl, path], { maxBuffer: 64 * 1024 * 1024 });
  return 0;
}

async function pathSize(path: string): Promise<number> {
  try {
    const { stdout } = await exec('nix', ['path-info', '--json', '-s', path], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed: unknown = JSON.parse(stdout);
    if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object') {
      const obj = parsed[0] as Record<string, unknown>;
      const v = obj.narSize;
      if (typeof v === 'number') return v;
    } else if (parsed && typeof parsed === 'object') {
      const entries = Object.values(parsed as Record<string, unknown>);
      const first = entries[0];
      if (first && typeof first === 'object') {
        const v = (first as Record<string, unknown>).narSize;
        if (typeof v === 'number') return v;
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

class WorkPool {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

async function main(): Promise<void> {
  const env = parseUploaderEnv(process.env);
  const started = Date.now();
  const parser = new QueueParser();
  const pool = new WorkPool(env.concurrency);
  const status: Status = { pathsPushed: 0, bytesPushed: 0, pathsFailed: 0, wallTimeMs: 0 };
  const inflight: Array<Promise<void>> = [];
  let offset = 0;
  let sentinelSeen = false;

  // Ensure queue file exists so we can open it.
  await fs.promises.writeFile(env.queueFile, '', { flag: 'a' });

  while (!sentinelSeen) {
    const st = await stat(env.queueFile).catch(() => null);
    if (st && st.size > offset) {
      const fd = await open(env.queueFile, 'r');
      try {
        const len = st.size - offset;
        const buf = Buffer.alloc(len);
        await fd.read(buf, 0, len, offset);
        offset = st.size;
        const result = parser.feed(buf.toString('utf8'));
        if (result.sentinelSeen) sentinelSeen = true;
        for (const path of result.paths) {
          inflight.push(
            pool.run(async () => {
              try {
                await copyPath(env.destUrl, path);
                const bytes = await pathSize(path);
                status.pathsPushed++;
                status.bytesPushed += bytes;
                console.error(`uploaded ${path} (${bytes} bytes)`);
              } catch (err) {
                status.pathsFailed++;
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`WARN: failed to push ${path}: ${msg}`);
              }
            }),
          );
        }
      } finally {
        await fd.close();
      }
    } else {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  await Promise.all(inflight);
  status.wallTimeMs = Date.now() - started;
  writeStatus(env.statusFile, status);
}

main().catch((err) => {
  console.error(`uploader fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
