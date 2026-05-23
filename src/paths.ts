import { exec } from '@actions/exec';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const NIX_CONF_PATH = '/etc/nix/nix.conf';
export const DAEMON_DROPIN_PATH = '/etc/systemd/system/nix-daemon.service.d/wispy.conf';

export interface RuntimePaths {
  dir: string;
  signingKey: string;
  hook: string;
  queue: string;
  status: string;
  pid: string;
  log: string;
  daemonEnv: string;
}

export function runtimeDir(): string {
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) throw new Error('RUNNER_TEMP is not set');
  return path.join(runnerTemp, 'wispy');
}

export function makeRuntimePaths(): RuntimePaths {
  const dir = runtimeDir();
  return {
    dir,
    signingKey: path.join(dir, 'signing.key'),
    hook: path.join(dir, 'hook.sh'),
    queue: path.join(dir, 'queue'),
    status: path.join(dir, 'status.json'),
    pid: path.join(dir, 'uploader.pid'),
    log: path.join(dir, 'uploader.log'),
    daemonEnv: path.join(dir, 'daemon-env'),
  };
}

/**
 * Write content to a system path that requires root (uses `sudo cp`).
 * Stages via a unique temp file in our runtime dir to avoid /tmp collisions
 * with parallel jobs and to keep the cleanup in one place.
 */
export async function writeSystemFileViaSudo(
  content: string,
  destPath: string,
  stagingDir: string,
): Promise<void> {
  const stage = path.join(stagingDir, `staged-${path.basename(destPath)}-${process.pid}`);
  fs.writeFileSync(stage, content);
  try {
    await exec('sudo', ['cp', stage, destPath]);
  } finally {
    if (fs.existsSync(stage)) fs.unlinkSync(stage);
  }
}
