import * as core from '@actions/core';
import { exec } from '@actions/exec';
import * as fs from 'node:fs';
import { removeWispyBlock } from './nixconf.js';
import {
  DAEMON_DROPIN_PATH,
  NIX_CONF_PATH,
  makeRuntimePaths,
} from './paths.js';
import { SENTINEL } from './queue.js';

const SHUTDOWN_GRACE_MS = 60_000;
const POLL_INTERVAL_MS = 250;

interface Status {
  pathsPushed: number;
  bytesPushed: number;
  pathsFailed: number;
  wallTimeMs: number;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

async function cleanupNixConf(): Promise<void> {
  if (!fs.existsSync(NIX_CONF_PATH)) return;
  const existing = fs.readFileSync(NIX_CONF_PATH, 'utf8');
  const cleaned = removeWispyBlock(existing);
  if (cleaned === existing) return;
  fs.writeFileSync('/tmp/wispy-nix.conf.cleaned', cleaned);
  await exec('sudo', ['cp', '/tmp/wispy-nix.conf.cleaned', NIX_CONF_PATH]);
  fs.unlinkSync('/tmp/wispy-nix.conf.cleaned');
}

async function cleanupDaemonDropin(): Promise<void> {
  // Remove the systemd drop-in that injected AWS creds into nix-daemon's
  // env, then reload + restart so the daemon no longer holds them.
  try {
    await exec('sudo', ['rm', '-f', DAEMON_DROPIN_PATH]);
    await exec('sudo', ['systemctl', 'daemon-reload']);
    await exec('sudo', ['systemctl', 'restart', 'nix-daemon']);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`wispy: failed to remove nix-daemon drop-in: ${msg}`);
  }
}

function shredSigningKey(keyPath: string): void {
  if (!fs.existsSync(keyPath)) return;
  try {
    const size = fs.statSync(keyPath).size;
    fs.writeFileSync(keyPath, Buffer.alloc(size, 0));
  } catch {
    // ignore — best-effort overwrite
  }
  fs.unlinkSync(keyPath);
}

function dumpUploaderLog(logPath: string): void {
  if (!fs.existsSync(logPath)) return;
  const content = fs.readFileSync(logPath, 'utf8');
  const tail = content.split('\n').slice(-50).join('\n');
  if (tail.trim()) {
    core.startGroup('wispy uploader log (last 50 lines)');
    core.info(tail);
    core.endGroup();
  }
}

async function run(): Promise<void> {
  const paths = makeRuntimePaths();

  let pid: number | null = null;
  if (fs.existsSync(paths.pid)) {
    pid = Number.parseInt(fs.readFileSync(paths.pid, 'utf8').trim(), 10);
    if (!Number.isInteger(pid)) pid = null;
  }

  if (pid !== null && fs.existsSync(paths.queue)) {
    fs.appendFileSync(paths.queue, `${SENTINEL}\n`);
    const exited = await waitForExit(pid, SHUTDOWN_GRACE_MS);
    if (!exited) {
      core.warning(`wispy uploader (pid=${pid}) did not exit within ${SHUTDOWN_GRACE_MS}ms`);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }

  if (fs.existsSync(paths.status)) {
    const parsed = JSON.parse(fs.readFileSync(paths.status, 'utf8')) as Status;
    core.setOutput('paths-pushed', parsed.pathsPushed);
    core.setOutput('bytes-pushed', parsed.bytesPushed);
    core.setOutput('paths-failed', parsed.pathsFailed);
    core.info(
      `wispy: pushed ${parsed.pathsPushed} paths (${parsed.bytesPushed} bytes), ` +
        `${parsed.pathsFailed} failed, in ${parsed.wallTimeMs}ms`,
    );
    if (parsed.pathsFailed > 0) {
      core.warning(`wispy: ${parsed.pathsFailed} paths failed to upload (see uploader log above)`);
    }
  } else if (pid !== null) {
    core.warning('wispy: uploader did not write status.json (likely crashed)');
    core.setOutput('paths-pushed', 0);
    core.setOutput('bytes-pushed', 0);
    core.setOutput('paths-failed', 0);
  }

  dumpUploaderLog(paths.log);
  shredSigningKey(paths.signingKey);
  await cleanupNixConf();
  await cleanupDaemonDropin();
}

run().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  core.warning(`wispy post step error: ${msg}`);
});
