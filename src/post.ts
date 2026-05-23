import * as core from '@actions/core';
import * as fs from 'node:fs';
import * as path from 'node:path';

function shred(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  try {
    const size = fs.statSync(filePath).size;
    fs.writeFileSync(filePath, Buffer.alloc(size, 0));
  } catch {
    // best-effort
  }
  fs.unlinkSync(filePath);
}

async function run(): Promise<void> {
  const t = process.env.RUNNER_TEMP;
  if (!t) return;
  const dir = path.join(t, 'wispy');
  if (!fs.existsSync(dir)) return;

  // The netrc holds the bearer token. Zero it before deletion.
  shred(path.join(dir, 'netrc'));

  // RUNNER_TEMP is cleaned by the runner; nothing else to do.
  core.info('wispy: cleaned up netrc');
}

run().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  core.warning(`wispy post step error: ${msg}`);
});
